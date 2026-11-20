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
// One card per seat, however many times it hit the limit: the newest message,
// and how many pending cards it stands for.
export type WaitingLimited = WaitingItemMeta & { message: Message; count: number }
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

// 「同一件事只出一张卡」: a seat that hits the limit again and again leaves a
// card each time (five in two minutes, 2026-11-17). Only the newest is drawn,
// with the number of times; and when the newest one is already dealt with, the
// older ones that never were are dealt with too.
export type LimitedGroup = { message: Message; count: number }

export function groupLimited(messages: Message[]): LimitedGroup[] {
  const bySeat = new Map<string, Message[]>()
  for (const message of messages) {
    if (message.kind !== "system" || message.recalled || !message.limited) continue
    const list = bySeat.get(message.limited.agentId)
    if (list) list.push(message)
    else bySeat.set(message.limited.agentId, [message])
  }
  const groups: LimitedGroup[] = []
  for (const list of bySeat.values()) {
    const ordered = [...list].sort((a, b) => a.createdAt - b.createdAt)
    const latest = ordered[ordered.length - 1]
    if (!isPendingLimited(latest)) continue
    // Only the stretch since the last card that was dealt with: an earlier
    // round of hits that ended in a switch or a wake is closed, not owed.
    let from = ordered.length - 1
    while (from > 0 && isPendingLimited(ordered[from - 1])) from--
    groups.push({ message: latest, count: ordered.length - from })
  }
  return groups.sort((a, b) => a.message.createdAt - b.message.createdAt)
}

// Reviews: what another AI found wrong first, then the ones waiting longest.
export function sortReviews(rows: DigestRow[]): DigestRow[] {
  const rank = (row: DigestRow) => (row.check?.state === "failed" ? 0 : 1)
  return [...rows].sort((a, b) => rank(a) - rank(b) || (a.since ?? a.at) - (b.since ?? b.at))
}

// A question left unanswered for this long is probably about something that
// has moved on: the card asks once more before sending the answer, and the
// seat is told how old the question is.
export const ASK_STALE_MS = 3 * 24 * 3600_000

// Whole days old when it is stale (3 or more), else 0.
export function staleAskDays(askedAt: number, now = Date.now()): number {
  const age = now - askedAt
  return age >= ASK_STALE_MS ? Math.floor(age / (24 * 3600_000)) : 0
}

export type WaitingSection = WaitingItemMeta & {
  permits: WaitingPermit[]
  asks: WaitingAsk[]
  limited: WaitingLimited[]
  interrupted: WaitingInterrupted[]
  reviews: WaitingReview[]
  count: number
  // 0 an AI waits on a permit … 4 only reviews; lower is more urgent.
  rank: number
  // The oldest of what waits here.
  since: number
}

// The front desk: one section per project, the most urgent project first
// (an AI stuck on a permit or a question, then a limit or a restart, then a
// check that found something, then the rest, the longest wait first).
export function sectionsOf(data: WaitingOverview): WaitingSection[] {
  const map = new Map<string, WaitingSection>()
  const at = (meta: WaitingItemMeta) => {
    let section = map.get(meta.projectId)
    if (!section) {
      section = {
        projectId: meta.projectId,
        projectName: meta.projectName,
        permits: [],
        asks: [],
        limited: [],
        interrupted: [],
        reviews: [],
        count: 0,
        rank: 9,
        since: Infinity,
      }
      map.set(meta.projectId, section)
    }
    return section
  }
  const note = (section: WaitingSection, rank: number, since: number) => {
    section.count++
    section.rank = Math.min(section.rank, rank)
    section.since = Math.min(section.since, since)
  }
  for (const item of data.permits) {
    const section = at(item)
    section.permits.push(item)
    note(section, 0, item.permit.at)
  }
  for (const item of data.asks) {
    const section = at(item)
    section.asks.push(item)
    note(section, 1, item.message.createdAt)
  }
  for (const item of data.limited) {
    const section = at(item)
    section.limited.push(item)
    note(section, 2, item.message.createdAt)
  }
  for (const item of data.interrupted) {
    const section = at(item)
    section.interrupted.push(item)
    note(section, 2, item.message.createdAt)
  }
  for (const item of data.reviews) {
    const section = at(item)
    section.reviews.push(item)
    note(section, item.row.check?.state === "failed" ? 3 : 4, item.row.since ?? item.row.at)
  }
  return [...map.values()].sort((a, b) => a.rank - b.rank || a.since - b.since)
}
