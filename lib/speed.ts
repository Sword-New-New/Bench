import { spawn, type ChildProcess } from "node:child_process"
import path from "node:path"

// Native token output speed & usage reader (backed by scripts/speed-worker.mjs).
// Runs in a short-lived IPC Node helper process so multi-GB session transcripts
// neither block the Next.js event loop nor bloat its heap, and keeps an
// incremental byte-offset cache in data/speed-cache.json.

export type Speed = {
  kind: string
  tps: number // the latest reply, tokens per second
  median: number // over the latest 30
  model: string
  at: number // when the latest reply ended, ms
  ttft: number | null // the latest wait for the first token (or first chunk), seconds
  firstChunk: boolean // Claude and Antigravity log only the first chunk: an upper bound
}

export type SpeedBoardRow = [
  agent: number, // 0 claude, 1 codex, 2 antigravity, 3 dsh
  start: number | null, // seconds
  end: number, // seconds
  out: number,
  modelIdx: number,
  projectIdx: number,
  reasoning: number,
  ttft: number | null, // seconds
  inp: number,
  cread: number,
  cwrite: number,
]

export type SpeedBoardData =
  | { unchanged: true; v: string }
  | {
      unchanged?: false
      v: string
      now: number
      since: number | null
      models: string[]
      projects: string[]
      rows: SpeedBoardRow[]
    }

type PendingCall = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

type Bridge = {
  child: ChildProcess | null
  idleTimer: ReturnType<typeof setTimeout> | null
  seq: number
  calls: Map<number, PendingCall>
  summaryCache: { at: number; speeds: Speed[]; up: boolean } | null
}

const IDLE_SHUTDOWN_MS = 5 * 60_000
const SUMMARY_KEEP = 10_000

const globalStore = globalThis as typeof globalThis & { __benchSpeedBridge?: Bridge }

function bridge(): Bridge {
  return (globalStore.__benchSpeedBridge ??= {
    child: null,
    idleTimer: null,
    seq: 0,
    calls: new Map(),
    summaryCache: null,
  })
}

function failAll(b: Bridge, reason: Error) {
  for (const [, call] of b.calls) {
    clearTimeout(call.timer)
    call.reject(reason)
  }
  b.calls.clear()
}

function bumpIdle(b: Bridge) {
  if (b.idleTimer) clearTimeout(b.idleTimer)
  b.idleTimer = setTimeout(() => {
    if (b.calls.size === 0 && b.child) {
      const proc = b.child
      b.child = null
      proc.kill()
    }
  }, IDLE_SHUTDOWN_MS)
  b.idleTimer.unref?.()
}

function ensureChild(): ChildProcess {
  const b = bridge()
  if (b.child && b.child.connected) {
    bumpIdle(b)
    return b.child
  }
  const script = path.join(process.cwd(), "scripts", "speed-worker.mjs")
  const child = spawn(process.execPath, [script], {
    cwd: process.cwd(),
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    windowsHide: true,
  })
  child.unref()
  child.on("message", (msg: { id?: number; ok?: boolean; result?: unknown; error?: string }) => {
    if (typeof msg?.id !== "number") return
    const call = b.calls.get(msg.id)
    if (!call) return
    b.calls.delete(msg.id)
    clearTimeout(call.timer)
    if (msg.ok) call.resolve(msg.result)
    else call.reject(new Error(msg.error || "测速扫描出错"))
  })
  const drop = (err?: Error) => {
    if (b.child === child) b.child = null
    failAll(b, err ?? new Error("测速工作进程已退出"))
  }
  child.on("error", (err) => drop(err))
  child.on("exit", () => drop())
  b.child = child
  bumpIdle(b)
  return child
}

function ask<T>(payload: Record<string, unknown>, timeoutMs = 45_000): Promise<T> {
  const b = bridge()
  const child = ensureChild()
  const id = ++b.seq
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      b.calls.delete(id)
      reject(new Error("读取会话速度超时"))
    }, timeoutMs)
    b.calls.set(id, {
      resolve: resolve as (value: unknown) => void,
      reject,
      timer,
    })
    child.send({ ...payload, id })
  })
}

export async function speeds(fresh = false): Promise<{ speeds: Speed[]; up: boolean }> {
  const b = bridge()
  if (!fresh && b.summaryCache && Date.now() - b.summaryCache.at < SUMMARY_KEEP) {
    return { speeds: b.summaryCache.speeds, up: b.summaryCache.up }
  }
  try {
    const result = await ask<{ speeds: Speed[]; up: boolean }>({ op: "summary", fresh })
    b.summaryCache = { at: Date.now(), speeds: result.speeds, up: true }
    return result
  } catch {
    return { speeds: [], up: false }
  }
}

export async function speedBoard(range = "24h", v = "", fresh = false): Promise<SpeedBoardData> {
  return ask<SpeedBoardData>({ op: "query", range, v, fresh }, 45_000)
}
