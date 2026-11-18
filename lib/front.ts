import { dbCountOpenAsks, dbLoadTalkPage, dbSetMeta } from "@/lib/db"
import { ApiError, asRecord, asString } from "@/lib/http"
import { stepOf } from "@/lib/owes"
import { enqueuePushEvent } from "@/lib/push"
import { awaitingReview, signLane } from "@/lib/review"
import {
  autoAcceptSince,
  FRONT_NOTICE_KEY,
  readFrontNotice,
  brokenCallsInRoom,
  inProject,
  listProjects,
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
const PEEK_TALK_LIMIT = 30

function flatClip(value: string | undefined, max: number): string {
  const clean = (value ?? "").replace(/\s+/g, " ").trim()
  if (!clean) return ""
  return clean.length > max ? `${clean.slice(0, max)}…` : clean
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

function formatOverviewSeat(seat: PublicAgent): string {
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
  const doing = flatClip(seat.doing, 70)
  if (doing) parts.push(doing)
  return `  - ${parts.join(" · ")}`
}

export function frontOverview(input: unknown) {
  requireFrontSeat(input)
  const projects = listProjects()
  // Tighter per-project summary cap if there are many rooms, keeping total output well within a few thousand chars.
  const summaryCap =
    projects.length > 8
      ? Math.max(80, Math.floor((OVERVIEW_TEXT_BUDGET - projects.length * 220) / projects.length))
      : OVERVIEW_SUMMARY_CHARS

  let user = "用户"
  const items = projects.map((proj) =>
    inProject(proj.id, () => {
      const snap = snapshot()
      user = snap.userName
      const openAsks = dbCountOpenAsks(proj.id)
      const pendingPermits = snap.permits.length
      const waitingReviewTasks = snap.tasks.filter(awaitingReview)
      const waitingReviews = waitingReviewTasks.length
      const unfinishedTasks = snap.tasks.filter((t) => t.status !== "done").length

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
        unfinishedTasks,
        seatTotal: snap.agents.length,
        seats: shownSeats.map((s) => ({
          name: s.name,
          status: s.status,
          doing: flatClip(s.doing, 90),
          owesCount: owesCountOf(s),
          unsure: s.unsure !== undefined,
        })),
        quietSeatNames: quietSeats.map((s) => s.name),
        summaryHead: summarySnippet,
        rawShownSeats: shownSeats,
      }
    }),
  )

  // Over the budget, the summaries go first: what waits on the user in every
  // project matters more to the desk than how each summary starts. Only then
  // is the text cut from the end.
  const render = (withSummary: boolean) => {
    const blocks: string[] = [
      `并坐全部项目一览（共 ${items.length} 个项目，用户：${user}）${withSummary ? "" : "\n（内容太长，各项目的摘要开头没列，要看用 bench_peek）"}`,
    ]
    for (const item of items) {
      const tag = item.front ? " [前台]" : ""
      const dirPart = item.dir ? ` · 目录 ${item.dir}` : ""
      const lines: string[] = [
        `\n■ ${item.name}（${item.id}）${tag}${dirPart}`,
        `  最后动静：${item.lastAtText} ｜ 未完待办：${item.unfinishedTasks} ｜ 等 ${user}：提问 ${item.waiting.asks} · 权限 ${item.waiting.permits} · 验收 ${item.waiting.reviews}${item.signSettings ? ` ｜ ${item.signSettings}` : ""}`,
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
        for (const s of item.rawShownSeats) {
          lines.push(formatOverviewSeat(s))
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
    projects: items.map(({ rawShownSeats: _raw, signSettings: _settings, ...pub }) => {
      void _raw
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

function formatTaskDetail(task: Task): string {
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
  return `- [${task.id}] ${task.title} ｜ ${TASK_STATUS_LABEL[task.status] ?? task.status} ｜ ${owner} ｜ ${progress}${curText}${rev}${chk}`
}

export function frontPeek(input: unknown) {
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

  const target = resolveProjectInfo(projectRef)
  return inProject(target.id, () => {
    const snap = snapshot()
    const user = snap.userName
    const unfinished = snap.tasks.filter((t) => t.status !== "done")
    const openAsks = collectOpenAsks(snap.openAsks, snap.messages)
    const waitingReviews = snap.tasks.filter(awaitingReview)
    const brokenCalls = brokenCallsInRoom()
    const talkPage = dbLoadTalkPage(target.id, beforeSeq, PEEK_TALK_LIMIT)
    const talkLines = talkPage.messages.map((m) => ({
      id: m.id,
      seq: m.seq,
      line: talkLine(m, true),
    }))
    const oldestSeq = talkPage.messages[0]?.seq ?? null

    const sections: string[] = []
    sections.push(
      `【项目「${target.name}」（${target.id}）】${target.front ? " [前台]" : ""}${target.dir ? ` · 目录：${target.dir}` : ""}${
        target.front
          ? ""
          : ` · ${signSettings(target.check, snap.agents.find((seat) => seat.checker)?.name, getWatchedProject(target.id)?.seatName)}`
      }`,
    )

    // 1. 房间摘要全文
    if (snap.summary) {
      sections.push(
        `\n【房间摘要】（${snap.summary.by} 写于 ${formatStamp(snap.summary.at)}，覆盖至 seq ${snap.summary.upToSeq}）\n${snap.summary.text}`,
      )
    } else {
      sections.push("\n【房间摘要】\n（暂无房间摘要）")
    }

    // 2. 等用户的每一件
    const waitLines: string[] = []
    for (const m of openAsks) {
      const opts = m.ask?.options?.length
        ? `\n    选项${m.ask.multi ? "（可多选）" : ""}：${m.ask.options.map((o) => (o.detail ? `${o.label}（${o.detail}）` : o.label)).join(" ｜ ")}`
        : ""
      waitLines.push(`- 提问 [${m.id}] ${m.authorName}（${formatStamp(m.createdAt)}）：${m.text.trim()}${opts}`)
    }
    for (const p of snap.permits) {
      const what =
        p.kind === "full"
          ? `申请本轮完整权限：${flatClip(p.reason, 200) || "（未填理由）"}`
          : `工具 ${p.tool ?? ""}：${flatClip(p.input, 200)}`
      waitLines.push(`- 权限 [${p.id}] ${p.agentName}（${formatStamp(p.at)}）：${what}`)
    }
    for (const t of waitingReviews) {
      const note = t.review?.note ? `说明：${flatClip(t.review.note, 200)}` : "（无验收说明）"
      const chk = ` ｜ 复验：${formatCheckBrief(t.check, true)}`
      waitLines.push(
        `- 等验收 [${t.id}] 「${t.title}」 · 负责人 ${t.ownerName ?? "未认领"} · ${note}${chk} ｜ ${laneText(t, user)}`,
      )
    }
    sections.push(
      `\n【等 ${user} 处理的事（${waitLines.length}）】\n${waitLines.length > 0 ? waitLines.join("\n") : "（没有）"}`,
    )

    // 3. 没完成的待办
    sections.push(
      `\n【未完成的待办（${unfinished.length}）】\n${unfinished.length > 0 ? unfinished.map(formatTaskDetail).join("\n") : "（没有）"}`,
    )

    // 4. 每个席位的状态和欠的事
    const seatLines = snap.agents.map((s) => {
      const head = `- ${s.name}${s.agentName ? `（${s.agentName} · ${s.model}）` : `（${s.model}）`} · ${STATUS_LABEL[s.status] ?? s.status}${s.unsure !== undefined ? `（不确定，自 ${formatStamp(s.unsure)} 无动静）` : ""}：${flatClip(s.doing, 120) || "（未写进度）"}`
      const extras: string[] = []
      if (s.queuedCount) extras.push(`  队列积压 ${s.queuedCount} 条${s.queuePaused ? "（已暂停）" : ""}`)
      if (s.retry) extras.push(`  网络重试 ${s.retry.n}/${s.retry.of}（下次 ${formatStamp(s.retry.at)}）`)
      if (s.owes) {
        for (const ot of s.owes.tasks) {
          extras.push(`  欠待办 [${ot.id}] ${ot.title}${ot.step ? `（到「${ot.step}」）` : ""}`)
        }
        for (const oc of s.owes.calls) {
          extras.push(
            `  欠点名 [${oc.messageId}] 来自 ${oc.from}（${CALL_STATE_LABEL[oc.state] ?? oc.state}，${formatStamp(oc.at)}）`,
          )
        }
      }
      return extras.length > 0 ? `${head}\n${extras.join("\n")}` : head
    })
    sections.push(
      `\n【席位状态与欠活（${snap.agents.length}）】\n${seatLines.length > 0 ? seatLines.join("\n") : "（暂无席位）"}`,
    )

    // 5. 没叫成或中途断了的点名
    const callLines = brokenCalls.map(
      (c) =>
        `- [${c.messageId}] ${c.from} → @${c.seatName} · ${CALL_STATE_LABEL[c.state] ?? c.state}（${formatStamp(c.at)}）${c.note ? `：${c.note}` : ""}${c.gist ? ` ｜ 原话：「${c.gist}」` : ""}`,
    )
    sections.push(
      `\n【没叫成或中途断了的点名（${brokenCalls.length}）】\n${callLines.length > 0 ? callLines.join("\n") : "（没有）"}`,
    )

    // 6. 最近 30 条对话
    const pageHint =
      talkPage.hasMore && oldestSeq !== null
        ? `\n（还有更早的对话；要继续往前翻，调用 bench_peek 传 project="${target.id}", before=${oldestSeq}）`
        : ""
    sections.push(
      `\n【最近对话（${talkLines.length} 条${beforeSeq ? `，seq < ${beforeSeq}` : ""}）】\n${talkLines.length > 0 ? talkLines.map((t) => t.line).join("\n") : "（暂无对话）"}${pageHint}`,
    )

    return {
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
        doing: s.doing,
        unsure: s.unsure,
        queuedCount: s.queuedCount,
        queuePaused: s.queuePaused,
        retry: s.retry,
        owes: s.owes ?? null,
      })),
      brokenCalls,
      talk: {
        messages: talkLines,
        hasMore: talkPage.hasMore,
        oldestSeq,
      },
      text: sections.join("\n"),
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
