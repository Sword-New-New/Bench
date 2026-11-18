import { digestOf } from "@/lib/digest"
import { inProject, listProjects, snapshot } from "@/lib/store"
import {
  collectOpenAsks,
  isPendingInterrupted,
  isPendingLimited,
  type WaitingAsk,
  type WaitingInterrupted,
  type WaitingLimited,
  type WaitingOverview,
  type WaitingPermit,
  type WaitingReview,
} from "@/lib/waiting-shared"

// Read-only cross-project feed of every action waiting on the user right now,
// built directly from each ordinary project's snapshot + digestOf(). Used by
// the first-layer front desk view so every ordinary room's waiting items appear
// in one column.
export function waitingOverview(now = Date.now()): WaitingOverview {
  const permits: WaitingPermit[] = []
  const asks: WaitingAsk[] = []
  const limited: WaitingLimited[] = []
  const interrupted: WaitingInterrupted[] = []
  const reviews: WaitingReview[] = []
  let workingTotal = 0

  for (const project of listProjects()) {
    if (project.front) continue
    inProject(project.id, () => {
      const snap = snapshot()
      const meta = { projectId: project.id, projectName: project.name }
      workingTotal += snap.agents.filter((agent) => agent.status === "working").length

      for (const permit of snap.permits ?? []) {
        permits.push({ ...meta, permit })
      }
      for (const ask of collectOpenAsks(snap.messages, snap.openAsks)) {
        asks.push({ ...meta, message: ask })
      }
      for (const message of snap.messages) {
        if (isPendingLimited(message)) limited.push({ ...meta, message })
        if (isPendingInterrupted(message)) interrupted.push({ ...meta, message })
      }
      const digest = digestOf({
        messages: snap.messages,
        tasks: snap.tasks,
        agents: snap.agents,
        permits: snap.permits ?? [],
        userName: snap.userName,
        now,
      })
      for (const row of digest.you) {
        if (row.need === "review") reviews.push({ ...meta, row })
      }
    })
  }

  return { permits, asks, limited, interrupted, reviews, workingTotal }
}
