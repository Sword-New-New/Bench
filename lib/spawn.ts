import { execFile } from "node:child_process"
import { randomBytes, randomUUID } from "node:crypto"
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"

import { ApiError } from "@/lib/http"
import { KINDS } from "@/lib/kinds"
import { agentState, sayAs, seatCreated, snapshot } from "@/lib/store"

// 「开新会话」: the room creates a session of an agent kind itself, seats it
// and, if given a task, hands it over. The session only comes into being on
// its first wake (the wake script creates it under the id picked here), in
// the folder picked here: the same one as a seat, a new git worktree, or a
// path you type.

const run = promisify(execFile)

// Kinds the room knows how to create a session for, headless and by an id it
// picks (`spawn` in lib/kinds.ts). Others are seated by opening them yourself.
export const SPAWNABLE = KINDS.filter((kind) => kind.spawn).map((kind) => kind.id)

export type Workspace = { label: string; path: string; git: boolean }

function isDir(dir: string) {
  try {
    return statSync(dir).isDirectory()
  } catch {
    return false
  }
}

async function gitTop(dir: string) {
  try {
    const { stdout } = await run("git", ["-C", dir, "rev-parse", "--show-toplevel"], { timeout: 5000 })
    return stdout.trim() || null
  } catch {
    return null
  }
}

// The folder a Claude Code session works in, from the cwd its transcript records.
function claudeDir(session: string) {
  const root = path.join(os.homedir(), ".claude", "projects")
  let folders: string[] = []
  try {
    folders = readdirSync(root)
  } catch {
    return null
  }
  for (const folder of folders) {
    const file = path.join(root, folder, `${session}.jsonl`)
    try {
      const found = readFileSync(file, "utf8").slice(0, 200_000).match(/"cwd":"([^"]+)"/)
      if (found) return JSON.parse(`"${found[1]}"`) as string
    } catch {}
  }
  return null
}

// Where a seat works, when the room can tell.
function seatDir(agentId: string) {
  const agent = agentState(agentId)
  if (!agent) return null
  if (agent.workdir) return agent.workdir
  if (agent.agentName === "claude" && agent.session) return claudeDir(agent.session)
  return null
}

// The folders the dialog offers: where each seat works, and the room's own.
export async function workspaces() {
  const seen = new Map<string, Workspace>()
  for (const agent of snapshot().agents) {
    const dir = seatDir(agent.id)
    if (!dir || !isDir(dir)) continue
    const known = seen.get(dir)
    if (known) known.label += `、${agent.name}`
    else seen.set(dir, { label: agent.name, path: dir, git: false })
  }
  const room = process.cwd()
  if (!seen.has(room)) seen.set(room, { label: "房间所在目录", path: room, git: false })
  const list = [...seen.values()]
  await Promise.all(list.map(async (item) => (item.git = (await gitTop(item.path)) !== null)))
  return list
}

function slug(name: string) {
  const ascii = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
  return `${ascii || "seat"}-${randomBytes(2).toString("hex")}`
}

// A new worktree of the repository `base` is in, next to it, on its own branch.
async function newWorktree(base: string, name: string) {
  const top = await gitTop(base)
  if (!top) throw new ApiError(400, `${base} 不在 git 仓库里，没法开 worktree`)
  const tag = slug(name)
  const dir = path.join(path.dirname(top), `${path.basename(top)}-${tag}`)
  const branch = `bench/${tag}`
  try {
    await run("git", ["-C", top, "worktree", "add", "-b", branch, dir, "HEAD"], { timeout: 30_000 })
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim()
    throw new ApiError(500, `开 worktree 没成功：${stderr || (error as Error).message}`)
  }
  return { dir, branch }
}

// Hand the new session's bench tools its seat, the way bench_join would have,
// so it doesn't have to join again (see the state files in bench-mcp.mjs).
function giveSeat(kind: string, session: string, seat: { agentId: string; token: string; name: string }) {
  const dir = path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "bench-mcp")
  mkdirSync(dir, { recursive: true })
  const body = JSON.stringify({ ...seat, cursor: snapshot().seq })
  writeFileSync(path.join(dir, `${kind}-${session}.json`), body, { mode: 0o600 })
  writeFileSync(path.join(dir, `${kind}-name-${Buffer.from(seat.name).toString("hex")}.json`), body, { mode: 0o600 })
}

function asText(value: unknown, max: number) {
  return typeof value === "string" ? value.trim().slice(0, max) : ""
}

export async function spawnSession(input: Record<string, unknown>) {
  const kind = KINDS.find((item) => item.id === input.kind)
  if (!kind || !SPAWNABLE.includes(kind.id)) throw new ApiError(400, "这一家还不能由房间开新会话")
  const name = asText(input.name, 24)
  if (!name) throw new ApiError(400, "给新会话起个名字")
  const role = asText(input.role, 24) || "新会话"
  const task = asText(input.task, 4000)

  const where = input.workspace && typeof input.workspace === "object" ? (input.workspace as Record<string, unknown>) : {}
  const from = asText(where.path, 1000)
  if (!from || !path.isAbsolute(from)) throw new ApiError(400, "工作目录要填完整路径，比如 /home/you/project")
  const base = path.resolve(from.replace(/^~(?=\/|$)/, os.homedir()))
  if (!isDir(base)) throw new ApiError(400, `${base} 不存在或不是目录`)
  if (snapshot().agents.some((agent) => agent.name === name)) throw new ApiError(409, `已经有人叫 ${name}，换个名字`)

  let dir = base
  let branch: string | undefined
  if (where.mode === "worktree") ({ dir, branch } = await newWorktree(base, name))

  const session = randomUUID()
  const seat = seatCreated({ name, role, model: "Claude Code", agentName: kind.id, session, workdir: dir })
  giveSeat(kind.id, session, { agentId: seat.agent.id, token: seat.token, name })
  // A task is said in the room, so everyone sees what the new seat is for, and
  // it is what wakes the seat for the first time.
  if (task) sayAs({ type: "human", id: "human", name: "jinbao" }, { text: `@${name} ${task}` })
  return { agent: seat.agent, dir, branch }
}
