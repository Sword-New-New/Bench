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
  blocked: "等着",
  done: "完成",
}

export function liveStatus(
  status: AgentStatus,
  lastSeenAt: number,
  now = Date.now(),
): AgentStatus {
  if (now - lastSeenAt > STALE_MS) return "offline"
  return status
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
