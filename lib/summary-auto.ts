import { adapterFor, installed } from "@/lib/adapters"
import { isSeatUserStopped } from "@/lib/continue"
import { dbGetMeta, dbSetMeta } from "@/lib/db"
import { isLaneIdle, registerSummaryHold } from "@/lib/lane-state"
import { isKindQuotaBlocked } from "@/lib/quota"
import {
  agentState,
  inProject,
  isStandby,
  limitedAgentNames,
  listProjects,
  postSystem,
  roomChanged,
  snapshot,
  summaryBaseSeq,
  summaryJob,
} from "@/lib/store"
import { requestSummary } from "@/lib/summon"
import { terminalOpen } from "@/lib/terminal-state"
import type { PublicAgent, RoomSnapshot } from "@/lib/types"

// The room summary writes itself (t_df9c0fc7): when a project's talk since
// the last summary passes CATCH_UP_CHARS, the room picks a free seat and asks
// it to write one, instead of putting a card in front of the user every time
// to ask who. The card is still the way out: it shows when nobody free turned
// up in GIVE_UP, when two tries came to nothing, or when the room doesn't try
// at all (no wakeable seat; due before this start and nobody spoke since).
//
// Who: a seat with 「摘要」 in its name or role; then whoever wrote the last
// summary; then the free seat that spoke last. A seat at work is never cut
// short: with everyone busy the sweep looks again next tick. Not picked: the
// user stopped it and hasn't called it since; its queue is paused; its client
// is out of quota. Seats belong to one project, so the front desk's summary is
// only ever written by the desk, and the desk writes no one else's.
//
// One due (a project, at one summary base) gets at most two tries, kept in
// meta so a restart doesn't start over. One project is started at a time,
// GAP apart, so a room with several summaries long overdue doesn't wake a
// seat in each at once.

const DEFAULT_TICK_MS = 60_000
const DEFAULT_BOOT_MS = 2 * 60_000
const DEFAULT_GIVE_UP_MS = 30 * 60_000
const DEFAULT_GAP_MS = 3 * 60_000
const MAX_TRIES = 2
const KEEP_MS = 7 * 24 * 60 * 60_000
const META_KEY = "summaryAuto.state"
const LINE_MAX = 30
const SUMMARY_WORD = "摘要"

// Bumped when the sweep's rules change: the running timer's closure keeps the
// code it was made with, so a hot reload alone would leave the old rules on.
const SWEEP_VERSION = 1

// `at`: the sweep's time; `asked`: the clock when the seat was asked, which a
// saved summary's time is compared with.
type Try = { agentId: string; name: string; at: number; asked: number; result?: "done" | "failed" }

export type SummaryAutoEntry = {
  // The summary base (lib/store.ts summaryBaseSeq) this due belongs to.
  base: number
  firstAt: number
  tries: Try[]
  // Set once the room is finished with this due: written, or the card is back.
  outcome?: "done" | "failed" | "gave-up" | "none"
  lastAt: number
}

type PersistedState = {
  entries: Record<string, SummaryAutoEntry>
  lastStartAt?: number
}

type Runtime = {
  bootAt: number
  version?: number
  timer?: ReturnType<typeof setInterval>
  tickMs?: number
  busy?: boolean
  dataPath?: string
  cache?: PersistedState
}

const g = globalThis as typeof globalThis & { __benchSummaryAuto?: Runtime }

function rt(): Runtime {
  return (g.__benchSummaryAuto ??= { bootAt: Date.now() })
}

function envMs(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === "") return fallback
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

const bootMs = () => envMs("BENCH_SUMMARY_AUTO_BOOT_MS", DEFAULT_BOOT_MS)
const giveUpMs = () => envMs("BENCH_SUMMARY_AUTO_GIVE_UP_MS", DEFAULT_GIVE_UP_MS)
const gapMs = () => envMs("BENCH_SUMMARY_AUTO_GAP_MS", DEFAULT_GAP_MS)
const tickMs = () => Math.max(100, envMs("BENCH_SUMMARY_AUTO_TICK_MS", DEFAULT_TICK_MS))

export function summaryAutoBootAt() {
  return rt().bootAt
}

function loadState(): PersistedState {
  const state = rt()
  const curPath = process.env.BENCH_DATA_DIR || ""
  if (state.cache && state.dataPath === curPath) return state.cache
  let entries: Record<string, SummaryAutoEntry> = {}
  let lastStartAt: number | undefined
  try {
    const raw = JSON.parse(dbGetMeta(META_KEY) ?? "") as Partial<PersistedState>
    if (raw && typeof raw === "object") {
      if (raw.entries && typeof raw.entries === "object") entries = { ...raw.entries }
      if (typeof raw.lastStartAt === "number") lastStartAt = raw.lastStartAt
    }
  } catch {}
  state.cache = { entries, lastStartAt }
  state.dataPath = curPath
  return state.cache
}

function saveState(now = Date.now()) {
  const current = loadState()
  for (const [id, entry] of Object.entries(current.entries)) {
    if (!entry || typeof entry.lastAt !== "number" || now - entry.lastAt > KEEP_MS) delete current.entries[id]
  }
  try {
    dbSetMeta(META_KEY, JSON.stringify(current))
  } catch {}
}

export function summaryAutoEntry(projectId: string): SummaryAutoEntry | undefined {
  return loadState().entries[projectId]
}

// Read by the snapshot (lib/store.ts): while the room is still on this due,
// the page keeps the 「找谁写房间摘要？」 card down.
registerSummaryHold((projectId, base) => {
  const entry = loadState().entries[projectId]
  return Boolean(entry && entry.base === base && !entry.outcome)
})

function clip(text: string, max: number) {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > max ? `${flat.slice(0, Math.max(1, max - 1))}…` : flat
}

// Could the room ask this seat at all (busy or not)?
function wakeable(seat: PublicAgent) {
  if (seat.demo || !seat.callable) return false
  const raw = agentState(seat.id)
  if (!raw?.agentName || !raw.session) return false
  const adapter = adapterFor(raw.agentName)
  if (!adapter || !installed(adapter.command)) return false
  if (isSeatUserStopped(seat.id)) return false
  if (seat.queuePaused) return false
  return true
}

// Free right now: no wake, nothing queued, not held by a wait loop or a
// terminal, and its client not out of quota.
function free(seat: PublicAgent, limited: Set<string>, now: number) {
  if (seat.runId || seat.retry || seat.queuedCount || seat.status === "working") return false
  if (!isLaneIdle(seat.id)) return false
  if (seat.standby || isStandby(seat.id) || seat.terminal || terminalOpen(seat.id)) return false
  const kind = agentState(seat.id)?.agentName ?? ""
  if (limited.has(kind) || isKindQuotaBlocked(kind, now)) return false
  return true
}

function lastSpoke(snap: RoomSnapshot, seatId: string) {
  for (let i = snap.messages.length - 1; i >= 0; i -= 1) {
    const message = snap.messages[i]
    if (message.authorId === seatId && message.kind !== "system") return message.createdAt
  }
  return 0
}

// The order seats are tried in; `free` decides who can go now.
export function summaryCandidates(snap: RoomSnapshot): PublicAgent[] {
  const rank = (seat: PublicAgent) => {
    if (seat.name.includes(SUMMARY_WORD) || (seat.role ?? "").includes(SUMMARY_WORD)) return 0
    if (snap.summary?.by && snap.summary.by === seat.name) return 1
    return 2
  }
  return snap.agents
    .filter(wakeable)
    .map((seat) => ({ seat, rank: rank(seat), spoke: lastSpoke(snap, seat.id) }))
    .sort((a, b) => a.rank - b.rank || b.spoke - a.spoke)
    .map((item) => item.seat)
}

// Someone other than the room has spoken here since this process started.
function talkSinceBoot(snap: RoomSnapshot, bootAt: number) {
  for (let i = snap.messages.length - 1; i >= 0; i -= 1) {
    const message = snap.messages[i]
    if (message.createdAt < bootAt) return false
    if (message.kind !== "system" && message.authorId !== "room" && !message.recalled) return true
  }
  return false
}

type Pending = "writing" | "done" | "failed"

// Where the last try stands. A seat that is still running or still has the
// summary queued is writing; otherwise a summary saved after the ask means it
// was written (by it or anyone), and no summary means the try came to nothing
// (out of quota, stopped, wrote nothing, or a restart cut it off).
function tryState(snap: RoomSnapshot, attempt: Try): Pending {
  const job = summaryJob()
  if (job?.agentId === attempt.agentId) return "writing"
  if ((snap.summary?.at ?? 0) >= attempt.asked) return "done"
  const seat = snap.agents.find((agent) => agent.id === attempt.agentId)
  if (seat && (seat.runId || !isLaneIdle(seat.id))) return "writing"
  return "failed"
}

export type SummaryAutoResult = { started: string[]; written: string[]; failed: string[]; gaveUp: string[] }

export function sweepSummaryAuto(now = Date.now()): SummaryAutoResult {
  const s = rt()
  const out: SummaryAutoResult = { started: [], written: [], failed: [], gaveUp: [] }
  if (s.busy) return out
  s.busy = true
  try {
    const state = loadState()
    let dirty = false
    const inBoot = now - s.bootAt < bootMs()
    const limited = limitedAgentNames(now)
    // Only one start per sweep, and GAP between starts across the room.
    let startedOne = false

    for (const project of listProjects()) {
      inProject(project.id, () => {
        const snap = snapshot()
        const base = summaryBaseSeq()
        let entry: SummaryAutoEntry | undefined = state.entries[project.id]

        // 1. A try still open: see how it went, whatever the base is now.
        const last = entry?.tries[entry.tries.length - 1]
        if (entry && last && !last.result && !entry.outcome) {
          const where = tryState(snap, last)
          if (where === "writing") return
          if (where === "done") {
            last.result = "done"
            entry.outcome = "done"
            entry.lastAt = now
            dirty = true
            const by = snap.summary?.by || last.name
            postSystem(clip(`房间摘要更新了（${clip(by, 16)} 写的）`, LINE_MAX))
            out.written.push(project.id)
            return
          }
          last.result = "failed"
          entry.lastAt = now
          dirty = true
          out.failed.push(project.id)
          if (entry.tries.length >= MAX_TRIES) {
            entry.outcome = "failed"
            try {
              roomChanged()
            } catch {}
            return
          }
        }

        if (!snap.summaryDue) {
          // Written, skipped, or edited by hand: this due is over.
          if (entry && entry.base !== base) {
            delete state.entries[project.id]
            dirty = true
          }
          return
        }

        if (entry && entry.base !== base) {
          // A new due (the summary moved on, or the user skipped): start fresh.
          delete state.entries[project.id]
          entry = undefined
          dirty = true
        }
        if (entry?.outcome) return
        if (inBoot) return

        const all = summaryCandidates(snap)
        if (!entry) {
          // Not taken on: no seat the room could ask (the card shows), or it
          // was due before this start and nobody has spoken here since.
          if (all.length === 0) return
          if (!talkSinceBoot(snap, s.bootAt)) return
          entry = { base, firstAt: now, tries: [], lastAt: now }
          state.entries[project.id] = entry
          dirty = true
          try {
            roomChanged()
          } catch {}
        }

        const cur = entry
        const tried = new Set(cur.tries.map((item) => item.agentId))
        const left = all.filter((seat) => !tried.has(seat.id))
        if (left.length === 0) {
          cur.outcome = cur.tries.length > 0 ? "failed" : "none"
          cur.lastAt = now
          dirty = true
          try {
            roomChanged()
          } catch {}
          return
        }
        const giveUp = () => {
          cur.outcome = "gave-up"
          cur.lastAt = now
          dirty = true
          out.gaveUp.push(project.id)
          try {
            roomChanged()
          } catch {}
        }
        // The half hour counts from the due, or from the failed try before
        // this one, so a retry gets its own chance to find someone.
        const since = Math.max(cur.firstAt, cur.tries[cur.tries.length - 1]?.at ?? 0)
        if (now - since >= giveUpMs()) return giveUp()

        if (startedOne || summaryJob()) return
        if (state.lastStartAt !== undefined && now - state.lastStartAt < gapMs()) return
        const pick = left.find((seat) => free(seat, limited, now))
        if (!pick) return
        try {
          requestSummary(pick.id)
        } catch {
          return
        }
        cur.tries.push({ agentId: pick.id, name: pick.name, at: now, asked: Date.now() })
        cur.lastAt = now
        state.lastStartAt = now
        startedOne = true
        dirty = true
        out.started.push(project.id)
      })
    }

    if (dirty) saveState(now)
    return out
  } finally {
    s.busy = false
  }
}

export function ensureSummaryAuto() {
  const s = rt()
  const want = tickMs()
  if (s.timer && s.tickMs === want && s.version === SWEEP_VERSION) return
  if (s.timer) clearInterval(s.timer)
  s.tickMs = want
  s.version = SWEEP_VERSION
  s.timer = setInterval(() => {
    try {
      sweepSummaryAuto()
    } catch (error) {
      console.error(error)
    }
  }, want)
  s.timer.unref?.()
}
