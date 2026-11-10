import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import { ApiError } from "@/lib/http"

// How full each seat's own conversation is: the tokens its last turn sent
// (the whole context, prompt and history) against the window it compacts at.
// Read from the session's record on disk, so it works for a seat whether the
// room woke it or someone types in its window. Claude Code and Codex keep
// that record; for other clients the room can't tell.

export type SeatContext = {
  // Tokens in the context after its last turn; null right after a compaction
  // Codex hasn't measured yet.
  tokens: number | null
  // The most it can hold: the seat's own pick, else the model's window
  // (Codex reports its own).
  window: number
  // Where it compacts by itself, when the room can tell: the seat's pick
  // (window x percent), else Claude Code's autoCompactWindow setting.
  compactAt?: number
  // tokens of window.
  percent: number | null
  model?: string
  // When the record last changed.
  at: number
  // The last compaction in the part of the record read.
  compacted?: { at: number; auto: boolean; before?: number; after?: number }
}

// Kinds whose context the room can read, and compact (lib/summon.ts).
export const CONTEXT_KINDS = ["claude", "codex"]

// What the user picks for a seat (「换模型」「开新会话」): the most context it
// may hold (`windowPick`, tokens) and at what share of that it compacts by
// itself (`compactPct`). Each wake gets window x percent as
// BENCH_COMPACT_WINDOW: Claude Code takes it as CLAUDE_CODE_AUTO_COMPACT_WINDOW
// (beats its settings files; 100K to 1M, never past the model's window), Codex
// as model_auto_compact_token_limit.
export const WINDOW_MIN = 100_000
export const WINDOW_MAX = 1_000_000
export const PCT_MIN = 10
export const PCT_MAX = 100

// undefined: not given, leave it; null: back to the default.
export function checkWindow(value: unknown): number | null | undefined {
  if (value === undefined) return undefined
  if (value === null || value === "" || value === 0) return null
  const tokens = typeof value === "string" ? Number(value) : value
  if (typeof tokens !== "number" || !Number.isInteger(tokens) || tokens < WINDOW_MIN || tokens > WINDOW_MAX) {
    throw new ApiError(400, `最大上下文窗口要在 ${WINDOW_MIN / 10_000} 万到 ${WINDOW_MAX / 10_000} 万之间`)
  }
  return tokens
}

export function checkPct(value: unknown): number | null | undefined {
  if (value === undefined) return undefined
  if (value === null || value === "" || value === 0) return null
  const pct = typeof value === "string" ? Number(value) : value
  if (typeof pct !== "number" || !Number.isInteger(pct) || pct < PCT_MIN || pct > PCT_MAX) {
    throw new ApiError(400, `自动压缩的百分比要在 ${PCT_MIN}% 到 ${PCT_MAX}% 之间`)
  }
  return pct
}

type Picks = { windowPick?: number; compactPct?: number; modelPick?: string }

// The model's own window, before any pick: from its record, else (a session
// not run yet) from the model picked for it.
function modelWindow(kind: string | undefined, session: string | undefined, picks: Picks) {
  const raw = recordContext(kind, session)
  if (kind === "claude") return claudeModelWindow(raw?.model ?? picks.modelPick ?? "")
  return raw?.window ?? null
}

// Where the seat compacts, from its picks; null keeps the client's own.
// Claude Code won't go under 100K.
export function compactPoint(kind: string | undefined, session: string | undefined, picks: Picks): number | null {
  if (!picks.windowPick && !picks.compactPct) return null
  const full = modelWindow(kind, session, picks)
  const window = picks.windowPick ? Math.min(picks.windowPick, full ?? picks.windowPick) : full
  if (!window) return null
  const point = Math.round((window * (picks.compactPct ?? 100)) / 100)
  return kind === "claude" ? Math.max(WINDOW_MIN, point) : point
}

type Json = Record<string, unknown>

// The end of a record is enough: the latest turn is there. Records run to
// tens of MB; this reads the last 4 MB, or the last 16 MB when the last turn
// isn't in those (a huge tool result at the end).
const TAIL = 4 << 20
const TAIL_MAX = 16 << 20

function tail(file: string, bytes: number) {
  const size = statSync(file).size
  const start = Math.max(0, size - bytes)
  const fd = openSync(file, "r")
  try {
    const buffer = Buffer.alloc(size - start)
    readSync(fd, buffer, 0, buffer.length, start)
    const text = buffer.toString("utf8")
    // The first line is probably cut; drop it unless the file starts there.
    const lines = text.split("\n")
    if (start > 0) lines.shift()
    return { lines, whole: start === 0 }
  } finally {
    closeSync(fd)
  }
}

function parse(line: string): Json | null {
  if (!line.trim()) return null
  try {
    const value = JSON.parse(line) as unknown
    return value && typeof value === "object" ? (value as Json) : null
  } catch {
    return null
  }
}

function num(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function time(value: unknown) {
  const at = typeof value === "string" ? Date.parse(value) : NaN
  return Number.isFinite(at) ? at : 0
}

// Reads the tail, and more of it when the answer isn't there.
function scan<T>(file: string, read: (lines: string[]) => T | null): T | null {
  let bytes = TAIL
  for (;;) {
    const { lines, whole } = tail(file, bytes)
    const found = read(lines)
    if (found || whole || bytes >= TAIL_MAX) return found
    bytes *= 4
  }
}

// What a wake (or the page's terminal) is handed: where to compact, in tokens.
export function compactEnv(agent: Picks & { agentName?: string; session?: string }): Record<string, string> {
  const point = compactPoint(agent.agentName, agent.session, agent)
  return point ? { BENCH_COMPACT_WINDOW: String(point) } : {}
}

// ---- Claude Code ----

const paths = new Map<string, string>()

function claudeFile(session: string) {
  const known = paths.get(session)
  if (known && existsSync(known)) return known
  const root = path.join(os.homedir(), ".claude", "projects")
  let dirs: string[] = []
  try {
    dirs = readdirSync(root)
  } catch {
    return null
  }
  for (const dir of dirs) {
    const file = path.join(root, dir, `${session}.jsonl`)
    if (existsSync(file)) {
      paths.set(session, file)
      return file
    }
  }
  return null
}

// autoCompactWindow at the top of a settings file, or under the model's own
// entry in modelSettings (which wins).
function settingsWindow(file: string, model: string): number | null {
  try {
    const settings = JSON.parse(readFileSync(file, "utf8")) as Json
    const own = ((settings.modelSettings ?? {}) as Record<string, Json | undefined>)[model]?.autoCompactWindow
    const value = typeof own === "number" ? own : settings.autoCompactWindow
    return typeof value === "number" && value > 0 ? value : null
  } catch {
    return null
  }
}

// The window a Claude model has: 1M for the current ones, 200K for Haiku 4.5
// and the generations before Opus 4.6 / Sonnet 4.6.
function claudeModelWindow(model: string) {
  if (/claude-3|haiku-4-5|sonnet-4-5|sonnet-4-0|sonnet-4-2|opus-4-[015]|opus-4-2/.test(model)) return 200_000
  return 1_000_000
}

// autoCompactWindow, if set: the project's settings over the user's.
function claudeCompactAt(model: string, cwd: string | undefined) {
  const files = [path.join(os.homedir(), ".claude", "settings.json")]
  if (cwd) files.push(path.join(cwd, ".claude", "settings.json"), path.join(cwd, ".claude", "settings.local.json"))
  let set: number | null = null
  for (const file of files) set = settingsWindow(file, model) ?? set
  return set ? Math.min(set, claudeModelWindow(model)) : undefined
}

function claudeContext(session: string): SeatContext | null {
  const file = claudeFile(session)
  if (!file) return null
  const found = scan(file, (lines) => {
    let tokens: number | null = null
    let model = ""
    let cwd: string | undefined
    let compacted: SeatContext["compacted"]
    // Newest first: the latest turn's usage, or a compaction after it.
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const entry = parse(lines[index])
      if (!entry || entry.isSidechain) continue
      cwd ??= typeof entry.cwd === "string" ? entry.cwd : undefined
      if (entry.type === "system" && entry.subtype === "compact_boundary") {
        const meta = (entry.compactMetadata ?? {}) as Json
        compacted ??= {
          at: time(entry.timestamp),
          auto: meta.trigger === "auto",
          before: num(meta.preTokens) || undefined,
          after: num(meta.postTokens) || undefined,
        }
        if (tokens === null && compacted.after) tokens = compacted.after
      }
      if (entry.type === "assistant") {
        const message = (entry.message ?? {}) as Json
        const usage = message.usage as Json | undefined
        const name = typeof message.model === "string" ? message.model : ""
        if (name && name !== "<synthetic>") model ||= name
        if (tokens === null && usage && name !== "<synthetic>") {
          tokens =
            num(usage.input_tokens) + num(usage.cache_creation_input_tokens) + num(usage.cache_read_input_tokens) + num(usage.output_tokens)
        }
      }
      if (tokens !== null && model && compacted) break
    }
    return tokens === null ? null : { tokens, model, cwd, compacted }
  })
  if (!found) return null
  const window = claudeModelWindow(found.model)
  return {
    tokens: found.tokens,
    window,
    compactAt: claudeCompactAt(found.model, found.cwd),
    percent: Math.min(100, Math.round((found.tokens / window) * 100)),
    model: found.model || undefined,
    at: statSync(file).mtimeMs,
    compacted: found.compacted,
  }
}

// ---- Codex ----

// ~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<thread id>.jsonl, newest days first.
function codexFile(thread: string) {
  const known = paths.get(thread)
  if (known && existsSync(known)) return known
  const root = path.join(os.homedir(), ".codex", "sessions")
  const down = (dir: string) => {
    try {
      return readdirSync(dir).sort().reverse()
    } catch {
      return []
    }
  }
  for (const year of down(root)) {
    for (const month of down(path.join(root, year))) {
      for (const day of down(path.join(root, year, month))) {
        const dir = path.join(root, year, month, day)
        const name = down(dir).find((item) => item.endsWith(`-${thread}.jsonl`))
        if (name) {
          const file = path.join(dir, name)
          paths.set(thread, file)
          return file
        }
      }
    }
  }
  return null
}

function codexContext(thread: string): SeatContext | null {
  const file = codexFile(thread)
  if (!file) return null
  const found = scan(file, (lines) => {
    let compacted: SeatContext["compacted"]
    let model = ""
    let count: { tokens: number | null; window: number } | null = null
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const entry = parse(lines[index])
      if (!entry) continue
      const payload = (entry.payload ?? {}) as Json
      // The turn's settings come before its counts: keep going for the model,
      // and for the last compaction even when it came before the count.
      if (entry.type === "turn_context" && typeof payload.model === "string") model ||= payload.model
      if (entry.type === "compacted") {
        compacted ??= { at: time(entry.timestamp), auto: false }
      }
      if (model && count && compacted) break
      if (count) continue
      if (entry.type === "event_msg" && payload.type === "token_count" && payload.info) {
        const info = payload.info as Json
        const last = (info.last_token_usage ?? {}) as Json
        const window = num(info.model_context_window)
        // Compacted after this turn: the old count no longer holds.
        if (window) count = { tokens: compacted ? null : num(last.total_tokens), window }
      }
    }
    return count ? { ...count, model, compacted } : null
  })
  if (!found) return null
  return {
    tokens: found.tokens,
    window: found.window,
    percent: found.tokens === null ? null : Math.min(100, Math.round((found.tokens / found.window) * 100)),
    model: found.model || undefined,
    at: statSync(file).mtimeMs,
    compacted: found.compacted,
  }
}

// ---- Both ----

const cache = new Map<string, { mtimeMs: number; size: number; value: SeatContext | null }>()

// With the seat's picks, which win over what the client's settings say.
export function seatContext(kind: string | undefined, session: string | undefined, picks: Picks = {}): SeatContext | null {
  const value = recordContext(kind, session)
  if (!value || (!picks.windowPick && !picks.compactPct)) return value
  const window = picks.windowPick ? Math.min(picks.windowPick, value.window) : value.window
  const percent = value.tokens === null ? null : Math.min(100, Math.round((value.tokens / window) * 100))
  return { ...value, window, percent, compactAt: compactPoint(kind, session, picks) ?? value.compactAt }
}

function recordContext(kind: string | undefined, session: string | undefined): SeatContext | null {
  if (!kind || !session || !/^[A-Za-z0-9._-]+$/.test(session)) return null
  const file = kind === "claude" ? claudeFile(session) : kind === "codex" ? codexFile(session) : null
  if (!file) return null
  try {
    const stat = statSync(file)
    const key = `${kind}:${session}`
    const hit = cache.get(key)
    if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.value
    const value = kind === "claude" ? claudeContext(session) : codexContext(session)
    cache.set(key, { mtimeMs: stat.mtimeMs, size: stat.size, value })
    return value
  } catch {
    return null
  }
}
