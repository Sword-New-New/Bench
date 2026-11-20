import type { RelayBatchItem, SignLane, Task, TaskReviewIssue, TaskStep } from "@/lib/types"

// The step a to-do list keeps for the user's sign-off: a short one ending in
// 验收, such as 「jinbao 验收」 or 「等用户验收」, not a step that only mentions
// it. Agents never tick it; the user passes it from the task card.
export function isReviewStep(step: Pick<TaskStep, "text">) {
  const text = step.text.trim()
  return text.length <= 16 && /验收$/.test(text)
}

// The owner asked for review (bench_task_update review). A to-do with only
// its sign-off step left also counts as waiting (awaitingReview), but nobody
// said how to see it work: the room doesn't check it, it asks the owner to.
export function reviewAsked(task: Task) {
  return task.status !== "done" && task.review?.state === "waiting"
}

// A check queued this long without starting goes to another seat.
export function checkStaleMs() {
  const raw = Number(process.env.BENCH_CHECK_STALE_MS)
  return process.env.BENCH_CHECK_STALE_MS && Number.isFinite(raw) && raw > 0 ? raw : 15 * 60_000
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
  if (!reviewAsked(task)) return { lane: "you", why: "负责人还没请验收" }
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
  // Found problems before; fixed and checked again: never passed for the user.
  if (check.prev) return { lane: "look", why: "上次查出问题，改过以后再查通过了，你看一眼" }
  if (check.gaps?.trim()) return { lane: "look", why: `有没验到的：${check.gaps.trim()}` }
  if (check.kind === "look") return { lane: "look", why: `${check.name ?? "检查人"}说要你看一眼` }
  if (check.kind !== "run") return { lane: "look", why: "检查人没写类别" }
  return { lane: "batch", why: `${check.name ?? "检查人"}查过，没问题，跑得出结果` }
}

export const ISSUE_WINDOW_DAYS = 14
export const ISSUE_WINDOW_MS = ISSUE_WINDOW_DAYS * 24 * 60 * 60 * 1000

function firstIssueLine(text: string | undefined, max = 120): string {
  const line = (text ?? "")
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find(Boolean)
  if (!line) return ""
  return line.length > max ? `${line.slice(0, max)}…` : line
}

// Record the check state/verdict when the user passes a task whose check failed,
// could not complete/verify, or never ran for the current review round. Clean
// passes (even kind "look"/"you" or with gaps) stay unmarked.
export function reviewIssueOf(task: Pick<Task, "check" | "review" | "ownerId">): TaskReviewIssue | undefined {
  const check = task.check
  if (!check) {
    return { state: "none", summary: "没检查" }
  }
  if (task.review?.at && check.at < task.review.at) {
    return {
      state: "stale",
      checkBy: check.by,
      checkName: check.name,
      summary: "检查是上一次请验收的，这一轮没重新检查",
    }
  }
  if (check.state === "passed") {
    if (task.ownerId && check.by === task.ownerId) {
      return {
        state: "none",
        checkBy: check.by,
        checkName: check.name,
        summary: "检查人就是负责人，没有独立检查",
      }
    }
    return undefined
  }
  const detail = firstIssueLine(check.note)
  if (check.state === "failed") {
    return {
      state: "failed",
      checkBy: check.by,
      checkName: check.name,
      summary: detail ? `查出问题：${detail}` : "查出问题",
    }
  }
  if (check.state === "unverified") {
    return {
      state: "unverified",
      checkBy: check.by,
      checkName: check.name,
      summary: detail ? `没查出结论：${detail}` : "没查出结论",
    }
  }
  if (check.state === "error") {
    return {
      state: "error",
      checkBy: check.by,
      checkName: check.name,
      summary: detail ? `检查没跑成：${detail}` : "检查没跑成",
    }
  }
  if (check.state === "skipped") {
    return {
      state: "skipped",
      checkBy: check.by,
      checkName: check.name,
      summary: detail ? `没检查：${detail}` : "没检查",
    }
  }
  return {
    state: check.state,
    checkBy: check.by,
    checkName: check.name,
    summary: check.state === "running" ? "检查还在跑，还没出结论" : "检查还在排队，还没查",
  }
}

export function isRecentIssuePass(task: Pick<Task, "review">, since: number): boolean {
  return task.review?.state === "passed" && Boolean(task.review.issue) && task.review.at >= since
}

// Keep unsettled rows at the top of a lane while preserving each subgroup's order.
export function sortBatchItems(items: RelayBatchItem[]): RelayBatchItem[] {
  return [...items.filter((item) => !item.state), ...items.filter((item) => Boolean(item.state))]
}

// Only unsettled "you" items remain once the batch/look lanes are settled:
// the card stops counting as open (won't block or fold into a newer list),
// while the remaining "you" rows stay individually passable.
export function batchOnlyYouLeft(items: RelayBatchItem[]): boolean {
  return items.every((item) => Boolean(item.state) || item.lane === "you")
}

export function batchCounts(items: RelayBatchItem[]) {
  let remBatch = 0
  let remLook = 0
  let remYou = 0
  let passed = 0
  let skipped = 0
  for (const item of items) {
    if (item.state === "passed") {
      passed += 1
    } else if (item.state === "skipped") {
      skipped += 1
    } else if (item.lane === "batch") {
      remBatch += 1
    } else if (item.lane === "look") {
      remLook += 1
    } else {
      remYou += 1
    }
  }
  const remManual = remLook + remYou
  const remTotal = remBatch + remManual
  const settled = passed + skipped
  return {
    total: items.length,
    passed,
    skipped,
    settled,
    remBatch,
    remLook,
    remYou,
    remManual,
    remTotal,
  }
}

export function batchRemainingText(items: RelayBatchItem[]): string {
  const { total, settled, remBatch, remLook, remYou, remManual, remTotal } = batchCounts(items)
  if (total === 0) return ""
  if (remTotal === 0) return "这批都处理完了"
  if (settled === 0 && remBatch > 0) return ""
  if (remBatch === 0 && remManual > 0) {
    return `还剩 ${remManual} 件要你自己看（要你看 ${remLook} 件、只能你签 ${remYou} 件）`
  }
  if (remManual > 0) {
    return `还剩 ${remTotal} 件未处理（可整批 ${remBatch} 件；还剩 ${remManual} 件要你自己看：要你看 ${remLook} 件、只能你签 ${remYou} 件）`
  }
  return `还剩 ${remTotal} 件未处理（可整批 ${remBatch} 件）`
}
