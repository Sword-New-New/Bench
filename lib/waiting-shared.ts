import type { DigestRow } from "@/lib/digest"
import type { Message, PermitRequest, TaskCheck } from "@/lib/types"

// Pure helpers shared by GET /api/v1/waiting (server) and WaitingPanel (client)
// so both single-project and front-desk views filter and label items identically.

export type WaitingItemMeta = {
  projectId: string
  projectName: string
}

export type WaitingPermit = WaitingItemMeta & { permit: PermitRequest }
export type WaitingAsk = WaitingItemMeta & { message: Message }
export type WaitingLimited = WaitingItemMeta & { message: Message }
export type WaitingInterrupted = WaitingItemMeta & { message: Message }
export type WaitingReview = WaitingItemMeta & { row: DigestRow }

export type WaitingOverview = {
  permits: WaitingPermit[]
  asks: WaitingAsk[]
  limited: WaitingLimited[]
  interrupted: WaitingInterrupted[]
  reviews: WaitingReview[]
  workingTotal: number
}

export function isPendingLimited(message: Message): boolean {
  return (
    message.kind === "system" &&
    !message.recalled &&
    Boolean(message.limited) &&
    (message.limited?.state === "open" || message.limited?.state === "failed")
  )
}

export function isPendingInterrupted(message: Message): boolean {
  return (
    message.kind === "system" &&
    !message.recalled &&
    Array.isArray(message.interrupted) &&
    message.interrupted.some((item) => !item.resumedAt)
  )
}

export function collectOpenAsks(messages: Message[], openAsks?: Message[]): Message[] {
  const map = new Map<string, Message>()
  for (const m of openAsks ?? []) {
    if (m.ask?.state === "open" && !m.recalled) map.set(m.id, m)
  }
  for (const m of messages) {
    if (m.ask?.state === "open" && !m.recalled) map.set(m.id, m)
  }
  return [...map.values()].sort((a, b) => a.createdAt - b.createdAt)
}

export function reviewCheckSummary(check?: Pick<TaskCheck, "state" | "kind" | "gaps">): string {
  if (!check || check.state === "skipped") return ""
  if (check.state === "queued" || check.state === "running") return "另一个 AI 正在查"
  if (check.state === "failed") return "另一个 AI 查出问题"
  // The check did not get to a verdict: not a pass, not a finding either.
  if (check.state === "error" || check.state === "unverified") return "另一个 AI 没查出结论，要你看一眼"
  if (check.state === "passed") {
    if (check.kind === "look" || check.kind === "you" || Boolean(check.gaps)) {
      return "另一个 AI 查过，要你看一眼"
    }
    return "另一个 AI 查过，没问题"
  }
  return ""
}
