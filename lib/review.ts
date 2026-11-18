import type { SignLane, Task, TaskStep } from "@/lib/types"

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

// ---- Which lane a waiting to-do is in (t_50597554, lib/deputy.ts) ----
//  batch: the front desk may pass it (and the user may pass a list in one go);
//  look: checked, but the user should look at it;
//  you: only the user signs it.
// Facts only: the check's verdict, timing, checker and category, and the
// title. What the owner wrote (its review note, step notes) never counts.

// Words that keep a to-do with the user, matched on the title only (checked
// on the 37 waiting on 2026-11-16: title only hit 9, all rightly; with the
// notes too, 29 wrongly).
export const GUARD_WORDS = [
  "权限",
  "全权",
  "沙盒",
  "口令",
  "凭证",
  "密钥",
  "key",
  "token",
  "删",
  "清空",
  "付费",
  "花钱",
  "提交",
  "推送",
  "发版",
  "commit",
  "push",
  "release",
  "验收规则",
  "代签",
] as const

export function guardWordIn(title: string) {
  const lower = title.toLowerCase()
  return GUARD_WORDS.find((word) => lower.includes(word))
}

type Lane = SignLane
const STRICTNESS: Record<Lane, number> = { batch: 0, look: 1, you: 2 }

// The stricter of two lanes: the desk may only tighten what the room worked out.
export function stricterLane(a: Lane, b: Lane | undefined): Lane {
  return b && STRICTNESS[b] > STRICTNESS[a] ? b : a
}

export function signLane(task: Task): { lane: Lane; why: string } {
  const word = guardWordIn(task.title)
  if (word) return { lane: "you", why: `标题里有「${word}」，只能你签` }
  // Taken back by the user: nothing passes it for them until the owner asks again.
  if (task.review?.reopened) return { lane: "you", why: "你重开过，等负责人改完再请验收" }
  const check = task.check
  if (!check) return { lane: "you", why: "没跑检查" }
  if (check.state === "queued" || check.state === "running") return { lane: "you", why: "检查还在跑" }
  if (check.state === "failed") return { lane: "you", why: "查出问题" }
  if (check.state === "unverified") return { lane: "you", why: "没查出结论" }
  if (check.state !== "passed") return { lane: "you", why: "检查没跑成" }
  if (!task.review?.at) return { lane: "you", why: "没有请验收的记录" }
  if (check.at < task.review.at) return { lane: "you", why: "检查是上一次请验收的" }
  if (!check.by) return { lane: "you", why: "不知道是谁检查的" }
  if (task.ownerId && check.by === task.ownerId) return { lane: "you", why: "检查人就是负责人" }
  if (check.kind === "you") return { lane: "you", why: `${check.name ?? "检查人"}说只能你签` }
  if (check.gaps?.trim()) return { lane: "look", why: `有没验到的：${check.gaps.trim()}` }
  if (check.kind === "look") return { lane: "look", why: `${check.name ?? "检查人"}说要你看一眼` }
  if (check.kind !== "run") return { lane: "look", why: "检查人没写类别" }
  return { lane: "batch", why: `${check.name ?? "检查人"}查过，没问题，跑得出结果` }
}
