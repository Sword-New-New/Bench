import { awaitingReview } from "@/lib/review"
import { collectOpenAsks } from "@/lib/waiting-shared"
import type { Message, PermitRequest, PublicAgent, Task } from "@/lib/types"

// 「你不在的这段时间」: what happened in a room between `since` and now, as a
// few plain lines. Pure: it reads what the room already knows (to-dos, system
// notes, seats), writes nothing and calls no model. The page asks for it
// (GET /api/v1/away) when the user comes back after half an hour away.

export const AWAY_AFTER_MS = 30 * 60_000

export type AwayTarget =
  // A to-do, opened in the full view.
  | { kind: "task"; id: string }
  // The cards already waiting on the user in 「等你定」.
  | { kind: "waiting" }
  // The full view (nothing narrower to point at).
  | { kind: "full" }

export type AwayLine = { key: string; text: string; target: AwayTarget }

export type AwayInput = {
  messages: Message[]
  tasks: Task[]
  agents: Pick<PublicAgent, "name" | "status" | "doing">[]
  permits: PermitRequest[]
  openAsks?: Message[]
  since: number
  now: number
  // How the time a limit resets is written (injected so this file stays pure).
  when: (at: number) => string
}

function clip(text: string, max: number) {
  const line = text.replace(/\s+/g, " ").trim()
  return line.length > max ? `${line.slice(0, max)}…` : line
}

function titles(list: Task[], shown = 3) {
  const names = list.slice(0, shown).map((task) => `「${clip(task.title, 18)}」`)
  return `${names.join("、")}${list.length > shown ? " 等" : ""}`
}

// Calls to a seat that never got going.
const NOT_REACHED = new Set(["failed", "cut"])

export function awayLines(input: AwayInput): AwayLine[] {
  const { since } = input
  const lines: AwayLine[] = []

  const asks = collectOpenAsks(input.messages, input.openAsks).filter((message) => message.createdAt >= since)
  if (asks.length) lines.push({ key: "asks", text: `新问了你 ${asks.length} 个问题`, target: { kind: "waiting" } })

  const permits = input.permits.filter((permit) => permit.at >= since)
  if (permits.length) lines.push({ key: "permits", text: `${permits.length} 个权限等你批`, target: { kind: "waiting" } })

  const review = input.tasks.filter((task) => awaitingReview(task) && (task.review?.at ?? task.updatedAt) >= since)
  if (review.length) {
    lines.push({
      key: "review",
      text: `${review.length} 件做完了，等你验收：${titles(review)}`,
      target: { kind: "task", id: review[0].id },
    })
  }

  // Newest card per seat that ran out of allowance.
  const limited = new Map<string, Message>()
  for (const message of input.messages) {
    if (message.kind !== "system" || message.recalled || !message.limited || message.createdAt < since) continue
    const seen = limited.get(message.limited.agentId)
    if (!seen || seen.createdAt < message.createdAt) limited.set(message.limited.agentId, message)
  }
  // Seats that hit the limit with the same reset time are one line: 「A、B、C 撞到额度，
  // 13:40 恢复」; a reset time that has passed reads 「…撞到过额度，13:40 已恢复」.
  const byReset = new Map<string, { names: string[]; resetsAt?: number }>()
  for (const message of [...limited.values()].sort((a, b) => a.createdAt - b.createdAt)) {
    const run = message.limited!
    const key = run.resetsAt ? String(Math.floor(run.resetsAt / 60_000)) : "none"
    const group = byReset.get(key) ?? { names: [], resetsAt: run.resetsAt }
    group.names.push(run.agentName)
    byReset.set(key, group)
  }
  for (const [key, group] of byReset) {
    const names = group.names.length > 3 ? `${group.names.slice(0, 3).join("、")} 等 ${group.names.length} 个` : group.names.join("、")
    const past = group.resetsAt !== undefined && group.resetsAt <= input.now
    const text = !group.resetsAt
      ? `${names} 撞到额度`
      : past
        ? `${names} 撞到过额度，${input.when(group.resetsAt)} 已恢复`
        : `${names} 撞到额度，${input.when(group.resetsAt)} 恢复`
    lines.push({ key: `limited:${key}`, text, target: { kind: "waiting" } })
  }

  const blocked = input.tasks.filter((task) => {
    if (task.status !== "blocked") return false
    const at = [...task.history].reverse().find((event) => event.action === "卡住")?.at ?? task.updatedAt
    return at >= since
  })
  if (blocked.length) {
    lines.push({
      key: "blocked",
      text: `${blocked.length} 件卡住了：${titles(blocked)}`,
      target: { kind: "task", id: blocked[0].id },
    })
  }

  const accepted = input.tasks.filter((task) => task.review?.state === "passed" && task.review.deputy && task.review.at >= since)
  if (accepted.length) {
    lines.push({
      key: "accepted",
      text: `房间替你收下了 ${accepted.length} 件`,
      target: { kind: "task", id: accepted[0].id },
    })
  }

  // The room waking a seat that stopped with work owed (lib/continue.ts):
  // its notes are system messages from 「并坐」 that carry the wake text.
  const wakes = input.messages.filter((message) => message.kind === "system" && message.authorId === "room" && message.wakeText && message.createdAt >= since)
  if (wakes.length) {
    const stuck = new Set<string>()
    for (const message of wakes) for (const call of message.calls ?? []) if (NOT_REACHED.has(call.state)) stuck.add(call.name)
    lines.push({
      key: "woken",
      text: `房间自己叫 AI 接着做了 ${wakes.length} 次${stuck.size ? `，${[...stuck].join("、")} 没叫动` : ""}`,
      target: { kind: "full" },
    })
  }

  // Seats still at work are only worth a line when something else happened:
  // 「现在还在做」 alone is not a reason to draw the card.
  if (lines.length === 0) return lines
  const working = input.agents.filter((agent) => agent.status === "working")
  if (working.length) {
    const named = working.slice(0, 3).map((agent) => (agent.doing ? `${agent.name}（${clip(agent.doing, 20)}）` : agent.name))
    lines.push({
      key: "working",
      text: `现在还在做：${named.join("、")}${working.length > 3 ? ` 等 ${working.length} 个` : ""}`,
      target: { kind: "full" },
    })
  }
  return lines
}

// What the page shows about the stretch: 「上午 10:17 到现在（3 小时 12 分）」.
export function awayStretch(since: number, now = Date.now()) {
  const date = new Date(since)
  const hour = date.getHours()
  const part = hour < 6 ? "凌晨" : hour < 12 ? "上午" : hour < 13 ? "中午" : hour < 18 ? "下午" : "晚上"
  const h12 = hour % 12 === 0 ? 12 : hour % 12
  const clock = `${part} ${h12}:${String(date.getMinutes()).padStart(2, "0")}`
  const minutes = Math.max(1, Math.round((now - since) / 60_000))
  const long = minutes >= 60 ? `${Math.floor(minutes / 60)} 小时${minutes % 60 ? ` ${minutes % 60} 分` : ""}` : `${minutes} 分`
  const sameDay = new Date(now).toDateString() === date.toDateString()
  return `${sameDay ? "" : `${date.getMonth() + 1} 月 ${date.getDate()} 日 `}${clock} 到现在（${long}）`
}

export type AwayProject = { projectId: string; projectName: string; lines: AwayLine[] }

export type AwayOverview = {
  since: number
  now: number
  // One project: its lines. The front desk: a row per project, the weightiest
  // one or two lines of each.
  scope: "project" | "front"
  lines: AwayLine[]
  projects: AwayProject[]
}

const WEIGHT = ["asks", "permits", "review", "limited", "blocked", "accepted", "woken", "working"]
export function lineWeight(line: AwayLine) {
  const at = WEIGHT.indexOf(line.key.split(":")[0])
  return at < 0 ? WEIGHT.length : at
}
