import { adapterFor, installed } from "@/lib/adapters"
import { dbGetMeta, dbSetMeta } from "@/lib/db"
import { isLaneIdle, registerSeatUserStopped } from "@/lib/lane-state"
import { registerContinueWoken } from "@/lib/owes"
import { noteSeatStalled } from "@/lib/patrol"
import { isKindQuotaBlocked } from "@/lib/quota"
import { awaitingReview, reviewAsked } from "@/lib/review"
import {
  agentState,
  inProject,
  isStandby,
  limitedAgentNames,
  listProjects,
  postRoomWake,
  roomChanged,
  snapshot,
  tasksOwedBy,
} from "@/lib/store"
import { terminalOpen } from "@/lib/terminal-state"
import type { CallState, Task } from "@/lib/types"

// 「停了自己接着做」 (t_4494da49): when a seat has owed work (unfinished to-dos
// waiting on nobody else, or failed/cut calls) and stays quiet for 5 minutes,
// the room wakes it once under the room's own name, and at most one more time
// 20 minutes later. After two wakes with no progress it stops trying and notes
// an urgent item for the front desk. Any real progress resets the count.

const DEFAULT_FIRST_MS = 5 * 60_000
const DEFAULT_SECOND_MS = 20 * 60_000
const DEFAULT_BOOT_MS = 2 * 60_000
const DEFAULT_TICK_MS = 30_000
const MAX_TRIES = 2
const KEEP_MS = 7 * 24 * 60 * 60_000
const META_KEY = "continue.state"
const SYSTEM_LINE_MAX = 30

const SETTLED_CALLS = new Set<CallState>(["answered", "silent", "failed", "stopped", "cut", "dropped"])

export type ContinueEntry = {
  projectId: string
  sig: string
  count: number
  firstAt: number
  lastAt: number
  lastMsgId?: string
  reported?: boolean
}

type PersistedState = {
  entries: Record<string, ContinueEntry>
  stopped: Record<string, number>
  resets: Record<string, number>
}

// Bumped when the sweep's rules change: the running timer's closure keeps the
// code it was made with, so a hot reload alone would leave the old rules on.
const SWEEP_VERSION = 3

type ContinueRuntime = {
  bootAt: number
  version?: number
  timer?: ReturnType<typeof setInterval>
  tickMs?: number
  busy?: boolean
  dataPath?: string
  cache?: PersistedState
}

const g = globalThis as typeof globalThis & { __benchContinue?: ContinueRuntime }

function rt(): ContinueRuntime {
  return (g.__benchContinue ??= { bootAt: Date.now() })
}

function envMs(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === "") return fallback
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

export function firstWaitMs() {
  return envMs("BENCH_CONTINUE_FIRST_MS", DEFAULT_FIRST_MS)
}

export function secondWaitMs() {
  return envMs("BENCH_CONTINUE_SECOND_MS", DEFAULT_SECOND_MS)
}

export function bootGraceMs() {
  return envMs("BENCH_CONTINUE_BOOT_MS", DEFAULT_BOOT_MS)
}

function tickMs() {
  return Math.max(100, envMs("BENCH_CONTINUE_TICK_MS", DEFAULT_TICK_MS))
}

export function serverBootAt() {
  return rt().bootAt
}

function loadState(): PersistedState {
  const state = rt()
  const curPath = process.env.BENCH_DATA_DIR || ""
  if (state.cache && state.dataPath === curPath) {
    state.cache.entries ??= {}
    state.cache.stopped ??= {}
    state.cache.resets ??= {}
    return state.cache
  }
  let entries: Record<string, ContinueEntry> = {}
  let stopped: Record<string, number> = {}
  let resets: Record<string, number> = {}
  try {
    const raw = JSON.parse(dbGetMeta(META_KEY) ?? "") as Partial<PersistedState>
    if (raw && typeof raw === "object") {
      if (raw.entries && typeof raw.entries === "object") entries = { ...raw.entries }
      if (raw.stopped && typeof raw.stopped === "object") stopped = { ...raw.stopped }
      if (raw.resets && typeof raw.resets === "object") resets = { ...raw.resets }
    }
  } catch {}
  state.cache = { entries, stopped, resets }
  state.dataPath = curPath
  return state.cache
}

function saveState(now = Date.now()) {
  const current = loadState()
  for (const [id, entry] of Object.entries(current.entries)) {
    if (!entry || typeof entry.lastAt !== "number" || now - entry.lastAt > KEEP_MS) {
      delete current.entries[id]
    }
  }
  for (const [id, at] of Object.entries(current.stopped)) {
    if (typeof at !== "number" || now - at > KEEP_MS) {
      delete current.stopped[id]
    }
  }
  for (const [id, at] of Object.entries(current.resets)) {
    if (typeof at !== "number" || now - at > KEEP_MS) {
      delete current.resets[id]
    }
  }
  try {
    dbSetMeta(META_KEY, JSON.stringify(current))
  } catch {}
}

// Recorded when the user clicks Stop on a seat: the room will not auto-wake it
// until the user calls that seat again.
export function markSeatUserStopped(agentId: string, now = Date.now()) {
  const current = loadState()
  current.stopped[agentId] = now
  delete current.entries[agentId]
  saveState(now)
  try {
    roomChanged()
  } catch {}
}

// Cleared when the user calls or resumes the seat intentionally.
export function clearSeatUserStopped(agentId: string, now = Date.now()) {
  const current = loadState()
  const hadStopped = agentId in current.stopped
  const hadEntry = agentId in current.entries
  if (!hadStopped && !hadEntry) return
  delete current.stopped[agentId]
  delete current.entries[agentId]
  saveState(now)
}

export function isSeatUserStopped(agentId: string): boolean {
  return Boolean(loadState().stopped[agentId])
}

registerSeatUserStopped(isSeatUserStopped)

function clip(text: string, max: number) {
  const flat = text.replace(/\s+/g, " ").trim()
  if (max <= 0) return ""
  return flat.length > max ? `${flat.slice(0, Math.max(1, max - 1))}…` : flat
}

function sortOwedTasks(tasks: Task[]): Task[] {
  return [...tasks].sort(
    (a, b) => Number(b.status === "doing") - Number(a.status === "doing") || b.updatedAt - a.updatedAt,
  )
}

function progressSig(tasks: Task[], nonRoomCallIds: string[]): string {
  const taskPart = [...tasks]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((task) => {
      const steps = (task.steps ?? []).map((s) => `${s.id}:${s.state}`).join(",")
      return `${task.id}[${steps}]`
    })
    .join("|")
  const callPart = [...new Set(nonRoomCallIds)].sort().join(",")
  return `tasks:${taskPart};calls:${callPart}`
}

registerContinueWoken((seatId, tasks, nonRoomCallIds) => {
  const entry = loadState().entries[seatId]
  if (!entry || entry.count < 1) return undefined
  if (entry.sig !== progressSig(tasks, nonRoomCallIds)) return undefined
  return { count: entry.count, at: entry.lastAt }
})

function describeTaskStep(task: Task): string {
  // Only the sign-off left, never asked for: nothing checks it until it is.
  if (awaitingReview(task) && !reviewAsked(task)) return "（只剩验收：写清怎么看到效果，再请验收）"
  const steps = task.steps ?? []
  if (steps.length === 0) return ""
  let idx = steps.findIndex((s) => s.state === "doing")
  if (idx < 0) idx = steps.findIndex((s) => s.state === "todo")
  if (idx < 0) return ""
  return `（第 ${idx + 1} 步「${clip(steps[idx].text, 28)}」）`
}

function buildWakeTexts(seatName: string, orderedTasks: Task[], callIds: string[], user: string) {
  if (orderedTasks.length > 0) {
    const head = orderedTasks[0]
    const suffix = orderedTasks.length > 1 ? ` 等${orderedTasks.length}条` : ""
    const fixedLen = "房间叫 ".length + " 接着做 ".length + head.id.length + suffix.length
    const shortName = clip(seatName, Math.max(2, SYSTEM_LINE_MAX - fixedLen))
    const shortText = clip(`房间叫 ${shortName} 接着做 ${head.id}${suffix}`, SYSTEM_LINE_MAX)

    const listed = orderedTasks.slice(0, 3).map((t) => `${t.id}「${clip(t.title, 36)}」${describeTaskStep(t)}`)
    const taskLead =
      orderedTasks.length === 1
        ? `你手上还有未完的待办 ${listed[0]}`
        : `你手上还有 ${orderedTasks.length} 条未完的待办：${listed.join("；")}${orderedTasks.length > 3 ? ` 等 ${orderedTasks.length} 条` : ""}`
    const callTail =
      callIds.length > 0
        ? `另外前面有 ${callIds.length} 条点名你的消息没送到（${callIds.slice(0, 3).join("、")}），一起看。`
        : ""
    const wakeText = `${taskLead}，停下有一会儿了，接着做；做不下去就把待办标成卡住并写明原因，或用 bench_ask 问 ${user}；做完了还没请验收就请验收。${callTail ? ` ${callTail}` : ""}`
    return { shortText, wakeText }
  }

  const fixedLen = "房间叫 ".length + " 接着回未达消息".length
  const shortName = clip(seatName, Math.max(2, SYSTEM_LINE_MAX - fixedLen))
  const shortText = clip(`房间叫 ${shortName} 接着回未达消息`, SYSTEM_LINE_MAX)
  const wakeText = `你停下有一会儿了，前面有 ${callIds.length} 条点名你的消息没送到（${callIds.slice(0, 5).join("、")}），一起看并接着处理；做不下去或要人拍板就用 bench_ask 问 ${user}。`
  return { shortText, wakeText }
}

export function sweepContinue(now = Date.now()): { woken: string[]; reported: string[] } {
  const s = rt()
  if (s.busy) return { woken: [], reported: [] }
  s.busy = true
  const woken: string[] = []
  const reported: string[] = []
  try {
    const state = loadState()
    let dirty = false
    const projects = listProjects()
    const limitedKinds = limitedAgentNames(now)
    const inBootGrace = now - s.bootAt < bootGraceMs()

    // Never touch seats in the front-desk project; clean any stale entry if one existed.
    for (const frontProj of projects.filter((p) => p.front)) {
      inProject(frontProj.id, () => {
        for (const seat of snapshot().agents) {
          if (seat.id in state.entries) {
            delete state.entries[seat.id]
            dirty = true
          }
        }
      })
    }

    for (const proj of projects.filter((p) => !p.front)) {
      inProject(proj.id, () => {
        const snap = snapshot()
        const askingIds = new Set<string>()
        for (const msg of [...(snap.openAsks ?? []), ...snap.messages]) {
          if (msg.ask?.state === "open" && !msg.recalled) askingIds.add(msg.authorId)
        }

        for (const seat of snap.agents) {
          if (seat.demo) continue

          // Progress: seat asked the user a question or marked itself blocked -> clear count.
          if (askingIds.has(seat.id) || seat.status === "blocked") {
            if (seat.id in state.entries) {
              delete state.entries[seat.id]
              state.resets[seat.id] = now
              dirty = true
            }
            continue
          }

          const raw = agentState(seat.id)
          const wokeAt = raw?.wokeAt ?? 0
          const owed = sortOwedTasks(tasksOwedBy(seat.id))
          const nonRoomCallIds: string[] = []
          for (const msg of snap.messages) {
            if (msg.recalled || msg.authorId === "room") continue
            const call = msg.calls?.find((c) => c.id === seat.id)
            if (!call || (call.state !== "failed" && call.state !== "cut")) continue
            if (call.at <= wokeAt) continue
            nonRoomCallIds.push(msg.id)
          }

          // Progress: all owed to-dos and non-room failed calls are settled -> clear count.
          if (owed.length === 0 && nonRoomCallIds.length === 0) {
            if (seat.id in state.entries || seat.id in state.resets) {
              delete state.entries[seat.id]
              delete state.resets[seat.id]
              dirty = true
            }
            continue
          }

          const sig = progressSig(owed, nonRoomCallIds)
          const existing = state.entries[seat.id]
          if (existing && existing.sig !== sig) {
            // Steps moved forward or the owed set changed -> reset counter to 0,
            // and start counting the fresh 5-minute quiet window from now.
            delete state.entries[seat.id]
            state.resets[seat.id] = now
            dirty = true
          }

          // Guard 1: within 2 minutes of server startup.
          if (inBootGrace) continue
          // Guard 1b (Fable, 2026-11-17): it stopped before this room process
          // began to watch. Debts from days ago in projects nobody is pushing
          // (the day this went live: four seats, one to three days stale) and
          // wakes a restart cut off are not started again on the room's own
          // initiative; the latter is the restart recovery's job.
          if ((seat.owes?.since ?? 0) < s.bootAt) continue
          // Guard 2: user intentionally stopped this seat, and hasn't called it again yet.
          if (isSeatUserStopped(seat.id)) continue
          // Guard 3: cannot be woken (missing client/session, missing adapter, or client CLI not installed).
          if (!raw?.agentName || !raw.session) continue
          const adapter = adapterFor(raw.agentName)
          if (!adapter || !installed(adapter.command)) continue
          // Guard 4: waiting in bench_wait or open in web terminal.
          if (seat.standby || isStandby(seat.id) || seat.terminal || terminalOpen(seat.id)) continue
          // Guard 5: user paused its queue, or a run / network retry / queued work is active.
          if (seat.queuePaused || seat.runId || seat.retry || seat.queuedCount || !isLaneIdle(seat.id)) continue
          // Guard 6: working or unsure, or snapshot doesn't view it as quiet with owed work.
          if (seat.status === "working" || seat.unsure !== undefined || !seat.owes) continue
          // Guard 7: client is blocked by usage/quota limit.
          if (limitedKinds.has(raw.agentName) || isKindQuotaBlocked(raw.agentName, now)) continue

          const entry = state.entries[seat.id]
          const firstWait = firstWaitMs()
          const secondWait = secondWaitMs()

          if (!entry) {
            const quietSince = Math.max(seat.owes.since, state.resets[seat.id] ?? 0)
            if (now - quietSince < firstWait) continue
            delete state.resets[seat.id]
            const { shortText, wakeText } = buildWakeTexts(seat.name, owed, nonRoomCallIds, snap.userName)
            const msg = postRoomWake(seat.id, shortText, wakeText, owed[0]?.id)
            state.entries[seat.id] = {
              projectId: proj.id,
              sig,
              count: 1,
              firstAt: now,
              lastAt: now,
              lastMsgId: msg.id,
            }
            dirty = true
            woken.push(seat.id)
            try {
              roomChanged()
            } catch {}
            continue
          }

          const lastMsg = entry.lastMsgId ? snap.messages.find((m) => m.id === entry.lastMsgId) : undefined
          const lastCall = lastMsg?.calls?.find((c) => c.id === seat.id)
          if (lastCall && !SETTLED_CALLS.has(lastCall.state)) continue
          if (lastMsg && !lastCall && now - entry.lastAt < Math.min(5_000, Math.max(200, secondWait))) continue

          if (entry.count < MAX_TRIES) {
            if (now - Math.max(entry.lastAt, seat.owes.since) < secondWait) continue
            const nextCount = entry.count + 1
            const { shortText, wakeText } = buildWakeTexts(seat.name, owed, nonRoomCallIds, snap.userName)
            const msg = postRoomWake(seat.id, shortText, wakeText, owed[0]?.id)
            state.entries[seat.id] = {
              ...entry,
              count: nextCount,
              lastAt: now,
              lastMsgId: msg.id,
            }
            dirty = true
            woken.push(seat.id)
            try {
              roomChanged()
            } catch {}
            continue
          }

          // Woken MAX_TRIES (2) times and the 2nd wake has settled with still no progress:
          // never wake again; report once to the front desk as an urgent item.
          if (!entry.reported) {
            const secondSettled = lastCall
              ? SETTLED_CALLS.has(lastCall.state)
              : now - entry.lastAt >= Math.min(10_000, Math.max(300, firstWait))
            if (!secondSettled) continue
            const head = owed[0]
            const line = head
              ? `${seat.name} 停了，叫了两次没动：${head.id} ${clip(head.title, 30)}`
              : `${seat.name} 停了，叫了两次没动：未达点名 ${nonRoomCallIds[0]}`
            const sent = noteSeatStalled({
              key: `stalled:${seat.id}:${sig}`,
              projectId: proj.id,
              project: proj.name,
              line,
              ref: head ? { kind: "task", id: head.id } : { kind: "message", id: nonRoomCallIds[0] },
            })
            if (sent) {
              entry.reported = true
              dirty = true
              reported.push(seat.id)
            }
          }
        }
      })
    }

    if (dirty) saveState(now)
    return { woken, reported }
  } finally {
    s.busy = false
  }
}

export function ensureContinue() {
  const s = rt()
  const wantTick = tickMs()
  if (s.timer && s.tickMs === wantTick && s.version === SWEEP_VERSION) return
  if (s.timer) clearInterval(s.timer)
  s.tickMs = wantTick
  s.version = SWEEP_VERSION
  s.timer = setInterval(() => {
    try {
      sweepContinue()
    } catch (error) {
      console.error(error)
    }
  }, wantTick)
  s.timer.unref?.()
}
