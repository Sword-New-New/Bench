import path from "node:path"
import { spawn, type IPty } from "node-pty"

import { summonPath } from "@/lib/adapters"
import { compactEnv } from "@/lib/context"
import { ApiError } from "@/lib/http"
import { scriptCommand } from "@/lib/platform"
import { agentState, currentProject, inProject, touch } from "@/lib/store"
import { markTerminal, terminalOpen } from "@/lib/terminal-state"

// A seat's session opened in its client's own interactive screen, inside a
// pseudo-terminal the room holds (scripts/terminal.sh starts it). The page
// shows the screen with xterm.js and sends back what the user types, so they
// can watch a turn as it happens and take over. It lives on when the page
// closes; it ends when the client exits or the user closes it.
//
// While it is open the room doesn't run its headless wakes on that session
// (two processes on one session would trip over each other): what calls the
// seat is typed into this screen instead (lib/summon.ts).

export const TERMINAL_KINDS = ["claude", "codex"]
// What a page that opens late is shown first: the latest screenfuls.
const KEEP = 256 * 1024

type Term = {
  agentId: string
  project: string
  pty: IPty
  backlog: string
  watchers: Set<{ data: (text: string) => void; exit: (code: number) => void }>
  startedAt: number
  // Asked to close and on its way out: not reopened, nothing typed in.
  closing?: boolean
}

const g = globalThis as typeof globalThis & { __benchTerms?: Map<string, Term> }
function terms() {
  return (g.__benchTerms ??= new Map())
}

function size(value: unknown, fallback: number, max: number) {
  const n = Math.floor(Number(value))
  return Number.isFinite(n) && n >= 10 ? Math.min(n, max) : fallback
}

// Called inside the seat's project (inSeat).
export function openTerminal(agentId: string, cols?: unknown, rows?: unknown) {
  const found = terms().get(agentId)
  if (found?.closing) throw new ApiError(409, "终端正在关，等几秒再开")
  if (found) return { open: true, startedAt: found.startedAt }
  const agent = agentState(agentId)
  if (!agent) throw new ApiError(404, "这个席位不在了")
  if (!agent.agentName || !agent.session) throw new ApiError(400, `${agent.name} 没有能接着的会话`)
  if (!TERMINAL_KINDS.includes(agent.agentName)) {
    throw new ApiError(400, `${agent.name} 这种客户端还不能在房间里开终端（现在只有 Claude Code 和 Codex）`)
  }
  const [file, args] = scriptCommand(path.join(process.cwd(), "scripts", "terminal.sh"), [agent.agentName, agent.session])
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value
  Object.assign(env, {
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    PATH: summonPath(),
    BENCH_URL: (process.env.BENCH_URL || "http://127.0.0.1:4399").replace(/\/$/, ""),
    BENCH_AGENT: agent.agentName,
    BENCH_UUID: agent.session,
    BENCH_SESSION: agent.session,
    ...(agent.workdir ? { BENCH_NEW_DIR: agent.workdir } : {}),
    ...(agent.modelPick ? { BENCH_MODEL: agent.modelPick } : {}),
    ...(agent.effortPick ? { BENCH_EFFORT: agent.effortPick } : {}),
    ...compactEnv(agent),
  })
  // A room started from inside a Claude Code session hands down the markers of
  // that session; the client then takes itself for a child of it and doesn't
  // save its transcript. Settings a user put in CLAUDE_CODE_* stay.
  for (const key of [
    "CLAUDECODE",
    "CLAUDE_PID",
    "CLAUDE_EFFORT",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_SESSION_ATTENDED",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_EXECPATH",
    "CLAUDE_CODE_MESSAGING_SOCKET",
    "CLAUDE_CODE_MESSAGING_TOKEN",
    "BENCH_RUN_KEY",
  ]) {
    delete env[key]
  }

  let pty: IPty
  try {
    pty = spawn(file, args, { name: "xterm-256color", cols: size(cols, 120, 400), rows: size(rows, 32, 200), cwd: process.cwd(), env })
  } catch (error) {
    throw new ApiError(500, `终端没开起来：${(error as Error).message}`)
  }
  const term: Term = { agentId, project: currentProject(), pty, backlog: "", watchers: new Set(), startedAt: Date.now() }
  terms().set(agentId, term)
  markTerminal(agentId, true)
  touch(agentId)

  pty.onData((text) => {
    term.backlog = (term.backlog + text).slice(-KEEP)
    for (const watcher of term.watchers) watcher.data(text)
  })
  pty.onExit(({ exitCode }) => {
    terms().delete(agentId)
    for (const watcher of term.watchers) watcher.exit(exitCode)
    term.watchers.clear()
    markTerminal(agentId, false)
    try {
      inProject(term.project, () => touch(agentId))
    } catch {}
  })
  return { open: true, startedAt: term.startedAt }
}

export function terminalInfo(agentId: string) {
  const term = terms().get(agentId)
  return term ? { open: true, startedAt: term.startedAt, cols: term.pty.cols, rows: term.pty.rows } : { open: false }
}

function live(agentId: string) {
  const term = terms().get(agentId)
  if (!term) throw new ApiError(409, "终端已经关了")
  return term
}

export function typeIn(agentId: string, data: unknown) {
  if (typeof data !== "string" || data.length > 64 * 1024) throw new ApiError(400, "data 要是一段文字")
  live(agentId).pty.write(data)
}

export function resizeTerminal(agentId: string, cols: unknown, rows: unknown) {
  const term = live(agentId)
  term.pty.resize(size(cols, term.pty.cols, 400), size(rows, term.pty.rows, 200))
}

export function closeTerminal(agentId: string) {
  const term = terms().get(agentId)
  if (!term) return { closed: true }
  term.closing = true
  // Asks the client to exit the way closing its window would; it saves its session.
  term.pty.kill("SIGHUP")
  const pid = term.pty.pid
  setTimeout(() => {
    if (terms().get(agentId) === term) {
      try {
        process.kill(pid, "SIGKILL")
      } catch {}
    }
  }, 5000)
  return { closed: true }
}

// The screen so far, then everything new, until the terminal ends.
export function watchTerminal(agentId: string, data: (text: string) => void, exit: (code: number) => void) {
  const term = terms().get(agentId)
  if (!term) return null
  data(term.backlog)
  const watcher = { data, exit }
  term.watchers.add(watcher)
  return () => term.watchers.delete(watcher)
}

// Open and not on its way out: something typed in now gets read.
export function accepting(agentId: string) {
  const term = terms().get(agentId)
  return Boolean(term && !term.closing)
}

// What calls the seat, typed into its screen as one paste and sent. Bracketed
// paste keeps a message of many lines one message (Claude Code and Codex both
// take it); the Enter goes a moment later, after the paste has settled.
export function deliver(agentId: string, text: string) {
  const term = terms().get(agentId)
  if (!term || term.closing || !terminalOpen(agentId)) return false
  term.pty.write(`\x1b[200~${text.replace(/\x1b/g, "")}\x1b[201~`)
  setTimeout(() => {
    if (terms().get(agentId) === term) term.pty.write("\r")
  }, 300)
  return true
}
