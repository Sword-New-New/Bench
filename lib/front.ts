import { dbCountOpenAsks, dbLoadTalkPage, dbSetMeta } from "@/lib/db"
import { ApiError, asRecord, asString } from "@/lib/http"
import { stepOf } from "@/lib/owes"
import { enqueuePushEvent } from "@/lib/push"
import { awaitingReview, ISSUE_WINDOW_MS, signLane } from "@/lib/review"
import {
  agentState,
  autoAcceptSince,
  FRONT_NOTICE_KEY,
  readFrontNotice,
  brokenCallsInRoom,
  inProject,
  listProjects,
  queryRecentIssueTasks,
  requireFrontSeat,
  resolveProjectInfo,
  snapshot,
  talkLine,
} from "@/lib/store"
import type { CallState, Message, PublicAgent, Task, TaskCheck } from "@/lib/types"
import { getWatchedProject } from "@/lib/watch"

const STATUS_LABEL: Record<PublicAgent["status"], string> = {
  working: "在做",
  blocked: "卡住",
  idle: "空闲",
  offline: "离线",
}

const TASK_STATUS_LABEL: Record<Task["status"], string> = {
  open: "待接",
  doing: "在做",
  blocked: "卡住",
  done: "完成",
}

const CALL_STATE_LABEL: Record<CallState, string> = {
  queued: "排队中",
  held: "待命接管",
  started: "刚启动",
  picked: "已接手",
  answered: "已回复",
  silent: "未发言结束",
  retrying: "网络重试中",
  failed: "唤起失败",
  stopped: "手动停止",
  cut: "中途打断",
  dropped: "已移出队列",
}

const CHECK_STATE_LABEL: Record<string, string> = {
  queued: "排队复验",
  running: "正在复验",
  passed: "复验通过",
  done: "复验完成",
  failed: "复验没过",
  unverified: "复验没验到",
  skipped: "跳过复验",
  error: "复验没跑成",
}

const CHECK_KIND_LABEL: Record<NonNullable<TaskCheck["kind"]>, string> = {
  run: "跑得出",
  look: "要人看",
  you: "只能本人签",
}

// Which lane the room puts a waiting to-do in (lib/review.ts signLane), in the
// desk's words, so it knows what it may sign without trying: the reasons are
// written for the user's card, where 「你」 is the user.
// 「可代签」 only for one asked after the room-wide switch went on (lib/deputy.ts).
function laneText(task: Task, user: string, withReason = true): string {
  const { lane, why } = signLane(task)
  const since = autoAcceptSince()
  if (lane === "batch") {
    if (since && (task.review?.at ?? 0) > since) return "可代签"
    if (!withReason) return "可整批"
    return since ? "可整批（开关打开前就在等，留给用户）" : "可整批（没开自动收下）"
  }
  const tag = lane === "look" ? `要 ${user} 看` : `只能 ${user} 签`
  // The overview has a budget for its whole text: the reason is in bench_peek.
  if (!withReason) return tag
  const reason = why.startsWith("有没验到的") ? why : why.replace(/，只能你签$/, "").replaceAll("你", ` ${user} `).trim()
  return `${tag}（${reason}）`
}

// A project's sign-off settings, for the same reason. The switch is the
// room's: with it on, a project without a chosen checker has one picked.
function signSettings(check: "auto" | undefined, checker: string | undefined, watchedSeat?: string): string {
  const on = autoAcceptSince() > 0
  const watchPart = watchedSeat ? ` ｜ 盯防：统筹 ${watchedSeat}` : ""
  return `复验：${checker ? `指定 ${checker}` : check === "auto" || on ? "自动挑" : "没开"} ｜ 代签：${on ? "开着" : "没开"}${watchPart}`
}

function formatCheckBrief(check: TaskCheck | undefined, withNote = false): string {
  if (!check) return "未复验"
  const state = CHECK_STATE_LABEL[check.state] ?? check.state
  const by = check.name ? `（${check.name}）` : ""
  const kind = check.kind ? ` · 类别：${CHECK_KIND_LABEL[check.kind]}` : ""
  const hasVerdict = check.state === "passed" || check.state === "failed" || check.state === "unverified"
  const gaps = check.gaps
    ? ` · 有没验到的（${flatClip(check.gaps, 40)}）`
    : hasVerdict
      ? " · 无没验到的"
      : ""
  const note = withNote && check.note ? ` — ${flatClip(check.note, 140)}` : ""
  return `${state}${by}${kind}${gaps}${note}`
}

const OVERVIEW_SEAT_COMPACT_THRESHOLD = 4
const OVERVIEW_SUMMARY_CHARS = 240
const OVERVIEW_TEXT_BUDGET = 4500
const PEEK_TEXT_BUDGET = 8000
const PEEK_SUMMARY_COMPACT_CHARS = 600
const PEEK_TALK_COMPACT_LIMIT = 10
const PEEK_TALK_COMPACT_LINE_CHARS = 200
const PEEK_TALK_LIMIT = 30
const STALE_DOING_MS = 24 * 60 * 60_000

type PeekPart = "summary" | "tasks" | "seats" | "talk"
const PEEK_PARTS = new Set<PeekPart>(["summary", "tasks", "seats", "talk"])

function flatClip(value: string | undefined, max: number): string {
  const clean = (value ?? "").replace(/\s+/g, " ").trim()
  if (!clean) return ""
  return clean.length > max ? `${clean.slice(0, max)}…` : clean
}

function blockClip(value: string | undefined, max: number): { text: string; clipped: boolean } {
  const clean = (value ?? "").trim()
  if (!clean) return { text: "", clipped: false }
  if (clean.length <= max) return { text: clean, clipped: false }
  return { text: `${clean.slice(0, max)}…`, clipped: true }
}

// Idle or offline seats whose status note is older than one day don't show that
// stale note in overview or peek (left rail keeps showing it as before).
function freshDoing(seat: PublicAgent, now: number): string {
  const text = (seat.doing ?? "").trim()
  if (!text) return ""
  if (seat.status === "idle" || seat.status === "offline") {
    const raw = agentState(seat.id)
    const at = raw?.statusAt ?? seat.ranUntil ?? seat.createdAt
    if (at > 0 && now - at >= STALE_DOING_MS) return ""
  }
  return text
}

function formatStamp(at: number | undefined): string {
  if (!at || at <= 0) return "未知"
  const d = new Date(at)
  const now = new Date()
  const hhmm = d.toTimeString().slice(0, 5)
  if (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  ) {
    return `今天 ${hhmm}`
  }
  const mm = String(d.getMonth() + 1).padStart(2, "0")
  const dd = String(d.getDate()).padStart(2, "0")
  return `${mm}-${dd} ${hhmm}`
}

function owesCountOf(seat: PublicAgent): number {
  if (!seat.owes) return 0
  return seat.owes.tasks.length + seat.owes.calls.length
}

function isNotableSeat(
  seat: PublicAgent,
  askingIds: ReadonlySet<string>,
  permitSeatIds: ReadonlySet<string>,
  reviewOwnerIds: ReadonlySet<string>,
): boolean {
  if (seat.status === "working" || seat.status === "blocked") return true
  if (seat.unsure !== undefined) return true
  if (owesCountOf(seat) > 0) return true
  if ((seat.queuedCount ?? 0) > 0 || Boolean(seat.retry)) return true
  if (askingIds.has(seat.id) || permitSeatIds.has(seat.id) || reviewOwnerIds.has(seat.id)) return true
  return false
}

function formatOverviewSeat(seat: PublicAgent, now: number): string {
  const parts: string[] = [
    `${seat.name}（${STATUS_LABEL[seat.status] ?? seat.status}${seat.unsure !== undefined ? "·不确定" : ""}）`,
  ]
  const owesCount = owesCountOf(seat)
  if (owesCount > 0) {
    parts.push(`停着还欠 ${owesCount} 件`)
  }
  if (seat.queuedCount) {
    parts.push(`队列 ${seat.queuedCount} 条${seat.queuePaused ? "（已暂停）" : ""}`)
  }
  if (seat.retry) {
    parts.push(`重试 ${seat.retry.n}/${seat.retry.of}`)
  }
  const doing = flatClip(freshDoing(seat, now), 70)
  if (doing) parts.push(doing)
  return `  - ${parts.join(" · ")}`
}

export function frontOverview(input: unknown, now = Date.now()) {
  requireFrontSeat(input)
  const projects = listProjects()
  // Tighter per-project summary cap if there are many rooms, keeping total output well within a few thousand chars.
  const summaryCap =
    projects.length > 8
      ? Math.max(80, Math.floor((OVERVIEW_TEXT_BUDGET - projects.length * 220) / projects.length))
      : OVERVIEW_SUMMARY_CHARS

  let user = "用户"
  const issueSince = now - ISSUE_WINDOW_MS
  const items = projects.map((proj) =>
    inProject(proj.id, () => {
      const snap = snapshot()
      user = snap.userName
      const openAsks = dbCountOpenAsks(proj.id)
      const pendingPermits = snap.permits.length
      const waitingReviewTasks = snap.tasks.filter(awaitingReview)
      const waitingReviews = waitingReviewTasks.length
      const unfinishedTasks = snap.tasks.filter((t) => t.status !== "done").length
      const issuePasses = proj.front ? 0 : queryRecentIssueTasks(issueSince).length

      const askingIds = new Set<string>()
      for (const m of [...(snap.openAsks ?? []), ...snap.messages]) {
        if (m.ask?.state === "open" && !m.recalled) askingIds.add(m.authorId)
      }
      const permitSeatIds = new Set(snap.permits.map((p) => p.agentId))
      const reviewOwnerIds = new Set(
        waitingReviewTasks.flatMap((t) => (t.ownerId ? [t.ownerId] : [])),
      )

      const compactSeats = snap.agents.length > OVERVIEW_SEAT_COMPACT_THRESHOLD
      const shownSeats = compactSeats
        ? snap.agents.filter((s) => isNotableSeat(s, askingIds, permitSeatIds, reviewOwnerIds))
        : snap.agents
      const quietSeats = compactSeats
        ? snap.agents.filter((s) => !isNotableSeat(s, askingIds, permitSeatIds, reviewOwnerIds))
        : []

      const summarySnippet = snap.summary ? flatClip(snap.summary.text, summaryCap) : ""

      return {
        id: proj.id,
        name: proj.name,
        ...(proj.dir ? { dir: proj.dir } : {}),
        ...(proj.front ? { front: true as const } : {}),
        ...(proj.check ? { check: proj.check } : {}),
        lastAt: proj.lastAt,
        lastAtText: formatStamp(proj.lastAt),
        waiting: {
          asks: openAsks,
          permits: pendingPermits,
          reviews: waitingReviews,
          total: openAsks + pendingPermits + waitingReviews,
        },
        waitingReviews: waitingReviewTasks.map((t) => ({
          id: t.id,
          title: t.title,
          ownerName: t.ownerName,
          checkState: t.check?.state ?? null,
          checkKind: t.check?.kind ?? null,
          hasGaps: Boolean(t.check?.gaps),
          ...(t.check?.gaps ? { gaps: t.check.gaps } : {}),
          lane: signLane(t).lane,
          laneText: laneText(t, snap.userName, false),
        })),
        signSettings: proj.front
          ? ""
          : signSettings(proj.check, snap.agents.find((seat) => seat.checker)?.name, getWatchedProject(proj.id)?.seatName),
        issuePasses,
        unfinishedTasks,
        seatTotal: snap.agents.length,
        seats: shownSeats.map((s) => ({
          name: s.name,
          status: s.status,
          doing: flatClip(freshDoing(s, now), 90),
          owesCount: owesCountOf(s),
          unsure: s.unsure !== undefined,
        })),
        quietSeatNames: quietSeats.map((s) => s.name),
        summaryHead: summarySnippet,
        seatLines: shownSeats.map((s) => formatOverviewSeat(s, now)),
      }
    }),
  )

  const totalIssuePasses = items.reduce((sum, item) => sum + item.issuePasses, 0)

  // Over the budget, the summaries go first: what waits on the user in every
  // project matters more to the desk than how each summary starts. Only then
  // is the text cut from the end.
  const render = (withSummary: boolean) => {
    const blocks: string[] = [
      `并坐全部项目一览（共 ${items.length} 个项目，用户：${user}｜近 14 天带着问题收下：${totalIssuePasses} 件）${withSummary ? "" : "\n（内容太长，各项目的摘要开头没列，要看用 bench_peek）"}`,
    ]
    for (const item of items) {
      const tag = item.front ? " [前台]" : ""
      const dirPart = item.dir ? ` · 目录 ${item.dir}` : ""
      const issuePart = item.issuePasses > 0 ? ` ｜ 带着问题收下 ${item.issuePasses} 件` : ""
      const lines: string[] = [
        `\n■ ${item.name}（${item.id}）${tag}${dirPart}`,
        `  最后动静：${item.lastAtText} ｜ 未完待办：${item.unfinishedTasks} ｜ 等 ${user}：提问 ${item.waiting.asks} · 权限 ${item.waiting.permits} · 验收 ${item.waiting.reviews}${item.signSettings ? ` ｜ ${item.signSettings}` : ""}${issuePart}`,
      ]
      if (item.waitingReviews.length > 0) {
        for (const r of item.waitingReviews.slice(0, 6)) {
          const stateText = r.checkState ? CHECK_STATE_LABEL[r.checkState] ?? r.checkState : "未复验"
          const kindText = r.checkKind ? `·${CHECK_KIND_LABEL[r.checkKind]}` : ""
          const gapText = r.hasGaps ? "·有没验到的" : r.checkState === "passed" || r.checkState === "failed" || r.checkState === "unverified" ? "·无没验到的" : ""
          lines.push(`  - 等验收 [${r.id}] ${flatClip(r.title, 26)}：${stateText}${kindText}${gapText} → ${r.laneText}`)
        }
        if (item.waitingReviews.length > 6) {
          lines.push(`  - 另有 ${item.waitingReviews.length - 6} 件等验收（用 bench_peek 查看）`)
        }
      }
      if (item.seatTotal === 0) {
        lines.push("  席位：暂无席位")
      } else {
        for (const line of item.seatLines) {
          lines.push(line)
        }
        if (item.quietSeatNames.length > 0) {
          const names =
            item.quietSeatNames.length > 8
              ? `${item.quietSeatNames.slice(0, 8).join("、")} 等 ${item.quietSeatNames.length} 个`
              : item.quietSeatNames.join("、")
          lines.push(`  - 其余无事席位（${item.quietSeatNames.length}）：${names}`)
        }
      }
      if (withSummary && item.summaryHead) {
        lines.push(`  摘要开头：${item.summaryHead}`)
      }
      blocks.push(lines.join("\n"))
    }
    return blocks.join("\n")
  }

  let text = render(true)
  if (text.length > OVERVIEW_TEXT_BUDGET) text = render(false)
  if (text.length > OVERVIEW_TEXT_BUDGET) {
    text = `${text.slice(0, OVERVIEW_TEXT_BUDGET)}…（已截断，用 bench_peek 查看单个项目完整详情）`
  }

  return {
    userName: user,
    issuePasses: totalIssuePasses,
    projects: items.map(({ seatLines: _lines, signSettings: _settings, ...pub }) => {
      void _lines
      void _settings
      return { ...pub, waitingReviews: pub.waitingReviews.map(({ laneText: _text, ...review }) => (void _text, review)) }
    }),
    text,
  }
}

function collectOpenAsks(openAsks: Message[] | undefined, hotMessages: Message[]): Message[] {
  const seen = new Set<string>()
  const list: Message[] = []
  for (const m of [...(openAsks ?? []), ...hotMessages]) {
    if (m.recalled || m.ask?.state !== "open" || seen.has(m.id)) continue
    seen.add(m.id)
    list.push(m)
  }
  return list.sort((a, b) => a.seq - b.seq)
}

function formatTaskDetail(task: Task, oneLine = false): string {
  const steps = task.steps ?? []
  const doneCount = steps.filter((s) => s.state === "done").length
  const progress = steps.length > 0 ? `步骤 ${doneCount}/${steps.length}` : "无步骤"
  const cur = stepOf(task)
  const curText = cur ? ` · 当前：「${flatClip(cur, 50)}」` : ""
  const owner = task.ownerName ? `负责人 ${task.ownerName}` : "未认领"
  const rev =
    task.review?.state === "waiting"
      ? ` · 等验收${task.review.note ? `（${flatClip(task.review.note, 80)}）` : ""}`
      : task.review?.state === "rejected"
        ? ` · 已打回${task.review.note ? `（原因：${flatClip(task.review.note, 80)}）` : ""}`
        : ""
  const chk = task.check ? ` · 复验[${formatCheckBrief(task.check, true)}]` : ""
  const title = oneLine ? flatClip(task.title, 50) : task.title.replace(/\s+/g, " ").trim()
  return `- [${task.id}] ${title} ｜ ${TASK_STATUS_LABEL[task.status] ?? task.status} ｜ ${owner} ｜ ${progress}${curText}${rev}${chk}`
}

function compactTalkLine(message: Message): string {
  const body = flatClip(message.text, PEEK_TALK_COMPACT_LINE_CHARS)
  const att = message.attachments?.length ? `${body ? " " : ""}[附件 ${message.attachments.length} 个]` : ""
  return talkLine({ ...message, text: `${body}${att}`, wakeText: undefined, attachments: undefined }, true)
}

function paginateEntries(
  header: string,
  sectionTitle: string,
  entries: string[],
  part: PeekPart,
  page: number,
  emptyLabel = "（没有）",
): { text: string; page: number; totalPages: number; hasMore: boolean } {
  if (entries.length === 0) {
    return {
      text: `${header}\n\n${sectionTitle}\n${emptyLabel}`,
      page: 1,
      totalPages: 1,
      hasMore: false,
    }
  }
  const chunkBudget = Math.max(800, PEEK_TEXT_BUDGET - header.length - sectionTitle.length - 120)
  const pieces: string[] = []
  for (const entry of entries) {
    if (entry.length <= chunkBudget) {
      pieces.push(entry)
    } else {
      for (let i = 0; i < entry.length; i += chunkBudget) {
        pieces.push(entry.slice(i, i + chunkBudget))
      }
    }
  }
  const pages: string[][] = []
  let cur: string[] = []
  let curLen = 0
  for (const p of pieces) {
    const addLen = (cur.length > 0 ? 1 : 0) + p.length
    if (cur.length > 0 && curLen + addLen > chunkBudget) {
      pages.push(cur)
      cur = [p]
      curLen = p.length
    } else {
      cur.push(p)
      curLen += addLen
    }
  }
  if (cur.length > 0) pages.push(cur)

  const totalPages = pages.length
  if (page > totalPages) {
    return {
      text: `${header}\n\n${sectionTitle}\n（已超出末页：共 ${totalPages} 页）`,
      page,
      totalPages,
      hasMore: false,
    }
  }
  const bodyText = pages[page - 1].join("\n")
  const hasMore = page < totalPages
  const footer =
    totalPages > 1
      ? `\n（第 ${page}/${totalPages} 页${hasMore ? `；看下一页传 part="${part}", page=${page + 1}` : "，已到末页"}）`
      : ""
  return {
    text: `${header}\n\n${sectionTitle}\n${bodyText}${footer}`,
    page,
    totalPages,
    hasMore,
  }
}

function fitPrefixLines(
  header: string,
  summarySec: string,
  waitTitle: string,
  waitLines: string[],
  taskTitle: string,
  taskLines: string[],
  seatTitle: string,
  seatLines: string[],
  brokenTitle: string,
  callLines: string[],
  maxBudget: number,
): string {
  const build = (w: string[], t: string[], s: string[], c: string[], notes: { w?: string; t?: string; s?: string; c?: string } = {}) => {
    const parts = [
      header,
      summarySec,
      `\n${waitTitle}\n${w.length > 0 ? w.join("\n") : "（没有）"}${notes.w ?? ""}`,
      `\n${taskTitle}\n${t.length > 0 ? t.join("\n") : "（没有）"}${notes.t ?? ""}`,
      `\n${seatTitle}\n${s.length > 0 ? s.join("\n") : "（暂无席位）"}${notes.s ?? ""}`,
      `\n${brokenTitle}\n${c.length > 0 ? c.join("\n") : "（没有）"}${notes.c ?? ""}`,
    ]
    return parts.join("\n")
  }

  const fullPrefix = build(waitLines, taskLines, seatLines, callLines)
  if (fullPrefix.length <= maxBudget) return fullPrefix

  // Trim broken calls, then seats, then other unfinished tasks, then waiting items if needed.
  const cKept = [...callLines]
  const sKept = [...seatLines]
  const tKept = [...taskLines]
  const wKept = [...waitLines]
  const makeNotes = () => ({
    c: cKept.length < callLines.length ? `\n…（另有 ${callLines.length - cKept.length} 条未列，传 part="seats" 查看）` : "",
    s: sKept.length < seatLines.length ? `\n…（另有 ${seatLines.length - sKept.length} 个席位未列，传 part="seats" 查看）` : "",
    t: tKept.length < taskLines.length ? `\n…（另有 ${taskLines.length - tKept.length} 件待办未列，传 part="tasks" 查看）` : "",
    w: wKept.length < waitLines.length ? `\n…（另有 ${waitLines.length - wKept.length} 件未列，传 part="tasks" 查看）` : "",
  })

  for (const arr of [cKept, sKept, tKept, wKept]) {
    while (arr.length > 0 && build(wKept, tKept, sKept, cKept, makeNotes()).length > maxBudget) {
      arr.pop()
    }
    if (build(wKept, tKept, sKept, cKept, makeNotes()).length <= maxBudget) break
  }

  const trimmed = build(wKept, tKept, sKept, cKept, makeNotes())
  return trimmed.length <= maxBudget ? trimmed : `${trimmed.slice(0, Math.max(0, maxBudget - 20))}…`
}

export function frontPeek(input: unknown, now = Date.now()) {
  requireFrontSeat(input)
  const body = asRecord(input)
  const projectRef = asString(body.project)
  if (!projectRef) throw new ApiError(400, "要填 project（项目名字或 id）")
  let beforeSeq: number | undefined
  if (body.before !== undefined && body.before !== null && body.before !== "") {
    const num = Number(body.before)
    if (!Number.isFinite(num) || num <= 0) {
      throw new ApiError(400, "before 要是一个大于 0 的消息序号 seq")
    }
    beforeSeq = Math.floor(num)
  }
  const rawPart = asString(body.part)
  let part: PeekPart | undefined
  if (rawPart) {
    if (!PEEK_PARTS.has(rawPart as PeekPart)) {
      throw new ApiError(400, "part 只能是 summary、tasks、seats 或 talk")
    }
    part = rawPart as PeekPart
  }
  let page = 1
  if (body.page !== undefined && body.page !== null && body.page !== "") {
    const num = Number(body.page)
    if (!Number.isFinite(num) || num < 1 || !Number.isInteger(num)) {
      throw new ApiError(400, "page 要是大于等于 1 的整数页码")
    }
    page = num
  }
  const full = body.full === true

  const target = resolveProjectInfo(projectRef)
  return inProject(target.id, () => {
    const snap = snapshot()
    const user = snap.userName
    const unfinished = snap.tasks.filter((t) => t.status !== "done")
    const openAsks = collectOpenAsks(snap.openAsks, snap.messages)
    const waitingReviews = snap.tasks.filter(awaitingReview)
    const reviewIds = new Set(waitingReviews.map((t) => t.id))
    const otherUnfinished = unfinished.filter((t) => !reviewIds.has(t.id))
    const brokenCalls = brokenCallsInRoom()

    const header = `【项目「${target.name}」（${target.id}）】${target.front ? " [前台]" : ""}${target.dir ? ` · 目录：${target.dir}` : ""}${
      target.front
        ? ""
        : ` · ${signSettings(target.check, snap.agents.find((seat) => seat.checker)?.name, getWatchedProject(target.id)?.seatName)}`
    }`

    const formatSeat = (s: PublicAgent, compact = false) => {
      const doing = flatClip(freshDoing(s, now), 120)
      const head = `- ${s.name}${s.agentName ? `（${s.agentName} · ${s.model}）` : `（${s.model}）`} · ${STATUS_LABEL[s.status] ?? s.status}${s.unsure !== undefined ? `（不确定，自 ${formatStamp(s.unsure)} 无动静）` : ""}${doing ? `：${doing}` : ""}`
      const extras: string[] = []
      if (s.queuedCount) extras.push(`  队列积压 ${s.queuedCount} 条${s.queuePaused ? "（已暂停）" : ""}`)
      if (s.retry) extras.push(`  网络重试 ${s.retry.n}/${s.retry.of}（下次 ${formatStamp(s.retry.at)}）`)
      if (s.owes) {
        const taskCap = compact ? 3 : s.owes.tasks.length
        for (const ot of s.owes.tasks.slice(0, taskCap)) {
          extras.push(`  欠待办 [${ot.id}] ${ot.title}${ot.step ? `（到「${ot.step}」）` : ""}`)
        }
        if (s.owes.tasks.length > taskCap) {
          extras.push(`  …另有 ${s.owes.tasks.length - taskCap} 件欠待办（传 part="seats" 查看）`)
        }
        const callCap = compact ? 3 : s.owes.calls.length
        for (const oc of s.owes.calls.slice(0, callCap)) {
          extras.push(
            `  欠点名 [${oc.messageId}] 来自 ${oc.from}（${CALL_STATE_LABEL[oc.state] ?? oc.state}，${formatStamp(oc.at)}）`,
          )
        }
        if (s.owes.calls.length > callCap) {
          extras.push(`  …另有 ${s.owes.calls.length - callCap} 条欠点名（传 part="seats" 查看）`)
        }
      }
      return extras.length > 0 ? `${head}\n${extras.join("\n")}` : head
    }

    const buildWaitFullLines = () => {
      const lines: string[] = []
      for (const m of openAsks) {
        const opts = m.ask?.options?.length
          ? `\n    选项${m.ask.multi ? "（可多选）" : ""}：${m.ask.options.map((o) => (o.detail ? `${o.label}（${o.detail}）` : o.label)).join(" ｜ ")}`
          : ""
        lines.push(`- 提问 [${m.id}] ${m.authorName}（${formatStamp(m.createdAt)}）：${m.text.trim()}${opts}`)
      }
      for (const p of snap.permits) {
        const what =
          p.kind === "full"
            ? `申请本轮完整权限：${flatClip(p.reason, 200) || "（未填理由）"}`
            : `工具 ${p.tool ?? ""}：${flatClip(p.input, 200)}`
        lines.push(`- 权限 [${p.id}] ${p.agentName}（${formatStamp(p.at)}）：${what}`)
      }
      for (const t of waitingReviews) {
        const note = t.review?.note ? `说明：${flatClip(t.review.note, 200)}` : "（无验收说明）"
        const chk = ` ｜ 复验：${formatCheckBrief(t.check, true)}`
        lines.push(
          `- 等验收 [${t.id}] 「${t.title}」 · 负责人 ${t.ownerName ?? "未认领"} · ${note}${chk} ｜ ${laneText(t, user)}`,
        )
      }
      return lines
    }

    const buildCallLines = (compact = false) =>
      brokenCalls.map((c) => {
        const note = compact ? flatClip(c.note, 80) : c.note
        const gist = compact ? flatClip(c.gist, 60) : c.gist
        return `- [${c.messageId}] ${c.from} → @${c.seatName} · ${CALL_STATE_LABEL[c.state] ?? c.state}（${formatStamp(c.at)}）${note ? `：${note}` : ""}${gist ? ` ｜ 原话：「${gist}」` : ""}`
      })

    const basePayload = () => ({
      project: target,
      summary: snap.summary,
      waiting: {
        asks: openAsks.map((m) => ({
          id: m.id,
          seq: m.seq,
          authorName: m.authorName,
          createdAt: m.createdAt,
          text: m.text,
          options: m.ask?.options,
          multi: m.ask?.multi,
        })),
        permits: snap.permits,
        reviews: waitingReviews.map((t) => ({
          id: t.id,
          title: t.title,
          ownerName: t.ownerName,
          note: t.review?.note,
          at: t.review?.at,
          check: t.check,
          checkState: t.check?.state ?? null,
          checkKind: t.check?.kind ?? null,
          hasGaps: Boolean(t.check?.gaps),
          lane: signLane(t).lane,
        })),
      },
      tasks: unfinished.map((t) => {
        const steps = t.steps ?? []
        return {
          id: t.id,
          title: t.title,
          ownerName: t.ownerName,
          status: t.status,
          stepsDone: steps.filter((s) => s.state === "done").length,
          stepsTotal: steps.length,
          currentStep: stepOf(t) ?? null,
          review: t.review ?? null,
          check: t.check ?? null,
        }
      }),
      seats: snap.agents.map((s) => ({
        id: s.id,
        name: s.name,
        agentName: s.agentName,
        model: s.model,
        role: s.role,
        status: s.status,
        doing: freshDoing(s, now),
        unsure: s.unsure,
        queuedCount: s.queuedCount,
        queuePaused: s.queuePaused,
        retry: s.retry,
        owes: s.owes ?? null,
      })),
      brokenCalls,
    })

    // ---- Mode A: single section (`part`: summary | tasks | seats | talk), paginated when long ----
    if (part === "summary") {
      const title = snap.summary
        ? `【房间摘要】（${snap.summary.by} 写于 ${formatStamp(snap.summary.at)}，覆盖至 seq ${snap.summary.upToSeq}）`
        : "【房间摘要】"
      const lines = snap.summary ? snap.summary.text.split("\n") : []
      const paged = paginateEntries(header, title, lines, "summary", page, "（暂无房间摘要）")
      return {
        ...basePayload(),
        part,
        page: paged.page,
        totalPages: paged.totalPages,
        hasMore: paged.hasMore,
        talk: { messages: [], hasMore: false, oldestSeq: null },
        text: paged.text,
      }
    }

    if (part === "tasks") {
      const waitFull = buildWaitFullLines()
      const taskFull = otherUnfinished.map((t) => {
        const base = formatTaskDetail(t, false)
        const stepLines = (t.steps ?? []).map(
          (st, idx) => `    ${idx + 1}. [${st.state === "done" ? "✓" : st.state === "doing" ? "◐" : "○"}] ${st.text}${st.note ? `（${flatClip(st.note, 80)}）` : ""}`,
        )
        return stepLines.length > 0 ? `${base}\n${stepLines.join("\n")}` : base
      })
      const entries: string[] = [
        `■ 等 ${user} 处理的事（${waitFull.length}）`,
        ...(waitFull.length > 0 ? waitFull : ["（没有）"]),
        `■ 其余未完成的待办（${otherUnfinished.length}）`,
        ...(taskFull.length > 0 ? taskFull : ["（没有）"]),
      ]
      const paged = paginateEntries(
        header,
        `【待办与等验收详情（等 ${user} ${waitFull.length} 件 · 其余未完成 ${otherUnfinished.length} 件）】`,
        entries,
        "tasks",
        page,
      )
      return {
        ...basePayload(),
        part,
        page: paged.page,
        totalPages: paged.totalPages,
        hasMore: paged.hasMore,
        talk: { messages: [], hasMore: false, oldestSeq: null },
        text: paged.text,
      }
    }

    if (part === "seats") {
      const seatFull = snap.agents.map((s) => formatSeat(s, false))
      const callFull = buildCallLines(false)
      const entries: string[] = [
        `■ 席位状态与欠活（${snap.agents.length}）`,
        ...(seatFull.length > 0 ? seatFull : ["（暂无席位）"]),
        `■ 没叫成或中途断了的点名（${brokenCalls.length}）`,
        ...(callFull.length > 0 ? callFull : ["（没有）"]),
      ]
      const paged = paginateEntries(header, "【席位状态、欠活与断掉的点名】", entries, "seats", page, "（暂无席位）")
      return {
        ...basePayload(),
        part,
        page: paged.page,
        totalPages: paged.totalPages,
        hasMore: paged.hasMore,
        talk: { messages: [], hasMore: false, oldestSeq: null },
        text: paged.text,
      }
    }

    if (part === "talk") {
      let curBefore = beforeSeq
      if (curBefore === undefined && page > 1) {
        for (let p = 1; p < page; p++) {
          const skipPage = dbLoadTalkPage(target.id, curBefore, PEEK_TALK_LIMIT)
          if (skipPage.messages.length === 0 || !skipPage.hasMore) {
            curBefore = 1
            break
          }
          curBefore = skipPage.messages[0].seq
        }
      }
      const talkPage = dbLoadTalkPage(target.id, curBefore, PEEK_TALK_LIMIT)
      const maxSingle = Math.max(800, PEEK_TEXT_BUDGET - header.length - 160)
      const allTalk = talkPage.messages.map((m) => {
        const fullLine = talkLine(m, true)
        return {
          id: m.id,
          seq: m.seq,
          line: fullLine.length > maxSingle ? `${fullLine.slice(0, maxSingle - 14)}…（单条过长已截断）` : fullLine,
        }
      })
      const renderPartTalk = (kept: typeof allTalk) => {
        const cutCount = allTalk.length - kept.length
        const remaining = talkPage.olderCount + cutCount
        const cursorSeq =
          kept.length > 0 ? kept[0].seq : curBefore ?? (allTalk.length > 0 ? allTalk[allTalk.length - 1].seq + 1 : null)
        const hint = remaining > 0 && cursorSeq !== null ? `\n（还有 ${remaining} 条，用 before=${cursorSeq} 翻）` : ""
        const title = `\n【完整对话（${kept.length} 条${curBefore ? `，seq < ${curBefore}` : ""}）】`
        const bodyLines = kept.length > 0 ? kept.map((t) => t.line).join("\n") : "（暂无对话）"
        return {
          text: `${header}\n${title}\n${bodyLines}${hint}`,
          remaining,
          cursorSeq,
        }
      }
      let kept: typeof allTalk = []
      for (let i = allTalk.length - 1; i >= 0; i--) {
        const nextKept = [allTalk[i], ...kept]
        if (kept.length > 0 && renderPartTalk(nextKept).text.length > PEEK_TEXT_BUDGET) break
        kept = nextKept
      }
      const rendered = renderPartTalk(kept)
      return {
        ...basePayload(),
        part,
        page,
        hasMore: rendered.remaining > 0,
        talk: {
          messages: kept,
          hasMore: rendered.remaining > 0,
          oldestSeq: rendered.cursorSeq,
          remaining: rendered.remaining,
        },
        text: rendered.text,
      }
    }

    // ---- Mode B: `full: true` preserves legacy full output ----
    if (full) {
      const talkPage = dbLoadTalkPage(target.id, beforeSeq, PEEK_TALK_LIMIT)
      const talkLines = talkPage.messages.map((m) => ({
        id: m.id,
        seq: m.seq,
        line: talkLine(m, true),
      }))
      const oldestSeq = talkPage.messages[0]?.seq ?? null

      const sections: string[] = [header]
      if (snap.summary) {
        sections.push(
          `\n【房间摘要】（${snap.summary.by} 写于 ${formatStamp(snap.summary.at)}，覆盖至 seq ${snap.summary.upToSeq}）\n${snap.summary.text}`,
        )
      } else {
        sections.push("\n【房间摘要】\n（暂无房间摘要）")
      }
      const waitLines = buildWaitFullLines()
      sections.push(
        `\n【等 ${user} 处理的事（${waitLines.length}）】\n${waitLines.length > 0 ? waitLines.join("\n") : "（没有）"}`,
      )
      sections.push(
        `\n【未完成的待办（${unfinished.length}）】\n${unfinished.length > 0 ? unfinished.map((t) => formatTaskDetail(t, false)).join("\n") : "（没有）"}`,
      )
      const seatLines = snap.agents.map((s) => formatSeat(s, false))
      sections.push(
        `\n【席位状态与欠活（${snap.agents.length}）】\n${seatLines.length > 0 ? seatLines.join("\n") : "（暂无席位）"}`,
      )
      const callLines = buildCallLines(false)
      sections.push(
        `\n【没叫成或中途断了的点名（${brokenCalls.length}）】\n${callLines.length > 0 ? callLines.join("\n") : "（没有）"}`,
      )
      const pageHint =
        talkPage.hasMore && oldestSeq !== null
          ? `\n（还有更早的对话；要继续往前翻，调用 bench_peek 传 project="${target.id}", before=${oldestSeq}）`
          : ""
      sections.push(
        `\n【最近对话（${talkLines.length} 条${beforeSeq ? `，seq < ${beforeSeq}` : ""}）】\n${talkLines.length > 0 ? talkLines.map((t) => t.line).join("\n") : "（暂无对话）"}${pageHint}`,
      )

      return {
        ...basePayload(),
        talk: {
          messages: talkLines,
          hasMore: talkPage.hasMore,
          oldestSeq,
          remaining: talkPage.olderCount,
        },
        text: sections.join("\n"),
      }
    }

    // ---- Mode C (default): compact summary <= 8000 chars ----
    // 1. Summary clipped to 600 chars
    let summarySec = "\n【房间摘要】\n（暂无房间摘要）"
    if (snap.summary) {
      const clipped = blockClip(snap.summary.text, PEEK_SUMMARY_COMPACT_CHARS)
      const more = clipped.clipped ? `\n…（摘要已截到 ${PEEK_SUMMARY_COMPACT_CHARS} 字，完整内容传 part="summary"）` : ""
      summarySec = `\n【房间摘要】（${snap.summary.by} 写于 ${formatStamp(snap.summary.at)}，覆盖至 seq ${snap.summary.upToSeq}）\n${clipped.text}${more}`
    }

    // 2. Waiting items (one line each)
    const waitCompact: string[] = []
    for (const m of openAsks) {
      const opts = m.ask?.options?.length
        ? `（选项${m.ask.multi ? "·可多选" : ""}：${m.ask.options.map((o) => (o.detail ? `${o.label}:${flatClip(o.detail, 24)}` : o.label)).join("｜")}）`
        : ""
      waitCompact.push(`- 提问 [${m.id}] ${m.authorName}（${formatStamp(m.createdAt)}）：${flatClip(m.text, 140)}${opts}`)
    }
    for (const p of snap.permits) {
      const what =
        p.kind === "full"
          ? `申请本轮完整权限：${flatClip(p.reason, 120) || "（未填理由）"}`
          : `工具 ${p.tool ?? ""}：${flatClip(p.input, 120)}`
      waitCompact.push(`- 权限 [${p.id}] ${p.agentName}（${formatStamp(p.at)}）：${what}`)
    }
    for (const t of waitingReviews) {
      const steps = t.steps ?? []
      const doneCount = steps.filter((s) => s.state === "done").length
      const prog = steps.length > 0 ? ` · 步骤 ${doneCount}/${steps.length}` : ""
      const note = t.review?.note ? `说明：${flatClip(t.review.note, 100)}` : "（无验收说明）"
      const chk = ` ｜ 复验：${formatCheckBrief(t.check, true)}`
      waitCompact.push(
        `- 等验收 [${t.id}] 「${flatClip(t.title, 40)}」 · 负责人 ${t.ownerName ?? "未认领"}${prog} · ${note}${chk} ｜ ${laneText(t, user)}`,
      )
    }

    // 3. Other unfinished tasks (deduped: waitingReviews already listed above, one line each)
    const taskCompact = otherUnfinished.map((t) => formatTaskDetail(t, true))

    // 4. Seats & obligations
    const seatCompact = snap.agents.map((s) => formatSeat(s, true))

    // 5. Broken calls
    const callCompact = buildCallLines(true)

    // 6. Latest <= 10 talk lines (clipped to 200 chars each, without wakeText);
    //    if total exceeds 8000 chars, trim older talk lines first and state remaining count.
    const talkPage = dbLoadTalkPage(target.id, beforeSeq, PEEK_TALK_COMPACT_LIMIT)
    const allTalk = talkPage.messages.map((m) => ({
      id: m.id,
      seq: m.seq,
      line: compactTalkLine(m),
    }))

    // Keep room for at least the latest couple of talk lines even when a project has hundreds of tasks.
    const talkReserve = allTalk.length > 0 ? 750 : 120
    const prefix = fitPrefixLines(
      header,
      summarySec,
      `【等 ${user} 处理的事（${waitCompact.length}）】`,
      waitCompact,
      `【未完成的待办（${taskCompact.length}）】`,
      taskCompact,
      `【席位状态与欠活（${snap.agents.length}）】`,
      seatCompact,
      `【没叫成或中途断了的点名（${callCompact.length}）】`,
      callCompact,
      PEEK_TEXT_BUDGET - talkReserve,
    )

    const renderCompactTalk = (kept: typeof allTalk) => {
      const cutCount = allTalk.length - kept.length
      const remaining = talkPage.olderCount + cutCount
      const cursorSeq =
        kept.length > 0 ? kept[0].seq : beforeSeq ?? (allTalk.length > 0 ? allTalk[allTalk.length - 1].seq + 1 : null)
      const pageHint = remaining > 0 && cursorSeq !== null ? `\n（还有 ${remaining} 条，用 before=${cursorSeq} 翻）` : ""
      const bodyLines =
        kept.length > 0
          ? kept.map((t) => t.line).join("\n")
          : remaining > 0
            ? "（本页空间已满，未展开对话）"
            : "（暂无对话）"
      const fullText = `${prefix}\n\n【最近对话（${kept.length} 条${beforeSeq ? `，seq < ${beforeSeq}` : ""}）】\n${bodyLines}${pageHint}`
      return { fullText, remaining, cursorSeq }
    }

    let keptTalk: typeof allTalk = []
    for (let i = allTalk.length - 1; i >= 0; i--) {
      const candidate = [allTalk[i], ...keptTalk]
      if (renderCompactTalk(candidate).fullText.length > PEEK_TEXT_BUDGET) break
      keptTalk = candidate
    }
    const finalTalk = renderCompactTalk(keptTalk)

    return {
      ...basePayload(),
      talk: {
        messages: keptTalk,
        hasMore: finalTalk.remaining > 0,
        oldestSeq: finalTalk.cursorSeq,
        remaining: finalTalk.remaining,
      },
      text: finalTalk.fullText,
    }
  })
}

// The desk's AI telling the user something they should know now (AverageJoe
// 2026-11-16, t_d82796d3): one line of summary, pushed to the phone (lib/push.ts,
// skipped while the page is in front, as every push) and shown by the page as
// a notice or a desktop notification (components/room/notify.ts, via
// Project.notice). Signed 「前台」: to the user the desk is one. At most one
// every NOTICE_GAP, so a busy desk can't make the phone buzz on and on.
const NOTICE_GAP = 5 * 60_000
const NOTICE_MAX = 80

export function frontNotify(input: unknown) {
  const { frontProjectId } = requireFrontSeat(input)
  const text = (asString(asRecord(input).text) ?? "").replace(/\s+/g, " ").trim()
  if (!text) throw new ApiError(400, "要推的话不能是空的")
  if ([...text].length > NOTICE_MAX) throw new ApiError(400, `推送只发一句摘要，${NOTICE_MAX} 字以内；细节写在回答里`)
  const last = readFrontNotice()
  const now = Date.now()
  if (last && now - last.at < NOTICE_GAP) {
    throw new ApiError(429, `刚推过一条，${Math.ceil((NOTICE_GAP - (now - last.at)) / 60_000)} 分钟内先别再推；要说的写在回答里就行`)
  }
  const notice = { id: `n_${now.toString(36)}`, at: now, text }
  dbSetMeta(FRONT_NOTICE_KEY, JSON.stringify(notice))
  enqueuePushEvent({ projectId: frontProjectId, getProjectName: () => "前台", kind: "front", actor: "", what: "提醒你", snippet: text }, 1_000)
  return { notice }
}
