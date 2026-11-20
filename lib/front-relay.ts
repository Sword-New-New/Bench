import { ApiError, asRecord, asString } from "@/lib/http"
import { awaitingReview, batchOnlyYouLeft, signLane, stricterLane } from "@/lib/review"
import {
  actOnTask,
  inProject,
  postFrontNudge,
  postRelayCard,
  relayCard,
  requireFrontSeat,
  resolveProjectInfo,
  say,
  setRelay,
  snapshot,
  userName,
} from "@/lib/store"
import type { RelayBatchItem, RelayDraft, SignLane, Task } from "@/lib/types"
import { getWatchedProject, markWatchNudged } from "@/lib/watch"

// The front desk's legwork (t_e8af4882). Its AI drafts; the user decides.
//  - relay: the user's words, carried to a seat in some project;
//  - nudge: asking a seat that stopped with work owed where it stands;
//  - review: a to-do there waiting for the user's verdict.
// Each lands as a card in the desk's chat. Nothing reaches the project until
// the user clicks: 「发出」 posts it there as the user, signed as carried by the
// desk, and wakes that seat; 「通过」 is the user's own verdict on the to-do.
// The desk can't send, pass or approve anything by itself.

const TEXT_MAX = 2000
const DEFAULT_WATCH_NUDGE_GAP_MS = 30 * 60_000

export function watchNudgeGapMs(): number {
  const raw = process.env.BENCH_WATCH_NUDGE_GAP_MS
  if (raw === undefined || raw === "") return DEFAULT_WATCH_NUDGE_GAP_MS
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_WATCH_NUDGE_GAP_MS
}

type Target = { id: string; name: string }

function targetProject(ref: string | undefined, desk: string): Target {
  if (!ref) throw new ApiError(400, "要填 project（项目名字或 id）")
  const info = resolveProjectInfo(ref)
  if (info.id === desk || info.front) throw new ApiError(400, "前台里不用转达，直接回答用户就行")
  return { id: info.id, name: info.name }
}

function seatIn(project: Target, ref: string | undefined) {
  if (!ref) throw new ApiError(400, "要填 seat（那个项目里的席位名）")
  const name = ref.replace(/^@/, "")
  const seat = inProject(project.id, () => snapshot().agents.find((item) => item.id === name || item.name === name))
  if (!seat) throw new ApiError(404, `「${project.name}」里没有叫 ${name} 的席位`)
  if (seat.demo) throw new ApiError(400, `${seat.name} 是演示席位，叫不醒`)
  return seat
}

function taskIn(project: Target, ref: string | undefined) {
  if (!ref) return undefined
  const task = inProject(project.id, () => snapshot().tasks.find((item) => item.id === ref))
  if (!task) throw new ApiError(404, `「${project.name}」里没有待办 ${ref}`)
  return task
}

function clipText(value: string, max: number) {
  const clean = value.trim()
  return clean.length > max ? `${clean.slice(0, max)}…` : clean
}

function draftText(value: unknown) {
  const text = asString(value)?.trim()
  if (!text) throw new ApiError(400, "要填 text：发过去的原话")
  if (text.length > TEXT_MAX) throw new ApiError(400, `原话最长 ${TEXT_MAX} 字`)
  // The seat's name is put in front when it is sent; one written in would
  // call it twice, or call someone else.
  return text.replace(/^@\S+\s*/, "")
}

// The desk's seat drafts. Returns the card's message id.
export function draftRelay(input: unknown) {
  const desk = requireFrontSeat(input)
  const body = asRecord(input)
  const kind = asString(body.kind) ?? "relay"
  const why = clipText(asString(body.why) ?? "", 200) || undefined
  if (kind === "batch") return draftBatch(desk, body.items, why)
  return inProject(desk.frontProjectId, () => {
    const project = targetProject(asString(body.project), desk.frontProjectId)
    let relay: RelayDraft
    let line: string
    if (kind === "relay") {
      const seat = seatIn(project, asString(body.seat))
      const text = draftText(body.text)
      relay = { kind, project: project.id, projectName: project.name, seatId: seat.id, seatName: seat.name, text, why, state: "draft" }
      line = `起草了一条转达：发给「${project.name}」的 ${seat.name}，等你确认。`
    } else if (kind === "nudge") {
      const seat = seatIn(project, asString(body.seat))
      const task = taskIn(project, asString(body.task))
      const given = asString(body.text)?.trim()
      const about = task ? `「${task.title}」（${task.id}）` : "手上的活"
      const text = given ? draftText(given) : `${about}现在到哪了？能接着做就接着做；要等别人就标卡住，写明原因。`
      const watched = getWatchedProject(project.id)
      const directToCoord = Boolean(watched && watched.seatId === seat.id)
      if (directToCoord) {
        const now = Date.now()
        const gap = watchNudgeGapMs()
        if (watched?.lastNudgeAt && now - watched.lastNudgeAt < gap) {
          const leftMin = Math.max(1, Math.ceil((gap - (now - watched.lastNudgeAt)) / 60_000))
          throw new ApiError(429, `「${project.name}」30 分钟内刚直接催过一次（还需等约 ${leftMin} 分钟），先等 ${seat.name} 回应`)
        }
        const sent = inProject(project.id, () => postFrontNudge(seat.id, seat.name, text, task?.id))
        markWatchNudged(project.id, now)
        relay = {
          kind,
          project: project.id,
          projectName: project.name,
          seatId: seat.id,
          seatName: seat.name,
          taskId: task?.id,
          taskTitle: task?.title,
          text,
          why,
          state: "sent",
          sentId: sent.id,
          settledAt: now,
        }
        line = `已去「${project.name}」催了一下统筹 ${seat.name}（以前台名义直接发出）。`
        const message = postRelayCard(desk.seatId, why ? `${line}${why}` : line, relay)
        return { messageId: message.id, relay, direct: true, sent: { id: sent.id, project: project.id } }
      }
      relay = {
        kind,
        project: project.id,
        projectName: project.name,
        seatId: seat.id,
        seatName: seat.name,
        taskId: task?.id,
        taskTitle: task?.title,
        text,
        why,
        state: "draft",
      }
      line = `想去「${project.name}」催一下 ${seat.name}，等你确认。`
    } else if (kind === "review") {
      const task = taskIn(project, asString(body.task) ?? undefined)
      if (!task) throw new ApiError(400, "要填 task：等验收的待办 id")
      if (!awaitingReview(task)) throw new ApiError(400, `${task.id} 现在不在等验收`)
      relay = {
        kind,
        project: project.id,
        projectName: project.name,
        seatId: task.ownerId ?? undefined,
        seatName: task.ownerName ?? undefined,
        taskId: task.id,
        taskTitle: task.title,
        text: task.review?.note,
        why,
        state: "draft",
      }
      line = `「${project.name}」的 ${task.id} 在等你验收。`
    } else {
      throw new ApiError(400, "kind 只能是 relay、nudge、review 或 batch")
    }
    const message = postRelayCard(desk.seatId, why ? `${line}${why}` : line, relay)
    return { messageId: message.id, relay }
  })
}

const BATCH_MAX = 80
const LANES = new Set<SignLane>(["batch", "look", "you"])
const TIGHTENED = "前台改严了"

// Older lists still open in the desk when a new one is drafted: what still
// waits on them moves onto the new one and they close, so the desk's chat
// holds one current list, not several that repeat each other (the desk is
// woken each time a project's checks settle, and drafts a list each time).
// Lanes are worked out again; one the desk had tightened stays tightened. A
// list too long to merge stays open as it is.
function carryOpenBatches(frontProjectId: string, items: RelayBatchItem[], seen: Set<string>) {
  const open = inProject(frontProjectId, () =>
    snapshot().messages.filter((message) => !message.recalled && message.relay?.kind === "batch" && message.relay.state === "draft"),
  )
  const closing: string[] = []
  let carried = 0
  for (const card of open) {
    const moving: RelayBatchItem[] = []
    for (const old of card.relay?.items ?? []) {
      if (old.state || seen.has(`${old.project}:${old.taskId}`)) continue
      let task: Task | undefined
      try {
        task = inProject(old.project, () => snapshot().tasks.find((item) => item.id === old.taskId))
      } catch {
        continue
      }
      if (!task || !awaitingReview(task)) continue
      const worked = signLane(task)
      const lane = old.why?.startsWith(TIGHTENED) ? stricterLane(worked.lane, old.lane) : worked.lane
      moving.push({
        ...old,
        title: task.title,
        lane,
        why: lane === worked.lane ? worked.why : `${TIGHTENED}（房间算的是：${worked.why}）`,
        note: task.review?.note,
        checkNote: task.check?.note,
        checkName: task.check?.name,
      })
    }
    if (items.length + moving.length > BATCH_MAX) continue
    for (const item of moving) {
      seen.add(`${item.project}:${item.taskId}`)
      items.push(item)
    }
    carried += moving.length
    closing.push(card.id)
  }
  return { closing, carried }
}

// A list of to-dos waiting on the user, across projects, sorted into lanes.
// The room works each lane out again (signLane): the desk can make one
// stricter, never looser. Items not waiting any more are left out and named.
function draftBatch(desk: { seatId: string; frontProjectId: string }, raw: unknown, why: string | undefined) {
  if (!Array.isArray(raw) || raw.length === 0) throw new ApiError(400, "items 要是一个非空数组：[{project, taskId, lane, line}]")
  if (raw.length > BATCH_MAX) throw new ApiError(400, `一张卡片最多 ${BATCH_MAX} 件`)
  const items: RelayBatchItem[] = []
  const left: { taskId: string; why: string }[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    const record = asRecord(entry)
    const taskId = asString(record.taskId) ?? asString(record.task) ?? ""
    const ref = asString(record.project)
    let project: Target
    try {
      project = targetProject(ref, desk.frontProjectId)
    } catch (error) {
      left.push({ taskId, why: (error as Error).message })
      continue
    }
    const task = inProject(project.id, () => snapshot().tasks.find((item) => item.id === taskId))
    if (!task) {
      left.push({ taskId, why: `「${project.name}」里没有这条待办` })
      continue
    }
    if (!awaitingReview(task)) {
      left.push({ taskId, why: "不在等验收" })
      continue
    }
    const key = `${project.id}:${task.id}`
    if (seen.has(key)) continue
    seen.add(key)
    const given = asString(record.lane) as SignLane | undefined
    const worked = signLane(task)
    const lane = stricterLane(worked.lane, given && LANES.has(given) ? given : undefined)
    items.push({
      project: project.id,
      projectName: project.name,
      taskId: task.id,
      title: task.title,
      lane,
      line: clipText(asString(record.line) ?? "", 160),
      why: lane === worked.lane ? worked.why : `${TIGHTENED}（房间算的是：${worked.why}）`,
      note: task.review?.note,
      checkNote: task.check?.note,
      checkName: task.check?.name,
    })
  }
  if (items.length === 0) throw new ApiError(400, `没有一件还在等验收：${left.map((item) => `${item.taskId} ${item.why}`).join("；")}`)
  const { closing, carried } = carryOpenBatches(desk.frontProjectId, items, seen)
  return inProject(desk.frontProjectId, () => {
    const names = [...new Set(items.map((item) => item.projectName))]
    const count = (lane: SignLane) => items.filter((item) => item.lane === lane).length
    const relay: RelayDraft = {
      kind: "batch",
      project: desk.frontProjectId,
      projectName: names.length === 1 ? names[0] : `${names.length} 个项目`,
      items,
      why,
      state: "draft",
    }
    const line = `${items.length} 件等你验收：可整批 ${count("batch")}，要你看 ${count("look")}，只能你签 ${count("you")}。`
    const message = postRelayCard(desk.seatId, line, relay)
    const now = Date.now()
    for (const id of closing) {
      const old = relayCard(id)?.relay
      if (old) setRelay(id, { ...old, state: "dropped", settledAt: now, replacedBy: message.id })
    }
    return { messageId: message.id, relay, left, replaced: closing.length, carried }
  })
}

// The user passing some of a batch card's items: each as their own pass in
// its project (no lane or switch applies; it is the user's click). One that
// can't be passed any more is marked skipped with why. The card settles once
// every item has.
function passBatch(messageId: string, relay: RelayDraft, raw: unknown, now: number) {
  if (!Array.isArray(raw) || raw.length === 0) throw new ApiError(400, "taskIds 要是非空数组")
  const wanted = new Set(raw.map((item) => asString(item)).filter((item): item is string => Boolean(item)))
  const items = (relay.items ?? []).map((item) => {
    if (!wanted.has(item.taskId) || item.state) return item
    try {
      inProject(item.project, () => actOnTask({ as: "human", taskId: item.taskId, action: "pass" }))
      return { ...item, state: "passed" as const }
    } catch (error) {
      return { ...item, state: "skipped" as const, note: (error as Error).message }
    }
  })
  const unknown = [...wanted].filter((id) => !items.some((item) => item.taskId === id))
  if (unknown.length) throw new ApiError(404, `卡片上没有 ${unknown.join("、")}`)
  // Once batch/look lanes have no unsettled items left (at most "you" rows
  // remain), the card is settled so it won't block or fold into newer cards,
  // while remaining "you" rows can still be passed one by one below.
  const settled = batchOnlyYouLeft(items)
  const next: RelayDraft = { ...relay, items, ...(settled ? { state: "passed" as const, settledAt: now } : {}) }
  setRelay(messageId, next)
  return { relay: next }
}

function cardOf(messageId: string | undefined) {
  if (!messageId) throw new ApiError(400, "缺少 messageId")
  const message = relayCard(messageId)
  if (!message?.relay) throw new ApiError(404, "没有这张卡片")
  if (message.recalled) throw new ApiError(400, "这张卡片撤回了")
  return { message, relay: message.relay }
}

// The user's click on a card, in the desk (the route checks the page key).
export function settleRelay(input: unknown) {
  const body = asRecord(input)
  if (body.as !== "human") throw new ApiError(403, `只有 ${userName()} 能点`)
  const action = asString(body.action)
  const { message, relay } = cardOf(asString(body.messageId))
  const canPassRemaining =
    relay.kind === "batch" &&
    action === "pass" &&
    relay.state === "passed" &&
    Boolean(relay.items?.some((item) => !item.state))
  if (relay.state !== "draft" && !canPassRemaining) {
    throw new ApiError(
      409,
      relay.state === "sent" ? "已经发出去了" : relay.state === "passed" ? "已经通过了" : relay.replacedBy ? "这张清单换成新的了，看最新的那张" : "已经不发了",
    )
  }
  const now = Date.now()

  if (action === "drop") {
    const next: RelayDraft = { ...relay, state: "dropped", settledAt: now }
    setRelay(message.id, next)
    return { relay: next }
  }

  if (action === "send") {
    if (relay.kind === "batch") throw new ApiError(400, "整批卡片用「通过」")
    if (relay.kind === "review") throw new ApiError(400, "验收卡片用「通过」，或去那个项目里看")
    const text = draftText(body.text ?? relay.text)
    const sent = inProject(relay.project, () => {
      const seat = snapshot().agents.find((item) => item.id === relay.seatId)
      if (!seat) throw new ApiError(404, `${relay.seatName ?? "那个席位"} 已经不在「${relay.projectName}」里了`)
      // Said as the user, who clicked it; marked so the seat knows the desk
      // put it into words.
      return say({ as: "human", text: `@${seat.name} （经前台）${text}` }).message
    })
    const next: RelayDraft = { ...relay, text, state: "sent", sentId: sent.id, settledAt: now }
    setRelay(message.id, next)
    return { relay: next, sent: { id: sent.id, project: relay.project } }
  }

  if (action === "pass" && relay.kind === "batch") return passBatch(message.id, relay, body.taskIds, now)

  if (action === "pass") {
    if (relay.kind !== "review" || !relay.taskId) throw new ApiError(400, "只有验收卡片能点通过")
    const taskId = relay.taskId
    inProject(relay.project, () => actOnTask({ as: "human", taskId, action: "pass" }))
    const next: RelayDraft = { ...relay, state: "passed", settledAt: now }
    setRelay(message.id, next)
    return { relay: next }
  }

  throw new ApiError(400, "action 只能是 send、drop 或 pass")
}

