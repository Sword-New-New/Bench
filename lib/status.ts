import type { AgentStatus, TaskStatus } from "@/lib/types"

export const STALE_MS = 40_000

export const STATUS_LABEL: Record<AgentStatus, string> = {
  idle: "空闲",
  working: "在做",
  blocked: "卡住",
  offline: "离线",
}

export const STATUS_COLOR: Record<AgentStatus, string> = {
  idle: "#22a06b",
  working: "#e08a1e",
  blocked: "#d64545",
  offline: "#9ca3af",
}

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  open: "待接",
  doing: "在做",
  blocked: "卡住",
  done: "完成",
}

/** 统一检查结果与过程提示中的旧措辞，避免历史记录或内部状态在页面露字 */
export function plainCheckText(text: string): string {
  return text
    .replace(/复验没跑成/g, "检查没跑成")
    .replace(/复验没交结论/g, "检查没交结论")
    .replace(/复验没过/g, "查出问题")
    .replace(/复验没验到/g, "没查出结论")
    .replace(/复验通过/g, "查过，没问题")
    .replace(/复验人/g, "检查人")
    .replace(/没开复验/g, "没开检查")
    .replace(/没复验/g, "没检查")
}

export function liveStatus(
  status: AgentStatus,
  lastSeenAt: number,
  now = Date.now(),
): AgentStatus {
  if (now - lastSeenAt > STALE_MS) return "offline"
  return status
}

// How long a seat's own "working" stands without another word from it.
export const CLAIM_MS = 10 * 60_000

// How long a seat is quiet before the page says it stopped with work on it:
// long enough for a handoff or a relay to come back to it.
export const PARKED_MS = 3 * 60_000

export type SeatSigns = {
  // What the seat last said it was doing (or the room said for it), and when.
  status: AgentStatus
  statusAt?: number
  // Its bridge's last pulse or call.
  lastSeenAt: number
  // A wake of the room's is going on, and when the latest one ended.
  running: boolean
  ranUntil?: number
}

// The one place a seat's state is worked out, from what the room has seen,
// strongest sign first. Where the signs don't settle it, it says so (`unsure`)
// instead of picking an answer.
//   1. A wake of the room's is running: working, whatever else.
//   2. "Working" said during a wake ended with that wake: a woken session does
//      nothing once its process is gone. ("Blocked" stays: a question asked
//      in a wake waits on the user after it.)
//   3. No pulse from its bridge for STALE_MS: offline.
//   4. "Working" said long ago with nothing since, though the bridge still
//      pulses: its client is open, whether it works the room cannot tell.
export function seatState(signs: SeatSigns, now = Date.now()): { status: AgentStatus; unsure?: number } {
  if (signs.running) return { status: "working" }
  const over = signs.ranUntil !== undefined && (signs.statusAt ?? 0) <= signs.ranUntil
  const said: AgentStatus = over && signs.status === "working" ? "idle" : signs.status
  if (now - signs.lastSeenAt > STALE_MS) return { status: "offline" }
  if (said === "working" && signs.statusAt !== undefined && now - signs.statusAt > CLAIM_MS) {
    return { status: "working", unsure: signs.statusAt }
  }
  return { status: said }
}

export function ago(ts: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - ts) / 1000))
  if (seconds < 10) return "刚刚"
  if (seconds < 60) return `${seconds} 秒前`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.round(hours / 24)} 天前`
}

// One formatter for all: making one per call was a good part of drawing a
// room (every message and task step shows a time).
const CLOCK = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" })

export function clock(ts: number): string {
  return CLOCK.format(ts)
}
