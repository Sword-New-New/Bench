import { execFile } from "node:child_process"
import { randomBytes, randomUUID } from "node:crypto"
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"

import { adapterFor, installed, modelOf, summonPath } from "@/lib/adapters"
import { checkPct, checkWindow, CONTEXT_KINDS } from "@/lib/context"
import { cliCommand, dataHome } from "@/lib/platform"
import { checkEffort, checkPick, dshFlags } from "@/lib/models"
import { ApiError } from "@/lib/http"
import { KINDS } from "@/lib/kinds"
import {
  agentState,
  currentProjectInfo,
  rebindAgent,
  restoreAgentBinding,
  sayAs,
  seatCreated,
  seatCredentials,
  snapshot,
  userName,
} from "@/lib/store"
import { isSeatBusy, resumeLimitedAfterRebind } from "@/lib/summon"

// 「开新会话」: the room creates a session of an agent kind itself, seats it
// and, if given a task, hands it over, in the folder picked here: the same
// one as a seat, a new git worktree, a path you type, or a scratch folder
// made for it (newScratch). A Claude session only
// comes into being on its first wake (the wake script creates it under the id
// picked here); dsh-agent and agy can't take an id, so a DeepSeek or an
// Antigravity one is made right away (newDshSession, newAgySession), and so is
// a Codex one, whose thread id Codex picks too (newCodexSession). CodeBuddy
// and WorkBuddy take the room's id, but their wakes resume from the session's
// file, so theirs is made right away too (newBuddySession).

const execFileAsync = promisify(execFile)

// Commands run with the PATH wakes get (summonPath): the room's own may lack
// ~/.local/bin, where cursor-agent and agy live, when it was started from the
// desktop icon rather than a shell.
// On Windows through Git Bash, which also finds an npm CLI's shell shim
// (lib/platform.ts cliCommand).
const run: typeof execFileAsync = ((file: string, args: string[], options: Record<string, unknown> = {}) => {
  const [program, programArgs] = cliCommand(file, args)
  return execFileAsync(program, programArgs, {
    ...options,
    windowsHide: true,
    env: { ...((options.env as NodeJS.ProcessEnv) ?? process.env), PATH: summonPath() },
  })
}) as typeof execFileAsync

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

function isFile(file: string) {
  try {
    return statSync(file).isFile()
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
export function seatDir(agentId: string) {
  const agent = agentState(agentId)
  if (!agent) return null
  if (agent.workdir) return agent.workdir
  if (agent.agentName === "claude" && agent.session) return claudeDir(agent.session)
  return null
}

// The folders the dialog offers: the project's own folder first, then where
// each of its seats works, and the room's own.
export async function workspaces() {
  const seen = new Map<string, Workspace>()
  const project = currentProjectInfo()
  if (project.dir && isDir(project.dir)) seen.set(project.dir, { label: `项目目录`, path: project.dir, git: false })
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

// 「临时目录」: an empty folder of the session's own, outside the project (and
// outside this repository, so git in it finds nothing to touch). Kept after
// the seat leaves; the user clears it.
export function scratchRoot() {
  return path.join(dataHome(), "bench", "scratch")
}

function newScratch(name: string) {
  // Keeps Chinese in the name (slug() would turn it into "seat").
  const label = name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "") || "seat"
  const dir = path.join(scratchRoot(), `${label}-${randomBytes(2).toString("hex")}`)
  mkdirSync(dir, { recursive: true })
  return dir
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
function giveSeat(
  kind: string,
  session: string,
  seat: { agentId: string; token: string; name: string; project: string },
  purgeOldForAgent = false,
) {
  const dir = path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "bench-mcp")
  mkdirSync(dir, { recursive: true })
  if (purgeOldForAgent) {
    try {
      for (const file of readdirSync(dir)) {
        if (!file.endsWith(".json")) continue
        const full = path.join(dir, file)
        try {
          const parsed = JSON.parse(readFileSync(full, "utf8")) as { agentId?: string }
          if (parsed?.agentId === seat.agentId) rmSync(full, { force: true })
        } catch {}
      }
    } catch {}
  }
  const body = JSON.stringify({ ...seat, cursor: snapshot().seq })
  writeFileSync(path.join(dir, `${kind}-${session}.json`), body, { mode: 0o600 })
  writeFileSync(path.join(dir, `${kind}-name-${Buffer.from(`${seat.project}/${seat.name}`).toString("hex")}.json`), body, { mode: 0o600 })
}

// dsh-agent picks the session id itself: run a short first turn in the
// folder and read the id from its JSON events. Only sessions made by
// `dsh-agent exec` can be resumed by a wake later.
async function newDshSession(dir: string, seat: { name: string; role: string; project: string }, pick: string | null) {
  if (!installed("dsh-agent")) throw new ApiError(501, "没找到 dsh-agent，先装 DeepSeek Harness 的命令行")
  const intro =
    `这是并坐房间为你开的会话：你在「${seat.project}」项目里的席位叫 ${seat.name}，分工是 ${seat.role}。` +
    "房间已经替你入座，不用调用 bench_join。之后有人 @你，房间会把消息转给你，用 bench_say 回复。现在只回一个字：好"
  let stdout = ""
  try {
    ;({ stdout } = await run("dsh-agent", ["exec", "--json", ...(pick ? dshFlags(pick) : []), "--timeout", "120", "-C", dir, intro], {
      cwd: dir,
      timeout: 150_000,
      maxBuffer: 16 * 1024 * 1024,
    }))
  } catch (error) {
    const err = error as { stderr?: string; stdout?: string; message?: string }
    stdout = err.stdout ?? ""
    if (!stdout.includes("thread.started")) {
      const why = (err.stderr || err.message || "").trim().split("\n").slice(-1)[0]
      throw new ApiError(500, `dsh-agent 没开出会话：${why.slice(0, 300)}`)
    }
  }
  for (const line of stdout.split("\n")) {
    try {
      const event = JSON.parse(line)
      if (event?.type === "thread.started" && typeof event.session_id === "string") return event.session_id as string
    } catch {
      // progress lines that aren't JSON
    }
  }
  throw new ApiError(500, "dsh-agent 跑完了，但没报出会话 id")
}

// agy also picks the conversation id itself: one short first turn in the
// folder (print mode, JSON out) and its conversation_id is the seat's. Run on
// the same quick model the wake command uses unless the user picked another,
// with the room's tools allowed, as a wake does.
async function newAgySession(dir: string, seat: { name: string; role: string; project: string }, pick: string | null) {
  if (!installed("agy")) throw new ApiError(501, "没找到 agy，先装 Antigravity 的命令行")
  const intro =
    `这是并坐房间为你开的会话：你在「${seat.project}」项目里的席位叫 ${seat.name}，分工是 ${seat.role}。` +
    "房间已经替你入座，不用调用 bench_join。之后有人 @你，房间会把消息转给你，你的回答会贴回房间。现在只回一个字：好"
  const settings = JSON.stringify({ permissions: { allow: ["mcp(bench/*)"] } })
  let stdout = ""
  try {
    ;({ stdout } = await run(
      "agy",
      ["--model", pick ?? "gemini-3.8-flash-low", "--settings", settings, "--output-format", "json", "-p", intro],
      { cwd: dir, timeout: 180_000, maxBuffer: 16 * 1024 * 1024 },
    ))
  } catch (error) {
    const err = error as { stderr?: string; stdout?: string; message?: string }
    stdout = err.stdout ?? ""
    if (!stdout.includes("conversation_id")) {
      const why = (err.stderr || err.message || "").trim().split("\n").slice(-1)[0]
      throw new ApiError(500, `agy 没开出会话：${why.slice(0, 300)}`)
    }
  }
  const id = stdout.match(/"conversation_id"\s*:\s*"([\w-]+)"/)?.[1]
  if (!id) throw new ApiError(500, "agy 跑完了，但没报出会话 id")
  return id
}

// cursor-agent makes an empty chat and prints its id; the wake command points
// it at the seat's folder (--workspace "$BENCH_NEW_DIR", lib/kinds.ts).
async function newCursorSession(dir: string) {
  if (!installed("cursor-agent")) throw new ApiError(501, "没找到 cursor-agent，先装 Cursor 的命令行")
  try {
    const { stdout } = await run("cursor-agent", ["create-chat"], { cwd: dir, timeout: 60_000 })
    const id = stdout.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/)?.[0]
    if (!id) throw new ApiError(500, `cursor-agent 没报出会话 id：${stdout.trim().slice(0, 200)}`)
    return id
  } catch (error) {
    if (error instanceof ApiError) throw error
    const err = error as { stderr?: string; message?: string }
    const why = (err.stderr || err.message || "").trim().split("\n").slice(-1)[0]
    throw new ApiError(500, `cursor-agent 没开出会话：${why.slice(0, 300)}`)
  }
}

// Codex picks the thread id itself: one short first turn with `codex exec
// --json` in the folder, and its thread.started event names the thread. The
// bench tools are pre-approved as in codex-wake.sh.
async function newCodexSession(dir: string, seat: { name: string; role: string; project: string }, pick: string | null) {
  const bundled = "/usr/lib/chatgpt/resources/codex"
  const bin = installed("codex") ? "codex" : isFile(bundled) ? bundled : null
  if (!bin) throw new ApiError(501, "没找到 codex，先装 Codex 的命令行或桌面端")
  const intro =
    `这是并坐房间为你开的会话：你在「${seat.project}」项目里的席位叫 ${seat.name}，分工是 ${seat.role}。` +
    "房间已经替你入座，不用调用 bench_join。之后有人 @你，房间会把消息转给你，你的回答会贴回房间。现在只回一个字：好"
  const args = ["exec", "--skip-git-repo-check", "--json", ...(pick ? ["-m", pick] : [])]
  let stdout = ""
  try {
    const turn = run(bin, [...args, "-c", 'mcp_servers.bench.default_tools_approval_mode="approve"', "-C", dir, intro], {
      cwd: dir,
      timeout: 180_000,
      maxBuffer: 16 * 1024 * 1024,
    })
    // codex exec reads more of the prompt from a stdin that isn't a terminal.
    turn.child.stdin?.end()
    ;({ stdout } = await turn)
  } catch (error) {
    const err = error as { stderr?: string; stdout?: string; message?: string }
    stdout = err.stdout ?? ""
    if (!stdout.includes("thread.started")) {
      const why = (err.stderr || err.message || "").trim().split("\n").slice(-1)[0]
      throw new ApiError(500, `codex 没开出会话：${why.slice(0, 300)}`)
    }
  }
  let id: string | undefined
  for (const line of stdout.split("\n")) {
    try {
      const event = JSON.parse(line)
      if (event?.type === "thread.started" && typeof event.thread_id === "string") id = event.thread_id
      if (event?.type === "turn.failed") {
        // The provider's error is often JSON itself: show its message.
        const raw = String(event.error?.message ?? "")
        let why = raw
        try {
          why = JSON.parse(raw)?.error?.message ?? raw
        } catch {}
        throw new ApiError(500, `codex 没开出会话：${why.slice(0, 300)}`)
      }
    } catch (error) {
      if (error instanceof ApiError) throw error
      // log lines that aren't JSON
    }
  }
  if (!id) throw new ApiError(500, "codex 跑完了，但没报出会话 id")
  return id
}

// CodeBuddy and WorkBuddy (the same CLI) take the id the room picks, but a
// wake (resume-here.sh) finds the session by its file, so run the first turn
// now. WorkBuddy's sessions live in ~/.workbuddy; the full codebuddy CLI is
// used when there is one, since the copy inside WorkBuddy has no login of its
// own (see workbuddy-wake.sh).
async function newBuddySession(
  kind: "codebuddy" | "workbuddy",
  dir: string,
  seat: { name: string; role: string; project: string },
  pick: string | null,
) {
  const bundled = "/opt/apps/com.tencent.workbuddy/files/resources/app.asar.unpacked/cli/bin/codebuddy"
  const bin = installed("codebuddy") ? "codebuddy" : kind === "workbuddy" && isFile(bundled) ? bundled : null
  if (!bin) throw new ApiError(501, "没找到 codebuddy，先装 CodeBuddy Code 的命令行（npm i -g @tencent-ai/codebuddy-code）")
  const session = randomUUID()
  const intro =
    `这是并坐房间为你开的会话：你在「${seat.project}」项目里的席位叫 ${seat.name}，分工是 ${seat.role}。` +
    "房间已经替你入座，不用调用 bench_join。之后有人 @你，房间会把消息转给你，你的回答会贴回房间。现在只回一个字：好"
  const env = kind === "workbuddy" ? { ...process.env, CODEBUDDY_CONFIG_DIR: path.join(os.homedir(), ".workbuddy") } : process.env
  const args = ["--session-id", session, ...(pick ? ["--model", pick] : [])]
  try {
    await run(bin, [...args, "--allowedTools", "mcp__bench", "--output-format", "text", "-p", intro], {
      cwd: dir,
      env,
      timeout: 150_000,
      maxBuffer: 16 * 1024 * 1024,
    })
  } catch (error) {
    const err = error as { stderr?: string; stdout?: string; message?: string }
    const why = (err.stderr || err.stdout || err.message || "").trim().split("\n").slice(-1)[0]
    const login = /Authentication required|\/login/i.test(why) ? "（命令行没登录：在终端运行 codebuddy，/login 一次）" : ""
    throw new ApiError(500, `codebuddy 没开出会话${login}：${why.slice(0, 300)}`)
  }
  return session
}

// Renamed from the page: the seat's bench tools keep its name in their state
// files, and a name file under the old name. Point them at the new one.
export function renameSeatFiles(agentId: string, project: string, name: string) {
  const dir = path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "bench-mcp")
  let files: string[]
  try {
    files = readdirSync(dir).filter((file) => file.endsWith(".json"))
  } catch {
    return
  }
  const kinds = new Set<string>()
  let body: Record<string, unknown> | undefined
  for (const file of files) {
    const full = path.join(dir, file)
    let seat: Record<string, unknown>
    try {
      seat = JSON.parse(readFileSync(full, "utf8"))
    } catch {
      continue
    }
    if (seat.agentId !== agentId) continue
    body = { ...seat, name }
    const named = /^(.+)-name-[0-9a-f]+\.json$/.exec(file)
    if (named) {
      kinds.add(named[1])
      rmSync(full, { force: true })
    } else writeFileSync(full, JSON.stringify(body), { mode: 0o600 })
  }
  if (!body) return
  for (const kind of kinds) {
    writeFileSync(path.join(dir, `${kind}-name-${Buffer.from(`${project}/${name}`).toString("hex")}.json`), JSON.stringify(body), { mode: 0o600 })
  }
}

function asText(value: unknown, max: number) {
  return typeof value === "string" ? value.trim().slice(0, max) : ""
}

async function createClientSession(
  kindId: string,
  dir: string,
  about: { name: string; role: string; project: string },
  pick: string | null,
) {
  if (kindId === "dsh") return newDshSession(dir, about, pick)
  if (kindId === "antigravity") return newAgySession(dir, about, pick)
  if (kindId === "codex") return newCodexSession(dir, about, pick)
  if (kindId === "cursor") return newCursorSession(dir)
  if (kindId === "codebuddy" || kindId === "workbuddy") return newBuddySession(kindId, dir, about, pick)
  return randomUUID()
}

export async function spawnSession(input: Record<string, unknown>) {
  const kind = KINDS.find((item) => item.id === input.kind)
  if (!kind || !SPAWNABLE.includes(kind.id)) throw new ApiError(400, "这一家还不能由房间开新会话")
  const name = asText(input.name, 24)
  if (!name) throw new ApiError(400, "给新会话起个名字")
  const role = asText(input.role, 24) || "新会话"
  const pick = checkPick(input.model)
  const effort = checkEffort(kind.id, input.effort)
  const window = CONTEXT_KINDS.includes(kind.id) ? checkWindow(input.window) : undefined
  const compactPct = CONTEXT_KINDS.includes(kind.id) ? checkPct(input.compactPct) : undefined
  const task = asText(input.task, 4000)

  const where = input.workspace && typeof input.workspace === "object" ? (input.workspace as Record<string, unknown>) : {}
  const temp = where.mode === "temp"
  const from = temp ? "" : asText(where.path, 1000)
  if (!temp && (!from || !path.isAbsolute(from))) throw new ApiError(400, "工作目录要填完整路径，比如 /home/you/project 或 C:\\work\\project")
  const base = temp ? "" : path.resolve(from.replace(/^~(?=\/|$)/, os.homedir()))
  if (!temp && !isDir(base)) throw new ApiError(400, `${base} 不存在或不是目录`)
  if (snapshot().agents.some((agent) => agent.name === name)) throw new ApiError(409, `已经有人叫 ${name}，换个名字`)

  let dir = base
  let branch: string | undefined
  if (temp) dir = newScratch(name)
  else if (where.mode === "worktree") ({ dir, branch } = await newWorktree(base, name))

  const project = currentProjectInfo()
  const about = { name, role, project: project.name }
  const session = await createClientSession(kind.id, dir, about, pick)
  // Someone may have taken the name while the session was being made.
  if (snapshot().agents.some((agent) => agent.name === name)) throw new ApiError(409, `已经有人叫 ${name}，换个名字`)
  const adapter = adapterFor(kind.id)
  const model = pick ?? (kind.id === "claude" ? "Claude Code" : ((adapter && modelOf(adapter)) ?? kind.harness))
  const seat = seatCreated({
    name,
    role,
    model,
    modelPick: pick,
    effortPick: effort,
    windowPick: window,
    compactPct,
    agentName: kind.id,
    session,
    workdir: dir,
    autoFull: input.autoFull === true,
  })
  giveSeat(kind.id, session, { agentId: seat.agent.id, token: seat.token, name, project: project.id })
  // A task is said in the room, so everyone sees what the new seat is for, and
  // it is what wakes the seat for the first time.
  if (task) sayAs({ type: "human", id: "human", name: userName() }, { text: `@${name} ${task}` })
  return { agent: seat.agent, dir, branch }
}

// Rebind an existing seat onto another AI vendor/client (e.g. Claude hit usage
// limit -> Codex or Gemini steps in) while preserving seat id, tasks, persona
// and long-term memory, and rotating the seat token so the old session cannot
// reclaim or speak as the seat.
export async function rebindSession(agentId: string, input: Record<string, unknown>) {
  const creds = seatCredentials(agentId)
  if (isSeatBusy(agentId)) {
    throw new ApiError(409, `${creds.name} 正在跑一轮，先停下或等这一轮结束再切换客户端`)
  }
  const kindId = asText(input.kind, 24)
  if (!kindId) throw new ApiError(400, "请选择要切换到的客户端类型")
  const knownKind = KINDS.find((item) => item.id === kindId)
  const customAdapter = adapterFor(kindId)
  const explicitSession = asText(input.session, 128)
  if (!knownKind?.spawn && !customAdapter && !explicitSession) {
    throw new ApiError(400, `${kindId} 不能由房间自动开新会话，也未配置自定义唤起适配器`)
  }

  const pick = checkPick(input.model)
  const effort = checkEffort(kindId, input.effort)
  const fromRunId = asText(input.fromRunId, 64) || undefined
  const task = asText(input.task, 4000)

  const project = currentProjectInfo()
  const rawDir = asText(input.workdir, 1000)
  let dir = rawDir ? path.resolve(rawDir.replace(/^~(?=\/|$)/, os.homedir())) : (seatDir(agentId) ?? project.dir ?? process.cwd())
  if (!isDir(dir)) {
    if (rawDir) throw new ApiError(400, `${dir} 不存在或不是目录`)
    dir = process.cwd()
  }

  const about = { name: creds.name, role: creds.role, project: project.name }
  const session = explicitSession
    ? explicitSession
    : knownKind?.spawn
      ? await createClientSession(kindId, dir, about, pick)
      : randomUUID()

  if (isSeatBusy(agentId)) {
    throw new ApiError(409, `${creds.name} 正在跑一轮，先停下或等这一轮结束再切换客户端`)
  }

  const adapter = adapterFor(kindId)
  const model =
    pick ??
    (kindId === "claude"
      ? "Claude Code"
      : ((adapter && modelOf(adapter)) ?? knownKind?.harness ?? kindId))

  const updated = rebindAgent(agentId, {
    agentName: kindId,
    session,
    model,
    modelPick: pick,
    effortPick: effort,
    workdir: dir,
    fromRunId,
  })
  giveSeat(kindId, session, { agentId: creds.id, token: updated.token, name: updated.agent.name, project: project.id }, true)

  let resumed = false
  if (fromRunId) {
    const r = resumeLimitedAfterRebind(fromRunId, `${knownKind?.label ?? kindId}（${model}）`)
    resumed = Boolean(r.started)
  } else if (task) {
    sayAs({ type: "human", id: "human", name: userName() }, { text: `@${updated.agent.name} ${task}` })
    resumed = true
  }

  return { agent: updated.agent, dir, resumed }
}

// Switch a seat back to one of its previous `<agentName, session>` bindings
// (e.g. after the original vendor's quota has reset).
export function switchBackBinding(agentId: string, index: number) {
  const creds = seatCredentials(agentId)
  if (isSeatBusy(agentId)) {
    throw new ApiError(409, `${creds.name} 正在跑一轮，先停下或等这一轮结束再切回原会话`)
  }
  const project = currentProjectInfo()
  const { agent, restored, token } = restoreAgentBinding(agentId, index)
  giveSeat(
    restored.agentName,
    restored.session,
    {
      agentId: creds.id,
      token,
      name: agent.name,
      project: project.id,
    },
    true,
  )
  return { agent, restored: { agentName: restored.agentName, model: restored.model } }
}
