import { ApiError, asRecord, asString } from "@/lib/http"
import { awaitingReview, signLane } from "@/lib/review"
import {
  autoAcceptSince,
  deputyPass,
  deputyReopen,
  inProject,
  listProjects,
  requireFrontSeat,
  resolveProjectInfo,
  runBatchCheck,
  setAutoAcceptSince,
  snapshot,
  userName,
} from "@/lib/store"
import type { Task } from "@/lib/types"

// Signing off a to-do for the user (t_96e9a794; one switch since t_491538da).
// Every gate is the room's, on facts it keeps; none trusts what the desk or
// the to-do's owner says:
//   1. the user turned on 「查过没问题的，自动替我收下」 (one for the room);
//   2. the to-do is waiting for review, asked for after the switch went on
//      (the ones already waiting stay for the user's own batch card);
//   3. signLane says batch (check passed, after this ask, by someone other
//      than the owner, nothing unchecked, 跑得出, no guard word in the title);
//   4. there is a why (the room writes it from the check);
//   5. at most DAILY_CAP a day across the whole room.
// Normally the room does it itself the moment a check passes
// (autoAcceptChecked, no AI involved); the desk's bench_accept goes through
// the same gates. A pass is marked as 「前台代签」, said in the project by the
// room, and the user can reopen it. It never commits, pushes, grants a permit
// or answers a question.

export const DAILY_CAP = 30

function startOfDay(now = Date.now()) {
  const day = new Date(now)
  day.setHours(0, 0, 0, 0)
  return day.getTime()
}

type Pass = { project: string; projectName: string; taskId: string; title: string; at: number; why: string; checkName?: string }

// Deputy passes still standing (reopened ones drop out), newest first.
export function deputyPasses(since = 0): Pass[] {
  const out: Pass[] = []
  for (const project of listProjects()) {
    if (project.front) continue
    inProject(project.id, () => {
      for (const task of snapshot().tasks) {
        const review = task.review
        if (review?.state !== "passed" || !review.deputy || review.at < since) continue
        out.push({
          project: project.id,
          projectName: project.name,
          taskId: task.id,
          title: task.title,
          at: review.at,
          why: review.deputy.why,
          checkName: review.deputy.checkName,
        })
      }
    })
  }
  return out.sort((a, b) => b.at - a.at)
}

// Gates 1, 2 (the timing part) and 5, shared by both ways in; null when it may go.
function gateRefusal(task: Task): { status: number; why: string } | null {
  const since = autoAcceptSince()
  if (!since) return { status: 403, why: `没开「查过没问题的，自动替我收下」，请 ${userName()} 自己验收` }
  if (!task.review || task.review.at <= since) {
    return { status: 403, why: `${task.id} 在开关打开之前就在等验收，留给 ${userName()} 自己整批看` }
  }
  const today = deputyPasses(startOfDay()).length
  if (today >= DAILY_CAP) return { status: 429, why: `今天已经代签 ${today} 件，到上限了，剩下的请 ${userName()} 自己看` }
  return null
}

// The switch, from the user's page. Turning it on also queues a check for
// every to-do already waiting without one, so the user's first batch card
// comes with checks done (those are never passed by themselves: gate 2).
export function setAutoAccept(input: unknown) {
  const body = asRecord(input)
  if (body.as !== "human") throw new ApiError(403, `只有 ${userName()} 能改`)
  if (typeof body.on !== "boolean") throw new ApiError(400, "on 要填 true 或 false")
  const was = autoAcceptSince()
  const since = setAutoAcceptSince(body.on)
  const checks = body.on && !was ? runBatchCheck() : null
  return { on: since > 0, since, ...(checks ? { queued: checks.queued } : {}) }
}

// A check just came back (lib/summon.ts): pass the to-do if every gate holds.
// Called in the to-do's project. Quietly does nothing otherwise.
export function autoAcceptChecked(taskId: string) {
  const task = snapshot().tasks.find((item) => item.id === taskId)
  if (!task || !awaitingReview(task) || gateRefusal(task)) return null
  if (signLane(task).lane !== "batch") return null
  const check = task.check
  const why = `${check?.name ?? "另一个 AI"} 查过，没问题，跑得出结果，没有没验到的`
  return deputyPass(task.id, { seatId: "room", seatName: "前台", why, checkBy: check?.by, checkName: check?.name })
}

export function acceptDeputy(input: unknown) {
  const desk = requireFrontSeat(input)
  const body = asRecord(input)
  const ref = asString(body.project)
  if (!ref) throw new ApiError(400, "要填 project（项目名字或 id）")
  const info = resolveProjectInfo(ref)
  if (info.front) throw new ApiError(400, "前台里没有要代签的待办")
  const taskId = asString(body.taskId) ?? asString(body.task)
  if (!taskId) throw new ApiError(400, "要填 taskId")
  const why = asString(body.why)?.trim()
  return inProject(info.id, () => {
    const task = snapshot().tasks.find((item) => item.id === taskId)
    if (!task) throw new ApiError(404, `「${info.name}」里没有待办 ${taskId}`)
    if (!awaitingReview(task)) throw new ApiError(409, `${task.id} 现在不在等验收`)
    const lane = signLane(task)
    if (lane.lane !== "batch") throw new ApiError(403, `${task.id} 不能代签：${lane.why}`)
    if (!why) throw new ApiError(400, "要写 why：凭什么通过（检查到了什么）")
    const refused = gateRefusal(task)
    if (refused) throw new ApiError(refused.status, refused.why)
    const result = deputyPass(task.id, {
      seatId: desk.seatId,
      seatName: desk.seatName,
      why: why.length > 300 ? `${why.slice(0, 300)}…` : why,
      checkBy: task.check?.by,
      checkName: task.check?.name,
    })
    return { task: result.task, messageId: result.message.id }
  })
}

export function reopenDeputy(input: unknown) {
  const body = asRecord(input)
  if (body.as !== "human") throw new ApiError(403, `只有 ${userName()} 能重开`)
  const ref = asString(body.project)
  if (!ref) throw new ApiError(400, "要填 project（项目名字或 id）")
  const info = resolveProjectInfo(ref)
  const taskId = asString(body.taskId)
  if (!taskId) throw new ApiError(400, "要填 taskId")
  return inProject(info.id, () => {
    const result = deputyReopen(taskId)
    return { task: result.task, messageId: result.message.id }
  })
}
