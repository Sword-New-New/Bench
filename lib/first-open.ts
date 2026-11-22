import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import { bundledCodex, installed } from "@/lib/adapters"
import { folderNameOf } from "@/lib/first-name"
import { ApiError, asRecord, asString } from "@/lib/http"
import { kindById } from "@/lib/kinds"
import { register } from "@/lib/register"
import { spawnSession } from "@/lib/spawn"
import { inProject, listProjects, removeAgent, snapshot, updateProject } from "@/lib/store"

// 「第一次打开」 (t_594f3118): a room nobody has sat in or spoken in yet asks
// one thing, what the user wants done, and sets everything else up itself:
// which AI does it (the first of FIRST_ORDER installed here), where (a new
// folder on the desktop named after the request), the project, the seat, and
// the request as the user's first message calling it. The full page and its
// dialogs stay behind 「更多设置」.

// Who does it, in the order the user would want them.
const FIRST_ORDER = ["claude", "codex", "antigravity", "dsh", "cursor"]

// The client's own command line, which is what "installed" means here (a
// kind's wake command can be one of our scripts, always present).
const CLIENT_BINS: Record<string, string[]> = {
  claude: ["claude"],
  codex: ["codex", "/usr/lib/chatgpt/resources/codex"],
  antigravity: ["agy"],
  dsh: ["dsh-agent"],
  cursor: ["cursor-agent"],
}

// Where each one keeps its MCP servers (scripts/register-mcp.sh writes them).
function configOf(kind: string) {
  const home = os.homedir()
  const files: Record<string, string> = {
    claude: path.join(home, ".claude.json"),
    codex: path.join(process.env.CODEX_HOME || path.join(home, ".codex"), "config.toml"),
    antigravity: path.join(home, ".gemini", "antigravity", "mcp_config.json"),
    dsh: path.join(process.env.DSH_HOME || path.join(home, ".dsh"), "profiles", "headless", "cordis.patch.yml"),
    cursor: path.join(home, ".cursor", "mcp.json"),
  }
  return files[kind]
}

// The easiest one to install when there is none.
const INSTALL_HINT = {
  label: "Claude",
  text: "在终端运行 npm install -g @anthropic-ai/claude-code，装好后运行一次 claude 登录",
  url: "https://docs.claude.com/en/docs/claude-code/setup",
}

function isDir(dir: string) {
  try {
    return statSync(dir).isDirectory()
  } catch {
    return false
  }
}

function clientInstalled(kind: string) {
  if (kind === "claude") {
    // The desktop app's bundled CLI, as register-mcp.sh finds it.
    const bundled = path.join(os.homedir(), ".config", "Claude", "claude-code")
    try {
      if (readdirSync(bundled).length > 0) return true
    } catch {}
  }
  if (kind === "codex" && bundledCodex()) return true
  return (CLIENT_BINS[kind] ?? []).some((bin) => (bin.startsWith("/") ? existsSync(bin) : installed(bin)))
}

// Which of FIRST_ORDER are here. BENCH_FIRST_KINDS ("claude,dsh", or "none")
// stands in for the machine in tests; it also keeps tests from touching the
// clients' real configs (connect() below).
function installedKinds() {
  const fake = process.env.BENCH_FIRST_KINDS
  if (fake !== undefined) {
    const list = fake.split(",").map((item) => item.trim())
    return FIRST_ORDER.filter((kind) => list.includes(kind))
  }
  return FIRST_ORDER.filter(clientInstalled)
}

// The desktop if there is one, else ~/并坐 (BENCH_FIRST_PARENT in tests).
function defaultParent(): { dir: string; label: string } {
  const fake = process.env.BENCH_FIRST_PARENT
  if (fake) return { dir: fake, label: "桌面" }
  try {
    const desktop = execFileSync("xdg-user-dir", ["DESKTOP"], { timeout: 3000, encoding: "utf8" }).trim()
    if (desktop && desktop !== os.homedir() && isDir(desktop)) return { dir: desktop, label: "桌面" }
  } catch {}
  return { dir: path.join(os.homedir(), "并坐"), label: "并坐" }
}

// A room that is still as installed: no real seat anywhere, and the user has
// said nothing anywhere.
export function isFresh() {
  for (const project of listProjects()) {
    const fresh = inProject(project.id, () => {
      const snap = snapshot()
      return !snap.agents.some((agent) => !agent.demo) && !snap.messages.some((message) => message.authorId === "human")
    })
    if (!fresh) return false
  }
  return true
}

export function firstOpenInfo() {
  const kinds = installedKinds()
  const parent = defaultParent()
  return {
    fresh: isFresh(),
    kinds: kinds.map((id) => ({ id, label: kindById(id)?.label ?? id })),
    pick: kinds[0] ?? null,
    parent: parent.dir,
    parentLabel: parent.label,
    ...(kinds.length === 0 ? { install: INSTALL_HINT } : {}),
  }
}

// Give the client the room's tools, the way 「接入 AI」's 「运行」 does, unless
// it already has them (from this copy of 并坐 or another: register-mcp.sh
// won't repoint a client that another copy uses).
async function connect(kind: string) {
  if (process.env.BENCH_FIRST_KINDS !== undefined) return
  const file = configOf(kind)
  try {
    if (file && readFileSync(file, "utf8").includes("bench-mcp.mjs")) return
  } catch {}
  const [result] = await register([kind])
  if (!result?.ok) {
    const last = result?.output.split("\n").filter(Boolean).at(-1) ?? ""
    throw new ApiError(500, `没能把并坐接到 ${kindById(kind)?.label ?? kind} 上${last ? `（${last.slice(0, 200)}）` : ""}。可以点右上角「更多设置」，在「接入 AI」里手动运行一次`)
  }
}

// A new folder under `parent`, with a number when the name is taken.
function newFolder(parent: string, name: string) {
  mkdirSync(parent, { recursive: true })
  for (let n = 1; n < 100; n++) {
    const dir = path.join(parent, n === 1 ? name : `${name}${n}`)
    if (existsSync(dir)) continue
    mkdirSync(dir)
    return dir
  }
  throw new ApiError(409, `「${parent}」里叫「${name}」的文件夹太多了，点「换一个」选一个文件夹`)
}

// One 「开始」 at a time; and once it has gone through, never again.
let starting: Promise<unknown> | null = null
let made: { dir: string; text: string } | null = null

export async function startFirst(input: unknown) {
  const body = asRecord(input)
  if (body.as !== "human") throw new ApiError(403, "只有用户自己能开始")
  const text = asString(body.text)?.trim() ?? ""
  if (!text) throw new ApiError(400, "先写一句想做什么")
  if (starting) throw new ApiError(409, "正在准备，等一下")
  if (!isFresh()) throw new ApiError(409, "这个房间已经开始用了，刷新一下页面")
  const kinds = installedKinds()
  const kind = asString(body.kind) ?? kinds[0]
  if (!kind) throw new ApiError(400, "这台电脑上还没装能用的 AI")
  if (!kinds.includes(kind)) throw new ApiError(400, `这台电脑上没找到 ${kindById(kind)?.label ?? kind}`)
  const chosen = asString(body.dir)?.trim()
  if (chosen && (!path.isAbsolute(chosen) || !isDir(chosen))) throw new ApiError(400, `「${chosen}」不是一个已有的文件夹`)
  const run = (async () => {
    await connect(kind)
    // A folder made by a 「开始」 that failed later is used again, not doubled.
    const name = folderNameOf(text)
    const dir = chosen || (made && made.text === text && isDir(made.dir) ? made.dir : newFolder(defaultParent().dir, name))
    if (!chosen) made = { dir, text }
    const regular = listProjects().filter((item) => !item.front)
    const project = regular.find((item) => item.name === "默认项目") ?? regular[0]
    if (!project) throw new ApiError(500, "房间里没有项目，点「更多设置」新建一个")
    const projectName = regular.some((item) => item.name === name && item.id !== project.id) ? project.name : name
    updateProject(project.id, { name: projectName, dir })
    const label = kindById(kind)?.label ?? kind
    const before = new Set(inProject(project.id, () => snapshot().agents.map((agent) => agent.id)))
    let result: Awaited<ReturnType<typeof spawnSession>>
    try {
      result = await inProject(project.id, () =>
        spawnSession({ kind, name: label, role: "开发", workspace: { path: dir }, task: text }),
      )
    } catch (error) {
      // Failed after the seat was made (its sign-in file could not be
      // written, the message not sent): take the seat back while the room
      // has nothing of the user's yet, so 「开始」 can be pressed again
      // instead of the room counting as used with nobody told.
      inProject(project.id, () => {
        const snap = snapshot()
        if (snap.messages.some((message) => message.authorId === "human")) return
        for (const agent of snap.agents) {
          if (!before.has(agent.id) && !agent.demo) removeAgent(agent.id, true)
        }
      })
      throw error
    }
    made = null
    return { project: project.id, agent: result.agent, dir }
  })()
  starting = run
  try {
    return await run
  } catch (error) {
    if (error instanceof ApiError) throw error
    throw new ApiError(500, `没准备好：${error instanceof Error ? error.message : String(error)}`)
  } finally {
    starting = null
  }
}
