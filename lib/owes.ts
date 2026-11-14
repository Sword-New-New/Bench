import { awaitingReview } from "@/lib/review"
import type { Message, PublicAgent, SeatOwes, Task } from "@/lib/types"

// Seats that have stopped with work still on them. A seat that stops on
// purpose says why (a to-do marked 卡住, a question to the user, a to-do
// waiting for the user's sign-off); one that just went quiet is what this
// finds. Worked out when the snapshot is made and never stored.
//
// Quiet means the room has no sign of it working: no wake running, nothing
// queued for it, not in a wait loop, not in a terminal, not saying it works.
// A seat the room is unsure about gets no verdict either way.
//
// What it owes:
//   - to-dos it owns that are 待接 or 在做 and wait on nobody else;
//   - calls to it that failed or were cut off, with no good wake since (its
//     next wake hands it every message it has not read, so one good wake
//     makes up for them). A call the user stopped or took out of the queue
//     is not owed.
export function owesOf(
  seats: { seat: PublicAgent; wokeAt?: number }[],
  tasks: Task[],
  messages: Message[],
  openAsks: Message[] = [],
) {
  const found = new Map<string, SeatOwes>()
  const asking = new Set<string>()
  for (const message of [...openAsks, ...messages]) {
    if (message.ask?.state === "open" && !message.recalled) asking.add(message.authorId)
  }
  for (const { seat, wokeAt } of seats) {
    if (seat.demo || seat.runId || seat.retry || seat.standby || seat.terminal || seat.queuedCount || seat.unsure !== undefined) continue
    if (seat.status === "working" || seat.status === "blocked") continue
    // It asked the user something: the next move is the user's.
    if (asking.has(seat.id)) continue

    const owed = owedTasks(seat.id, tasks)
    const calls: SeatOwes["calls"] = []
    for (const message of messages) {
      if (message.recalled) continue
      const call = message.calls?.find((item) => item.id === seat.id)
      if (!call || (call.state !== "failed" && call.state !== "cut")) continue
      if (call.at <= (wokeAt ?? 0)) continue
      calls.push({ messageId: message.id, from: message.authorName, state: call.state, at: call.at })
    }
    if (owed.length === 0 && calls.length === 0) continue

    const latest = Math.max(0, ...owed.map((task) => task.updatedAt), ...calls.map((call) => call.at))
    found.set(seat.id, {
      since: Math.max(seat.lastSeenAt, seat.ranUntil ?? 0, latest),
      tasks: owed.slice(0, 5).map((task) => {
        return { id: task.id, title: task.title, step: stepOf(task) }
      }),
      calls: calls.slice(-5),
    })
  }
  return found
}

// The to-dos a seat owns that are 待接 or 在做 and wait on nobody else: not
// sent for the user's sign-off, not marked 卡住 (that status is neither).
// The same test tells a seat what it still owes when it is woken (lib/summon.ts).
export function owedTasks(seatId: string, tasks: Task[]) {
  return tasks.filter(
    (task) =>
      task.ownerId === seatId &&
      (task.status === "open" || task.status === "doing") &&
      task.review?.state !== "waiting" &&
      !awaitingReview(task),
  )
}

// Where a to-do is: the step being done, or else the next one to do.
export function stepOf(task: Task) {
  return (task.steps?.find((item) => item.state === "doing") ?? task.steps?.find((item) => item.state === "todo"))?.text
}
