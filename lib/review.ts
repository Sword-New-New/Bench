import type { Task, TaskStep } from "@/lib/types"

// The step a to-do list keeps for the user's sign-off: a short one ending in
// 验收, such as 「jinbao 验收」 or 「等用户验收」, not a step that only mentions
// it. Agents never tick it; the user passes it from the task card.
export function isReviewStep(step: Pick<TaskStep, "text">) {
  const text = step.text.trim()
  return text.length <= 16 && /验收$/.test(text)
}

// Waiting on the user: an agent asked for review, or every step but the
// sign-off is done. Once sent back it waits on the owner until it asks again.
export function awaitingReview(task: Task) {
  if (task.status === "done") return false
  if (task.review?.state === "waiting") return true
  if (task.review?.state === "rejected") return false
  const steps = task.steps ?? []
  const sign = steps.filter(isReviewStep)
  if (sign.length === 0 || sign.every((step) => step.state === "done")) return false
  return steps.every((step) => isReviewStep(step) || step.state === "done")
}
