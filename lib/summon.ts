import { spawn, type ChildProcessByStdio } from "node:child_process"
import type { Readable } from "node:stream"
import { createHash, randomBytes } from "node:crypto"
import { StringDecoder } from "node:string_decoder"

import { adapterFor, commandFor, modelOf, summonPath, type Adapter } from "@/lib/adapters"
import { clearSeatUserStopped, markSeatUserStopped } from "@/lib/continue"
import { compactEnv, CONTEXT_KINDS, seatContext, type SeatContext } from "@/lib/context"
import { dbLoadLanes, dbSaveLane } from "@/lib/db"
import { createParser, liveLine } from "@/lib/events"
import { ApiError } from "@/lib/http"
import { isSeatStoppedByUser, registerLaneIdle, registerLaneReader } from "@/lib/lane-state"
import { detectLimit, unwrapErrorMessage, whenText } from "@/lib/limits"
import { commandLine, killTree } from "@/lib/platform"
import { accepting, deliver, openTerminal } from "@/lib/terminal"
import { onTerminalClosed, terminalOpen } from "@/lib/terminal-state"
import { activeRun, endRun, getRun, markResumed, pendingResumes, putStep, setLimited, startRun, takeUnannounced } from "@/lib/runs"
import {
  agentState,
  bindProject,
  CATCH_UP_CHARS,
  currentProject,
  currentProjectInfo,
  catchUp,
  inProject,
  inSeat,
  markInterruptedResumed,
  markLimited,
  markReached,
  markCalls,
  openCalls,
  callsOfRun,
  saidInRun,
  settleCalls,
  ranUntilNow,
  listProjects,
  postInterrupted,
  postLimited,
  projectOfSeat,
  endSummaryJob,
  onCheckWanted,
  setTaskCheck,
  isStandby,
  isWaiting,
  clearStandby,
  markWoken,
  onMessage,
  postSystem,
  pulseAgent,
  roomChanged,
  saveSummary,
  sayAs,
  seatBriefing,
  snapshot,
  startSummaryJob,
  summaryJob,
  summarySource,
  summonCandidates,
  END_MARK,
  askSettled,
  userName,
  gisterSeat,
  setMessageGist,
  limitResume,
  netRetry,
  tasksOwedBy,
  limitedAgentNames,
  earliestLimitReset,
  autoCheckHere,
} from "@/lib/store"
import { GIST_MAX, withAttachments } from "@/lib/text"
import type { CallState, Message, PublicAgent, RoomSummary, Run, Task, TaskCheck } from "@/lib/types"
import { flowsOf } from "@/lib/flow"
import { capacityFailure, isNetworkFailure, retryDelays } from "@/lib/netfail"
import { stepOf } from "@/lib/owes"
import { flowSummaryPrompt, flowsToSummarize } from "@/lib/flow-summary"
import { autoAcceptChecked } from "@/lib/deputy"
import { noteChecksSettled } from "@/lib/patrol"
import { isKindQuotaBlocked } from "@/lib/quota"
import { awaitingReview, checkStaleMs, reviewAsked } from "@/lib/review"

const NOTE_GAP_MS = 30_000
// After the stream says its turn is over, how long the process may take to exit.
const END_GRACE_MS = 3_000
// Every line of a wake's output is read, however much there is: the answer
// is in the last event, and a stream of edits (each tool result carries the
// whole file) passed 1MB once, which used to be where reading stopped. Only
// a single line longer than this is dropped, and the room says so.
const LINE_LIMIT = 8 * 1024 * 1024
// The seat line follows the steps, but not faster than this.
const LIVE_GAP_MS = 800
// A client that prints an event stream says something within seconds of
// starting. When it hasn't, it is usually its own service queueing the
// request (a Cursor wake once sat silent for five minutes, then finished in
// seconds), so the run isn't stopped: the seat and the 「过程」 panel just say
// how long it has been waiting, so it doesn't look frozen.
const WAIT_NOTE_MS = 30_000
// t_16ecccd4. Antigravity has stayed up for hours after its last reply,
// without the closing "result" (碳猫, 2026-11-17 12:31 → 17:59): a reply
// that finished with no tool call after it, then this long with nothing, is
// the end of its turn. A wake that has gone this long with no output at all
// is only shown on the seat (「已经 N 分钟没动静」); only the user stops it.
const REPLIED_END_MS = 5 * 60_000
const SILENT_NOTE_MS = 10 * 60_000

// What one wake's prompt may weigh in bytes when it goes out as a command-line
// argument (Linux: 128 KB per argument, quoting and the rest included).
const SUMMARY_PROMPT_BYTES = 90_000

// One queue per seat. A seat runs one command at a time; messages that land
// while it runs are batched into the next run instead of being dropped.
// `summary`: the user asked this seat for a room summary; it runs before the
// next batch of messages.
// `stop`: ends the command running now, if any. `carry`: the room messages a
// run was answering when someone interjected; the next run takes them up again.
// `whisper`: what the user said to this seat alone, run before anything else.
type Lane = {
  running: boolean
  paused?: boolean
  // The pause is the restart's, not the user's: the room takes it off itself
  // (resumeAfterRestart). Saved, so a later restart can tell them apart.
  restartPaused?: boolean
  projectId?: string
  // What called it since its last run, by message id, so a recalled or dropped
  // message can be taken back out before the run starts.
  pending: { id: string; line: string }[]
  hops: number
  summary?: boolean
  // The user asked the room to compact this seat's context; runs next.
  compact?: boolean
  // The user typed /goal for this seat: what came after it ("clear" too).
  goal?: string
  stop?: () => void
  carry?: string
  whisper?: string
  // The latest message that called this seat; the next reply answers it.
  trigger?: string
  // Message IDs explicitly dropped from this seat's wake queue, omitted on next catchUp.
  dropped?: string[]
  // While a reply run is going: the key its hook asks with (BENCH_RUN_KEY),
  // the project and run log it belongs to, and the furthest relay hop of the
  // messages it was handed mid-run (see takeQueued).
  key?: string
  project?: string
  log?: Run
  midHop?: number
  // The messages the running reply answers (Message.calls follows them), and
  // those of a reply that was cut short and comes back as `carry`.
  calls?: string[]
  carryIds?: string[]
  // A wake that failed on the network is tried again by itself
  // (lib/netfail.ts): how many tries so far, and when the next one goes.
  // The messages wait as `carry` / `carryIds` meanwhile.
  retries?: number
  retryAt?: number
  retryTimer?: NodeJS.Timeout
  // Tasks this seat is to check before the user signs them off (checkTask),
  // each as the request for review it was started for.
  checks?: { taskId: string; at: number }[]
  // Messages this seat is to write a one-line gist for (「谁来补摘要句」,
  // writeGists). Not saved: after a restart the page shows the rules' cut.
  gists?: string[]
}

type SummonGlobal = typeof globalThis & {
  __benchSummonBound?: boolean
  __benchSummonAnnounced?: boolean
  // Lanes this start paused because a restart cut their work short.
  __benchBootPaused?: Set<string>
  __benchTermBound?: boolean
  // Runs the user asked to be woken again after a usage limit: when.
  __benchResumeTimers?: Map<string, NodeJS.Timeout>
  __benchSummonHandler?: (message: Message) => void
  __benchCheckHandler?: (wanted: { project: string; taskId: string; at: number }) => void
  __benchGistHandler?: (message: Message) => void
  __benchGistBound?: boolean
  // Long replies with no gist, gathered a few seconds per project before the
  // summary seat is woken with them; and how many batches each seat wrote.
  __benchGistGather?: Map<string, { ids: string[]; timer?: NodeJS.Timeout }>
  __benchGistBatches?: Map<string, number>
  __benchCheckCounts?: Map<string, number>
  __benchCheckSettled?: Map<string, { ids: Set<string>; first: number; timer?: ReturnType<typeof setTimeout> }>
  __benchCheckSweep?: { version: number; timer: ReturnType<typeof setInterval> }
  // Seats whose last check could not run, and when (see pickAutoChecker).
  __benchCheckFailed?: Map<string, number>
  // Seat id -> when a usage-limit resume last woke it (autoResumeAt).
  __benchLimitAutoFired?: Map<string, number>
  __benchCheckBound?: boolean
  __benchCalledHop?: Map<string, number>
  __benchSummonAt?: Map<string, number>
  __benchLanes?: Map<string, Lane>
  __benchLanesDataPath?: string
  __benchHops?: Map<string, number>
}

function g() {
  return globalThis as SummonGlobal
}

function lanesMap(): Map<string, Lane> {
  const currentDataPath = process.env.BENCH_DATA_DIR || ""
  if (!g().__benchLanes || g().__benchLanesDataPath !== currentDataPath) {
    const loaded = new Map<string, Lane>()
    try {
      for (const row of dbLoadLanes()) {
        // After a server restart, any seat with queued work starts paused so
        // queued messages never jump ahead of an interrupted wake or run behind
        // the user's back when they restarted to stop things.
        const hasWork =
          row.pending.length > 0 ||
          row.carry !== undefined ||
          row.summary ||
          row.compact ||
          row.goal !== undefined ||
          row.whisper !== undefined
        const paused = Boolean(row.paused || hasWork)
        // Work this restart cut short is taken up again a little later; a
        // lane already paused before it (by the user, or by an earlier
        // restart nobody resumed) stays as it was.
        if (hasWork && !row.paused) bootPaused().add(row.agentId)
        const entry: Lane = {
          running: false,
          paused: paused || undefined,
          restartPaused: (paused && (row.restartPaused || !row.paused)) || undefined,
          projectId: row.projectId,
          pending: row.pending,
          hops: row.hops,
          summary: row.summary || undefined,
          compact: row.compact || undefined,
          goal: row.goal,
          carry: row.carry,
          whisper: row.whisper,
          trigger: row.trigger,
          dropped: row.dropped,
          carryIds: row.carryIds,
        }
        loaded.set(row.agentId, entry)
        if (paused && !row.paused && row.projectId) {
          try {
            dbSaveLane(row.agentId, row.projectId, entry)
          } catch {}
        }
      }
    } catch {}
    g().__benchLanes = loaded
    g().__benchLanesDataPath = currentDataPath
  }
  return g().__benchLanes!
}

function lane(id: string) {
  const store = lanesMap()
  let found = store.get(id)
  if (!found) {
    found = { running: false, pending: [], hops: 0 }
    store.set(id, found)
  }
  return found
}

function syncLane(agentId: string, notify = true) {
  const queue = lane(agentId)
  const projId = queue.projectId ?? projectOfSeat(agentId)
  if (!projId) return
  queue.projectId = projId
  try {
    dbSaveLane(agentId, projId, queue)
  } catch {}
  if (notify) {
    try {
      inProject(projId, () => roomChanged())
    } catch {}
  }
}

registerLaneReader((agentId) => {
  const q = lanesMap().get(agentId)
  if (!q) return undefined
  if (!q.paused && q.pending.length === 0 && !q.retryAt) return undefined
  return {
    paused: Boolean(q.paused),
    queuedCount: q.pending.length,
    queuedItems: q.pending,
    retry: q.retryAt ? { at: q.retryAt, n: q.retries ?? 1, of: retryDelays().length } : undefined,
  }
})

registerLaneIdle((agentId) => {
  const q = lanesMap().get(agentId)
  if (!q) return true
  return (
    !q.running &&
    !q.paused &&
    q.pending.length === 0 &&
    !q.retryAt &&
    q.carry === undefined &&
    !q.summary &&
    !q.compact &&
    q.goal === undefined &&
    q.whisper === undefined &&
    !q.checks?.length &&
    !q.gists?.length
  )
})

// What became of these messages' call to this seat (Message.calls, lib/types.ts
// CallState). Every place a call changes hands writes it here, so the page
// reads it and never has to guess it.
function note(
  ids: string[] | undefined,
  agentId: string,
  state: CallState,
  extra: { runId?: string; note?: string; from?: CallState[]; run?: string } = {},
) {
  if (!ids || ids.length === 0) return
  try {
    markCalls(ids, agentId, state, extra)
  } catch (error) {
    console.error(error)
  }
}

function hops() {
  return (g().__benchHops ??= new Map())
}

function cooled(key: string, gap: number) {
  const at = (g().__benchSummonAt ??= new Map())
  const now = Date.now()
  if (now - (at.get(key) ?? 0) < gap) return false
  at.set(key, now)
  return true
}

function roomUrl() {
  return (process.env.BENCH_URL || "http://127.0.0.1:4399").replace(/\/$/, "")
}

function stamp(at: number) {
  return new Date(at).toTimeString().slice(0, 5)
}

// Said on the first wake of a session the room created, after a cross-vendor
// rebind, or after the seat's persona/memory was updated.
function introduce(agent: NonNullable<ReturnType<typeof agentState>>) {
  const parts: string[] = []
  if (agent.fresh) {
    parts.push(
      `【你是并坐房间新开的会话】你在「${currentProjectInfo().name}」项目里叫 ${agent.name}，分工是「${agent.role}」，工作目录是 ${agent.workdir}。房间已经替你入座了，bench 工具直接能用，不用再 bench_join。别人 @${agent.name} 时房间会叫醒你。`,
    )
  }
  if (agent.fresh || agent.profileDirty || agent.reboundFrom) {
    const brief = seatBriefing(agent.id)
    if (brief) parts.push(brief)
  }
  return parts.length > 0 ? `${parts.join("\n\n")}\n\n` : ""
}

// What a seat still owes, said in a few lines at the end of its wake, so it
// picks the work up by itself instead of waiting for the user to notice
// (「停着 · 还欠」, lib/owes.ts, same test). To-dos already named in the
// messages it is handed are left out. Kept under ~200 characters.
const OWES_MAX = 3
function owesLine(agentId: string, body: string) {
  let owed: ReturnType<typeof tasksOwedBy>
  try {
    owed = tasksOwedBy(agentId)
  } catch {
    return ""
  }
  const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text)
  const list = owed
    .filter((task) => !body.includes(task.id))
    .sort((a, b) => Number(b.status === "doing") - Number(a.status === "doing") || b.updatedAt - a.updatedAt)
    .slice(0, OWES_MAX)
  if (list.length === 0) return ""
  const lines = list.map((task) => {
    if (awaitingReview(task) && !reviewAsked(task)) return `${task.id} ${cut(task.title, 20)}（只剩验收：写清怎么看到效果，再请验收）`
    const step = stepOf(task)
    return `${task.id} ${cut(task.title, 20)}${step ? `（到「${cut(step, 14)}」）` : ""}`
  })
  return `【你名下还没做完的待办】\n${lines.join("\n")}\n接着做，或者把它标成卡住并写明在等什么。`
}

const CARRY_HEAD = "【刚才被打断、还没回的】\n"

// Messages a cut-short wake was answering, put back in front of what came
// since. A carry that already has the heading (a retry of a retry) keeps one.
function withCarry(carried: string | undefined, fresh: string) {
  if (!carried) return fresh
  const back = carried.startsWith(CARRY_HEAD) ? carried.slice(CARRY_HEAD.length) : carried
  return `${CARRY_HEAD}${back}${fresh ? `\n\n【之后的新消息】\n${fresh}` : ""}`
}

function envelope(
  body: string,
  skipped: number,
  summary: RoomSummary | undefined,
  replyByStdout: boolean,
  kind = "",
  full = false,
  seat?: NonNullable<ReturnType<typeof agentState>>,
) {
  const how = replyByStdout
    ? "最后的回答直接输出就行，会作为你的发言贴回房间，不用调用 bench_say。中途的进度、逐条汇报直接说出来：这些话会实时显示在你自己的席位和过程记录里，用户看得到，但不会进群聊，所以不要用 bench_say 刷进度。"
    : `回复请发回房间：有 bench_say 工具就用它；没有的话 POST ${roomUrl()}/api/v1/say，带你入座时的 agentId 和 token。`
  // Each line carries its id; the reply hangs under the message that called it.
  const thread = replyByStdout
    ? "你的回答会自动挂成对叫你那条消息的回复。方括号里是消息 id；要看完整群聊、某条回复链或谁说过什么，用 bench_messages 工具（结构化数据）。"
    : "你的发言会自动挂成对叫你那条消息的回复；要回别的某条，bench_say 的 replyTo 填方括号里的 id。要看完整群聊、某条回复链或谁说过什么，用 bench_messages 工具（结构化数据）。"
  // Every feature the user asks for goes on the to-do list on the right, and
  // is worked and accepted along its steps.
  const todo =
    `${userName()} 要你做新功能时，开工前必须先用 bench_task 建一条待办：title 写他能得到什么（比如「聊天里长回复先只显示一句结论」），steps 拆成几步，owner 填你自己；标题和每一步都用大白话，别带文件名、函数名、命令、t_ 编号，写了房间会当场退回让你重写，技术细节放 detail 或步骤的 note；每开始一步用 bench_step 标 doing，做完标 done，note 写做了什么、怎么验的。已有待办的就接着推进，不要重复建。做完了用 bench_task_update 的 review 请 ${userName()} 验收（note 第一句写他怎么看到效果，也要大白话，带文件名或命令会被退回；细节写在后面）；「验收」那一步只有 ${userName()} 能在右栏点通过或打回，你不要自己勾，被打回会带着原因叫醒你。`
  // Two agents can keep @-ing each other; the one that sees the round is done ends it.
  const end = replyByStdout
    ? `如果这一轮交接已经完成、不需要谁再接手，回答以「${END_MARK}」开头，写一句做完了什么，不要 @ 任何人。`
    : `如果这一轮交接已经完成、不需要谁再接手，用 bench_say 带 end: true 发一句做完了什么，不要 @ 任何人。`
  // Claude Code's and Codex's prompts reach the page (claude-code.sh,
  // codex-app.mjs, lib/permits.ts). Codex asks the way it always does (its
  // sandbox escalation); the room turns that into a card.
  const claude = kind === "claude"
  const codex = kind === "codex"
  const permit = claude && full
    ? `${userName()} 给了你这个席位默认的全部权限：命令和工具直接用，不用 bench_elevate 申请。改动、删除、对外发送这类事照样以他说的为准。sudo 密码只能他自己在终端输。`
    : claude
    ? `跑命令被权限拦住、需要确认或要用没放行的工具时，先用 bench_elevate 说明要做什么、为什么，请 ${userName()} 给这次唤起临时完整权限，别直接放弃或绕路；单条命令的确认也会弹到他的网页上等他点。sudo 密码只能他自己在终端输。`
    : codex && full
    ? `${userName()} 给了你这个席位默认的全部权限：这次唤起没有沙箱，命令直接跑，不用申请提权。改动、删除、对外发送这类事照样以他说的为准。sudo 密码只能他自己在终端输。`
    : codex
    ? `你在工作区里可以直接读写。要联网、改工作区外的文件或跑沙箱外的命令时，照 Codex 平常的方式申请提权并写明理由，申请会弹到 ${userName()} 的网页上等他点，别直接放弃或绕路。sudo 密码只能他自己在终端输。`
    : ""
  // The first line is what the room shows folded (Message.gist, lib/text.ts).
  const gist = `回答和发言的第一行写一句 60 字以内的结论：做完了什么、结果怎样、要 ${userName()} 做什么；群里默认只显示这一行，细节放后面。`
  const stop = `${end}这条消息不会叫醒任何人。`
  // Woken, nobody watches the client: questions go to the page.
  const ask =
    `要问 ${userName()}、让他拍板时用 bench_ask（可以给选项），不要用你客户端自带的提问工具，这里没人看得到；它会等他在网页上回答，答案作为工具结果返回。能自己判断的别问。`
  // Recordings, sounds and pictures ride along with the answer (lib/store.ts pinAttachments).
  const attach = replyByStdout
    ? `汇报里要给 ${userName()} 看视频、音频或图片时，用 bench_attach 挂上文件的绝对路径，会跟你的回答一起发出，网页上能直接播放。`
    : `汇报里要给 ${userName()} 看视频、音频或图片时，bench_say 的 attachments 填文件的绝对路径，网页上能直接播放。`
  // Say plainly how complete the batch is, so the seat does not go digging
  // for messages it already has, or trust a batch that was cut.
  const scope =
    skipped === 0
      ? "下面是你上次之后房间里的全部消息，一条没漏，不用再去 bench_inbox 查。"
      : summary
        ? `你上次之后的消息太多，更早的 ${skipped} 条没列；先附上房间摘要（${summary.by} 写于 ${stamp(summary.at)}，概括了那之前的对话），再列最近的原文。需要原文用 bench_inbox 查。`
        : `下面是你上次之后房间里的消息，太长只列了最近这些；更早还有 ${skipped} 条没列，需要的话用 bench_inbox 查。`
  const digest = skipped > 0 && summary ? `【房间摘要】\n${summary.text}\n\n【最近的原文】\n` : ""
  const isFront = Boolean(currentProjectInfo().front)
  const frontDuty = isFront
    ? `你是前台，${userName()} 只跟你对接：bench_overview 看全部项目、bench_peek 看单项目要点（细看某栏传 part）；事都带项目名和 t_…/m_… id；传话 bench_relay、催人 bench_nudge、等验收 bench_review_card 都是卡片，他点了才算；你不能替他验收、批权限或冒名说话，要他去哪处理就说清楚。等验收有好几件时用 bench_review_batch 出整批卡片，没复验的先 bench_check 补跑。只有一个例外：一览里标着「可代签」的待办（房间按复验结果算的），用 bench_accept 替他通过，why 写复验验到了什么；被拒就留给他，不要换办法。他让你盯某个项目时用 bench_watch 记下项目和统筹（不用盯传 on:false）；盯着的项目全停卡住时，对那个统筹调 bench_nudge 会以前台名义直接发出，不用等他点。有要紧事要他知道（他可能不在页面前）时，说完再用 bench_notify 推一句 40 字内摘要到手机和桌面，别的时候不推。`
    : ""
  const whole = `${frontDuty}${how}${gist}${thread}${todo}${ask}${attach}${permit}${stop}`
  // The same rules in a line, for a session that has them whole further up.
  const brief = [
    "守则同前，要点：",
    isFront
      ? `你是前台，用 bench_overview / bench_peek（细看某栏传 part）看各项目，事带项目名和 t_…/m_… id；传话、催人、等验收用 bench_relay / bench_nudge / bench_review_card（几件用 bench_review_batch）起草卡片，${userName()} 点了才算；只有标着「可代签」的用 bench_accept 替他通过，没复验先 bench_check；他让盯项目用 bench_watch（对统筹 bench_nudge 直接以前台名义发出）；要紧事说完用 bench_notify 推摘要；`
      : "",
    replyByStdout ? "最后的回答直接输出，会挂成回复；" : "回复用 bench_say；",
    "第一行写一句 60 字以内的结论，群里默认只显示这一行；",
    `新功能先用 bench_task 建待办、bench_step 逐步推进，做完用 review 请 ${userName()} 验收，验收不要自己勾；`,
    `问 ${userName()} 用 bench_ask；附件用 ${replyByStdout ? "bench_attach" : "bench_say 的 attachments"}；`,
    claude && full ? "你有默认全部权限，不用 bench_elevate；" : claude ? "被权限拦住先用 bench_elevate 申请；" : "",
    codex && full ? "你有默认全部权限，没有沙箱；" : codex ? "出工作区照常申请提权，会弹到网页上；" : "",
    replyByStdout ? `交接完成就以「${END_MARK}」开头、不 @ 任何人。` : "交接完成就用 bench_say 带 end: true、不 @ 任何人。",
    "这条消息不会叫醒任何人。",
  ].join("")
  const rules = rulesFor(seat, whole, brief)
  return {
    text: `【并坐「${currentProjectInfo().name}」项目转来的消息】\n${scope}只略去了你自己说的话和入座、离席这类系统通知。★ 是在叫你的。\n\n${digest}${body}\n\n（${rules.text}）`,
    rules: rules.given,
  }
}

// After this many short reminders in a row the rules are said whole again,
// in case a compaction went by that the room could not see.
const RULES_SHORTS = 10

// The rules a wake ends with run to ~900 characters and stay in the seat's
// conversation, so they are said whole only when its session may not have
// them: its first wake, a new session, a new version of the rules, a
// compaction since they were last given (read from the session's record:
// Claude Code's compact_boundary, Codex's compacted), or every RULES_SHORTS
// wakes. Clients whose record the room can't read get them whole every time.
function rulesFor(seat: NonNullable<ReturnType<typeof agentState>> | undefined, whole: string, brief: string) {
  const sig = createHash("sha1").update(whole).digest("hex").slice(0, 12)
  const at = Date.now()
  const all = { text: whole, given: { sig, at } }
  const given = seat?.rulesGiven
  if (!seat || !given || seat.fresh || seat.reboundFrom || seat.profileDirty) return all
  if (given.sig !== sig || given.session !== seat.session || given.shorts >= RULES_SHORTS) return all
  if (!CONTEXT_KINDS.includes(seat.agentName ?? "")) return all
  const context = seatContext(seat.agentName, seat.session, seat)
  if (!context || (context.compacted && context.compacted.at >= given.at)) return all
  return { text: brief, given: { sig, at, short: true } }
}

function summaryPrompt(replyByStdout: boolean) {
  const source = summarySource()
  // The 「流程」 pieces that moved since their summary was written: written
  // along with this one, after it (lib/flow-summary.ts).
  const room = snapshot()
  const moved = flowsToSummarize(flowsOf(room.messages, room.tasks, room.agents, room.userName), source.previous)
  const byId = new Map(room.messages.map((message) => [message.id, message.text]))
  const taskTitle = new Map(room.tasks.map((task) => [task.id, task.title]))
  const flowBrief = flowSummaryPrompt(moved, source.previous, (node) =>
    (node.taskId ? taskTitle.get(node.taskId) : byId.get(node.id)) ?? node.title,
  )
  const previous = source.previous
    ? `【上一份摘要】（${source.previous.by} 写于 ${stamp(source.previous.at)}）\n${source.previous.text}`
    : "【上一份摘要】还没有，这是第一份。"
  const how = replyByStdout
    ? "直接输出摘要全文就行，你这次的输出会存成房间摘要，不会贴进群聊。"
    : "写好后调用 bench_summary 工具交上来，不要用 bench_say 发到群里。"
  // The prompt rides in one command-line argument, and Linux caps one argument
  // at 128 KB (spawn E2BIG): 40,000 Chinese characters are 120 KB by
  // themselves. So the whole prompt is held to a byte budget: the oldest
  // conversation lines go first; the 「流程」 part goes only if it alone leaves
  // too little room.
  let brief = flowBrief
  let flows = moved
  const fixed = (flowPart: string) =>
    Buffer.byteLength(
      [
        "【并坐房间请你写一份房间摘要】",
        "这次不用回复聊天，只写摘要。在上一份摘要的基础上，写一份完整的新摘要（不是只写增量），格式：",
        "## 结论\n## 进行中\n## 待定",
        "每部分用短句列点，写清谁负责、做到哪；没有的部分写「无」。不超过 1500 字。",
        previous,
        flowPart,
        how,
        "上一份摘要之后共 99999 条对话，太长只列了最近一部分，更早的略去了。",
      ].join("\n"),
    )
  if (SUMMARY_PROMPT_BYTES - fixed(brief) < 12_000) {
    brief = ""
    flows = []
  }
  const budget = SUMMARY_PROMPT_BYTES - fixed(brief)
  let body = source.text || "（没有新对话）"
  let cut = false
  if (Buffer.byteLength(body) > budget) {
    const lines = body.split("\n\n")
    while (lines.length > 1 && Buffer.byteLength(lines.join("\n\n")) > budget) lines.shift()
    body = lines.join("\n\n")
    cut = true
  }
  const scope = cut
    ? `上一份摘要之后共 ${source.count} 条对话，太长只列了最近一部分，更早的略去了。`
    : source.shown === source.count
      ? `下面是上一份摘要之后的全部 ${source.count} 条对话，一条没漏。`
      : `上一份摘要之后共 ${source.count} 条对话，太长只列了最近 ${source.shown} 条，更早的略去了。`
  return {
    upToSeq: source.upToSeq,
    text: [
      "【并坐房间请你写一份房间摘要】",
      "这次不用回复聊天，只写摘要。在上一份摘要的基础上，写一份完整的新摘要（不是只写增量），格式：",
      "## 结论\n## 进行中\n## 待定",
      "每部分用短句列点，写清谁负责、做到哪；没有的部分写「无」。不超过 1500 字。",
      "",
      previous,
      "",
      `【之后的对话】${scope}`,
      body,
      "",
      ...(brief ? [brief, ""] : []),
      `（${how}${brief ? "流程那一段写在同一份里，跟在「## 待定」后面。" : ""}）`,
    ].join("\n"),
    flowsAt: Object.fromEntries(flows.map((flow) => [flow.id, flow.lastAt])),
  }
}

function seconds(ms: number) {
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${s % 60} 秒`
}

// Whether a wake command prints an event stream (the core kinds' defaults
// and their wake scripts do).
function streams(command: string) {
  return /stream-json|--json\b|claude-code\.sh|codex-wake\.sh/.test(command)
}

// Failures whose cause is known get said in plain words instead of the
// client's own error line.
function explain(agentName: string | undefined, failure: string) {
  if (agentName === "antigravity" && /已尝试通过 .*启动 Antigravity 桌面端|仍未检测到可连接的 daemon hub/.test(failure)) {
    return "房间已尝试自动启动 Antigravity 桌面端，但等待超时仍未连上 daemon hub（~/.gemini/antigravity/daemon/hub_*.json）。请检查 Antigravity 窗口是否卡在登录页或启动异常，就绪后再重叫一次。"
  }
  if (agentName === "antigravity" && /未找到运行中|请先打开并登录 Antigravity/.test(failure)) {
    return "桌面端 Antigravity 没有在运行，或还没有可连接的 daemon hub（~/.gemini/antigravity/daemon/hub_*.json）。先打开并登录 Antigravity 桌面端，再重叫一次。"
  }
  if (agentName === "antigravity" && /trajectory .*not found/.test(failure)) {
    return "agy 和 Antigravity 桌面端的会话记录里都找不到它报的这个会话（~/.gemini/antigravity-cli、~/.gemini/antigravity 的 conversations 下）。会话可能被删了，或者入座时报错了 id，让它重新入座一次。"
  }
  if (agentName === "antigravity" && /stream was interrupted/i.test(failure)) {
    return "agy 这一轮半路断了。最常见的原因是它想用的工具（比如跑命令）在后台被拒：agy 被拒后不会接着回答，整轮直接结束。房间只在 Antigravity 桌面端的权限设为 Turbo 时替它放开；其他设置下，让它只用房间的工具，或者把桌面端改成 Turbo。也可能只是网络断了一下，再 @ 它一次试试。"
  }
  if (agentName === "workbuddy" && /Authentication required|\/login/i.test(failure)) {
    return "WorkBuddy 自带的命令行没有登录。桌面端的登录是加密存的，只交给它自己拉起的进程，房间借不到。让它在 WorkBuddy 窗口里「守着房间」（循环 bench_wait）就不用唤起；或者装完整版 codebuddy（npm i -g @tencent-ai/codebuddy-code）并在终端里 /login 一次，见 MAINTENANCE.md。"
  }
  if (agentName === "cursor" && /Model unavailable on Free/i.test(failure)) {
    return "Cursor 账号是免费版，这个模型用不了：免费版只能用 Grok 4.7、Grok 4.6 的固定档（比如 grok-4.7-medium，不带 -low、-fast）和 auto。在它的席位菜单「换模型…」里换一个。"
  }
  const provider = /This chat uses (\S+), but your current provider is (\S+?)\./.exec(failure)
  if (agentName === "codex" && provider) {
    return `这个会话是在 ${provider[1]} 上开的，Codex 现在接的是 ${provider[2]}（~/.codex/config.toml 的 model_provider），会话不能换提供方接着跑。要叫醒它，就把 Codex 切回 ${provider[1]}；或者在它的席位菜单「在同目录开新会话…」，开一个 ${provider[2]} 上的新会话。`
  }
  if (agentName === "dsh" && /cannot compose presets/.test(failure)) {
    return "它是在 DeepSeek Harness 网页端开的会话，带着 Agent 预设；房间用的 dsh-agent 只能接着跑它自己 exec 开的、不带预设的会话，叫不醒网页端的。让它在网页端「守着房间」（循环 bench_wait）就不用唤起；要叫得醒，就在终端用 dsh-agent exec 开会话再接入并坐。写摘要可以先换别人。"
  }
  const clean = unwrapErrorMessage(failure)
  const hit = detectLimit(clean) ?? detectLimit(failure)
  if (hit) {
    return hit.kind === "balance"
      ? "账户余额或可用额度不足，请到对应模型服务商或中转站充值后重试，或在席位菜单切换其他客户端接力。"
      : `模型额度已用完（${hit.label}），可以等待重置后重试，或在席位菜单切换其他客户端接力。`
  }
  const cap = capacityFailure(failure, clean)
  if (cap) {
    return `服务端当前算力不足或过载（503${cap.model ? `，模型 ${cap.model}` : ""} 暂无可用容量），并非本机网络或个人额度问题。可稍后重试，或在席位菜单切换模型或换客户端接力。`
  }
  if (isNetworkFailure(failure, clean)) {
    return "连接模型服务时发生网络波动或传输中断（如连接断开、TLS/EOF 或超时），可等待自动重试，或检查本机网络与代理设置。"
  }
  return clean
}

// A launcher that runs the client in its own network (bwrap plus socat
// bridging the room's port and the proxy) writes socat's complaints to the
// same stderr, like "2026/11/14 22:24:33 socat[52] E write(5, …): Broken
// pipe" when one side of a bridged connection hung up first. They are about
// the bridge, not the client: taken as its error, a compaction that had
// worked was reported as failed (2026-11-14).
const BRIDGE_NOISE = /^\d{4}\/\d\d\/\d\d \d\d:\d\d:\d\d socat\[\d+\] [EWNI] .*$/gm

function withoutBridgeNoise(text: string) {
  return text.replace(BRIDGE_NOISE, "").replace(/\n{2,}/g, "\n")
}

function tail(text: string, max: number) {
  const clean = text.trim().replace(/\s+/g, " ")
  return clean.length > max ? `…${clean.slice(-max)}` : clean
}

function clipFirstLine(text: string, max: number) {
  const first = unwrapErrorMessage(text).trim().split("\n")[0]?.replace(/\s+/g, " ").trim() ?? "出错"
  return first.length > max ? `${first.slice(0, max - 1)}…` : first
}

// Did the turn end on the account's usage limit or exhausted balance? Matched
// against failure lines, failed step details, and the client's last words — only
// checked when the turn actually failed so quoting limit text in chat never triggers it.
function limitOf(log: Run, out: string, failure = "") {
  const last = [...log.steps].reverse().find((step) => step.kind === "text")?.title ?? ""
  const failedSteps = log.steps.filter((step) => step.state === "failed")
  const candidates = [
    failure,
    ...failedSteps.map((step) => step.output ?? ""),
    ...failedSteps.map((step) => step.title ?? ""),
    out,
    last,
  ]
  for (const text of candidates) {
    if (!text.trim()) continue
    const hit = detectLimit(text)
    if (hit) return hit
  }
  return null
}

// Say in the room that a seat ran out of allowance, with the card that lets
// the user have it carry on once it resets. Returns whether it was one.
const SYSTEM_MAX = 96
function shortSys(text: string) {
  return text.length > SYSTEM_MAX ? `${text.slice(0, SYSTEM_MAX - 1)}…` : text
}

function shortExplain(agentName: string | undefined, failure: string) {
  const hit = detectLimit(failure)
  if (hit) return hit.kind === "balance" ? "余额不足，请充值或换客户端" : `${hit.label}已用完`
  const clean = unwrapErrorMessage(failure)
  const cap = capacityFailure(failure, clean)
  if (cap) return `服务暂无容量（503${cap.model ? `，${cap.model}` : ""}），可重试或换模型`
  if (isNetworkFailure(failure, clean)) return `网络错误：${clipFirstLine(clean, 44)}`
  if (agentName === "antigravity" && /已尝试通过 .*启动 Antigravity 桌面端|仍未检测到可连接的 daemon hub/.test(failure)) return "自动启动桌面端超时"
  if (agentName === "antigravity" && /未找到运行中|请先打开并登录 Antigravity/.test(failure)) return "桌面端未运行"
  if (agentName === "antigravity" && /trajectory .*not found/.test(failure)) return "找不到会话，需重入座"
  if (agentName === "antigravity" && /stream was interrupted/i.test(failure)) return "中途中断，查权限或重叫"
  if (agentName === "workbuddy" && /Authentication required|\/login/i.test(failure)) return "未登录"
  if (agentName === "cursor" && /Model unavailable on Free/i.test(failure)) return "免费版不支持该模型"
  if (agentName === "codex" && /This chat uses (\S+), but your current provider is (\S+?)\./.test(failure)) {
    return "提供方不匹配，需开新会话"
  }
  if (agentName === "dsh" && /cannot compose presets/.test(failure)) return "网页预设会话无法后台叫醒"
  return clipFirstLine(clean, 48)
}

function callFailureNote(failure: string, tried = "") {
  const hit = detectLimit(failure)
  if (hit) return `${hit.label}：${clipFirstLine(hit.text, 90)}`
  const clean = unwrapErrorMessage(failure)
  const cap = capacityFailure(failure, clean)
  if (cap) return `服务暂无容量（503${cap.model ? `，${cap.model}` : ""}）：${clipFirstLine(clean, 72)}${tried}`
  if (isNetworkFailure(failure, clean)) return `网络错误：${clipFirstLine(clean, 88)}${tried}`
  return `${clipFirstLine(clean, 120)}${tried}`
}

function noteLimit(agent: NonNullable<ReturnType<typeof agentState>>, log: Run, out: string, failure = "") {
  const hit = limitOf(log, out, failure)
  if (!hit) return false
  if (!log.steps.some((step) => step.state === "failed" && detectLimit(step.output ?? step.title))) {
    putStep(log, {
      id: "limit",
      at: Date.now(),
      kind: "note",
      state: "failed",
      title: hit.label,
      output: hit.text,
    })
  }
  const at = hit.kind === "balance" ? undefined : autoResumeAt(log, hit)
  setLimited(log, { resetsAt: hit.resetsAt, resumeAt: at })
  const when = hit.resetsAt ? `${whenText(hit.resetsAt)}重置` : hit.kind === "balance" ? "请充值或换客户端" : "未写重置时间"
  const headline = hit.kind === "balance" ? `${agent.name} ${hit.label}（${when}）` : `${agent.name} 撞上${hit.label}（${when}）`
  postLimited(shortSys(headline), {
    runId: log.id,
    agentId: agent.id,
    agentName: agent.name,
    label: hit.label,
    ...(hit.kind ? { kind: hit.kind } : {}),
    resetsAt: hit.resetsAt,
    state: at ? "scheduled" : "open",
    at,
  })
  if (at) armResume(log.id, at)
  return true
}

// The user's call (2026-11-16, t_51220c7e): a wake cut off by the 5-hour
// allowance carries on by itself once it resets, unless they turned that off
// (limit_resume). Only the short window: a weekly allowance, or a reset more
// than SHORT_WINDOW_MS away, stays a card for the user to decide.
const SHORT_WINDOW_MS = 5.5 * 60 * 60_000
// Woken at the reset and cut off again soon after: the reset time was wrong
// or the allowance is gone for longer. Don't go round again; the card waits.
const REHIT_MS = 15 * 60_000

function autoFired() {
  return (g().__benchLimitAutoFired ??= new Map<string, number>())
}

function autoResumeAt(log: Run, hit: { label: string; resetsAt?: number }) {
  if (!limitResume() || !hit.resetsAt || /周/.test(hit.label)) return undefined
  if (Date.now() - (autoFired().get(log.agentId) ?? 0) < REHIT_MS) return undefined
  if (hit.resetsAt - Date.now() > SHORT_WINDOW_MS || !rewakeable(log)) return undefined
  return hit.resetsAt + RESUME_MARGIN_MS
}

// Whether rewake() below can take this run up again.
function rewakeable(log: Run) {
  if (log.purpose === "private" || log.purpose === "goal") return Boolean(log.ask)
  if (log.purpose === "summary" || log.purpose === "compact") return true
  if (log.purpose === "check" || log.purpose === "gist") return false
  return Boolean(log.body)
}

function reportFailure(agent: NonNullable<ReturnType<typeof agentState>>, log: Run, failure: string, out: string, what: string) {
  if (noteLimit(agent, log, out, failure)) return
  const detail = explain(agent.agentName, failure)
  const clean = unwrapErrorMessage(failure)
  putStep(log, {
    id: "explain",
    at: Date.now(),
    kind: "note",
    state: "failed",
    title: "失败原因说明",
    output: detail !== failure ? `${detail}\n\n原始报错：\n${failure}` : clean !== failure ? `${clean}\n\n原始报错：\n${failure}` : failure,
  })
  postSystem(shortSys(`${what}没成功：${shortExplain(agent.agentName, failure)}`), log.id)
}

// Runs one command on a seat's session and reports how it went. Its output
// is read line by line as it comes: each step goes into the run log (the
// 「过程」 panel) and the seat line shows the current one; `out` is the
// final answer.
function launch(
  agent: NonNullable<ReturnType<typeof agentState>>,
  command: string,
  run: Run,
  live: (line: string) => void,
  done: (result: { out: string; failure?: string; stopped?: boolean; lost?: boolean }) => void,
  // The client's first output: it has the wake.
  first?: () => void,
) {
  const parser = createParser()
  const decoder = new StringDecoder("utf8")
  let pending = ""
  let lost = false
  let err = ""
  let finished = false
  let shownAt = 0
  let endedTimer: NodeJS.Timeout | undefined
  const take = bindProject((line: string) => {
    const wasEnded = parser.ended()
    for (const step of parser.feed(line)) {
      putStep(run, step)
      const text = liveLine(step)
      if (text && Date.now() - shownAt >= LIVE_GAP_MS) {
        shownAt = Date.now()
        live(text)
      }
    }
    // Its turn is over. Give the process a moment to exit on its own; if it
    // stays (a background task it left running keeps it alive), end it here,
    // so the answer goes up now and not whenever the process gets round to it. Not left
    // running longer: the seat's next wake resumes the same session.
    if (!wasEnded && parser.ended() && !finished) {
      endedTimer = setTimeout(() => {
        if (finished) return
        putStep(run, { id: "linger", at: Date.now(), kind: "note", title: `答完了，进程过了 ${seconds(END_GRACE_MS)}还没退出（多半是它在后台挂了任务），已收掉`, state: "done" })
        kill()
        finish(0)
      }, END_GRACE_MS)
    }
  })
  let stopped = false
  let quiet: NodeJS.Timeout | undefined
  let watch: NodeJS.Timeout | undefined = undefined
  const finish = bindProject((code: number | null, failure?: string) => {
    if (finished) return
    finished = true
    lane(agent.id).stop = undefined
    // A woken run is one-shot: a wait loop it ran (bench_wait) ends with it,
    // so later mentions wake it again instead of waiting for a loop that's gone.
    clearStandby(agent.id)
    clearTimeout(endedTimer)
    clearInterval(quiet)
    clearInterval(watch)
    if (pending) take(pending)
    const out = parser.answer()
    // Some CLIs print their error to stderr and still exit 0 (WorkBuddy's when
    // signed out); with no answer at all, that error is the outcome.
    const said = withoutBridgeNoise(err)
    const streamErr = parser.error()
    const failedStepText = run.steps.find((step) => step.state === "failed")?.title ?? ""
    const silent =
      code === 0 &&
      !out.trim() &&
      (Boolean(streamErr) || Boolean(failedStepText) || (run.steps.length === 0 && Boolean(said.trim())))
    const usableStreamErr = streamErr && streamErr !== "出错了" ? streamErr : ""
    const why =
      failure ??
      (code !== 0
        ? usableStreamErr || tail(said, 240) || failedStepText || streamErr || `退出码 ${code}`
        : silent
          ? usableStreamErr || failedStepText || tail(said, 240) || streamErr
          : undefined)
    done(stopped ? { out: "", stopped } : { out, failure: why, lost })
  })

  // Its own process group, so stopping it also ends what the shell started.
  // Windows runs it through Git Bash (lib/platform.ts) and has no groups.
  let launch: [string, string[]]
  try {
    launch = commandLine(command)
  } catch (error) {
    finish(null, (error as Error).message)
    return
  }
  let child: ChildProcessByStdio<null, Readable, Readable>
  try {
    const adapter = agent.agentName ? adapterFor(agent.agentName) : null
    const pickedModel = agent.modelPick || (agent.agentName === "codex" && adapter ? modelOf(adapter) : null) || undefined
    child = spawn(launch[0], launch[1], {
      detached: true,
      windowsHide: true,
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PATH: summonPath(),
        BENCH_URL: roomUrl(),
        BENCH_AGENT: agent.agentName,
        BENCH_UUID: agent.session,
        BENCH_SESSION: agent.session,
        // Lets a hook in the run fetch what calls the seat meanwhile (takeQueued).
        ...(lane(agent.id).key ? { BENCH_RUN_KEY: lane(agent.id).key } : {}),
        // A session the room created: where its first wake starts it.
        ...(agent.workdir ? { BENCH_NEW_DIR: agent.workdir } : {}),
        // The model the user picked for it (lib/models.ts); unset, the default.
        ...(pickedModel ? { BENCH_MODEL: pickedModel } : {}),
        // And how hard it thinks, for the scripts that pass it on.
        ...(agent.effortPick ? { BENCH_EFFORT: agent.effortPick } : {}),
        // Where its context compacts by itself, if the user set one (lib/context.ts).
        ...compactEnv(agent),
      },
    })
  } catch (error) {
    // E2BIG (a prompt too long for one argument) and the like: end it here, or
    // the seat stays 'running' with nothing to stop.
    finish(null, `起不来：${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`)
    return
  }
  const kill = () => {
    try {
      if (child.pid) killTree(child.pid)
    } catch {
      child.kill("SIGTERM")
    }
  }
  lane(agent.id).stop = () => {
    stopped = true
    kill()
    finish(null)
  }
  // No time limit: an agent may work for hours. A run ends when the process
  // does, when its turn is over (above), or when the user presses stop.
  if (streams(command)) {
    const since = Date.now()
    quiet = setInterval(bindProject(() => {
      const waited = `还没开始回应，已等 ${seconds(Date.now() - since)}（多半是它的服务在排队）`
      putStep(run, { id: "wait", at: since, kind: "note", title: waited, state: "running" })
      live(waited)
    }), WAIT_NOTE_MS)
  }
  // Watches for the two quiet cases above, once a minute (the env vars only
  // shorten the waits for tests).
  let heardAt = Date.now()
  const repliedEnd = envDelay("BENCH_REPLIED_END_MS", REPLIED_END_MS)
  const silentNote = envDelay("BENCH_SILENT_NOTE_MS", SILENT_NOTE_MS)
  watch = setInterval(bindProject(() => {
    if (finished) return clearInterval(watch)
    const now = Date.now()
    const replied = parser.repliedAt()
    if (replied && now - replied >= repliedEnd) {
      clearInterval(watch)
      putStep(run, { id: "linger", at: now, kind: "note", title: `答完了，过了 ${seconds(now - replied)}进程还没退出，也没说结束，已收掉`, state: "done" })
      kill()
      finish(0)
      return
    }
    if (now - heardAt >= silentNote) {
      const title = `已经 ${Math.floor((now - heardAt) / 60_000)} 分钟没动静`
      putStep(run, { id: "silent", at: heardAt, kind: "note", title, state: "running" })
      live(title)
    }
  }), Math.max(50, Math.min(60_000, Math.floor(Math.min(repliedEnd, silentNote) / 4))))
  watch.unref?.()
  child.stdout.on("data", bindProject((chunk: Buffer) => {
    if (run.steps.some((step) => step.id === "silent" && step.state === "running")) {
      putStep(run, { id: "silent", at: heardAt, kind: "note", title: `停了 ${Math.floor((Date.now() - heardAt) / 60_000)} 分钟，又有动静了`, state: "done" })
    }
    heardAt = Date.now()
    if (first) {
      const tell = first
      first = undefined
      tell()
    }
    if (quiet) {
      clearInterval(quiet)
      quiet = undefined
      if (run.steps.some((step) => step.id === "wait")) {
        putStep(run, { id: "wait", at: run.startedAt, kind: "note", title: `等了 ${seconds(Date.now() - run.startedAt)} 才开始回应`, state: "done" })
      }
    }
    const lines = (pending + decoder.write(chunk)).split("\n")
    pending = lines.pop() ?? ""
    for (const line of lines) take(line)
    if (pending.length > LINE_LIMIT) {
      pending = ""
      lost = true
    }
  }))
  child.stderr.on("data", (chunk: Buffer) => {
    err = (err + chunk.toString("utf8")).slice(-4000)
  })
  child.on("error", (error) => finish(null, error.message))
  child.on("close", (code) => finish(code))
}

const INTERRUPTED_DOING = "被服务器重启打断了"

// Shows the seat as busy while a command runs, and puts back what it was
// doing before, unless it changed that itself meanwhile. Room-written restart
// notices (INTERRUPTED_DOING) are cleared as soon as the next wake begins so
// settle() never restores them.
function busy(agentId: string, doing: string) {
  const prev = agentState(agentId)?.doing ?? ""
  const before = prev === INTERRUPTED_DOING ? "" : prev
  let shown = doing
  try {
    pulseAgent(agentId, "working", doing)
  } catch {}
  return {
    // The current step, while the seat still shows what we put there.
    live(line: string) {
      const still = agentState(agentId)
      if (!still || (still.doing !== shown && !askSettled(still.doing))) return
      shown = line
      try {
        pulseAgent(agentId, "working", line)
      } catch {}
    },
    settle() {
      // Whatever it said it was doing in this wake ended with it (lib/status.ts).
      try {
        ranUntilNow(agentId)
      } catch {}
      const still = agentState(agentId)
      // A question still unanswered stays up after the run; an answered one gives way.
      if (still && (still.doing === shown || (askSettled(still.doing) && !still.doing.startsWith("问了")) || still.doing === INTERRUPTED_DOING)) {
        try {
          pulseAgent(still.id, "idle", before)
        } catch {}
      }
    },
  }
}

function run(agentId: string) {
  const queue = lane(agentId)
  if (queue.running) return
  const agent = agentState(agentId)
  if (!agent || !agent.agentName || !agent.session) {
    note(queue.pending.map((item) => item.id), agentId, "failed", { note: "这个席位没有会话，叫不醒" })
    dropChecks(queue, "复验人没有会话，叫不醒")
    queue.pending = []
    queue.summary = false
    queue.compact = false
    queue.goal = undefined
    syncLane(agentId)
    return
  }
  const adapter = adapterFor(agent.agentName)
  if (!adapter) {
    note(queue.pending.map((item) => item.id), agentId, "failed", { note: `没有 ${agent.agentName} 的唤起命令` })
    dropChecks(queue, `没有 ${agent.agentName} 的唤起命令`)
    queue.pending = []
    queue.summary = false
    queue.compact = false
    queue.goal = undefined
    syncLane(agentId)
    return
  }
  // Its session is open in a terminal on the page (lib/terminal.ts): what
  // calls it is typed in there. A summary, a compaction or a word in private
  // waits until the terminal closes.
  if (terminalOpen(agentId)) {
    intoTerminal(agent, queue)
    return
  }
  // Urgent private words from the user always go through, even if the room
  // queue is paused.
  if (queue.whisper !== undefined) {
    const text = queue.whisper
    queue.whisper = undefined
    syncLane(agentId)
    answerWhisper(agent, text)
    return
  }
  // When the user pauses a seat's queue, queued mentions and tasks stay held
  // in SQLite until resumed (or individually dropped).
  if (queue.paused) return

  if (queue.summary) {
    queue.summary = false
    syncLane(agentId)
    writeSummary(agent, adapter)
    return
  }
  if (queue.compact) {
    queue.compact = false
    syncLane(agentId)
    compactSession(agent)
    return
  }
  const check = queue.checks?.shift()
  if (check) {
    syncLane(agentId)
    checkTask(agent, check)
    return
  }
  if (queue.gists?.length) {
    const ids = queue.gists.splice(0, GIST_BATCH)
    if (queue.gists.length === 0) queue.gists = undefined
    writeGists(agent, ids)
    return
  }
  if (queue.goal !== undefined) {
    const text = queue.goal
    queue.goal = undefined
    syncLane(agentId)
    setGoal(agent, adapter, text)
    return
  }
  if (queue.pending.length === 0 && !queue.carry) return
  // Waiting to try a failed wake again: its timer runs it. A new message for
  // the seat goes now and takes the waiting ones along.
  if (queue.retryAt && queue.pending.length === 0 && Date.now() < queue.retryAt) return
  clearRetry(queue)

  const seen = catchUp(agentId, CATCH_UP_CHARS, queue.dropped ? new Set(queue.dropped) : undefined)
  queue.dropped = undefined
  // Its inbox may already have shown it the mention; fall back to the queue.
  const fresh = seen.text || queue.pending.map((item: { line: string }) => item.line).join("\n\n")
  const carried = queue.carry
  queue.carry = undefined
  const body = withCarry(carried, fresh)
  const owes = owesLine(agentId, body)
  const wrapped = envelope(owes ? `${body}\n\n${owes}` : body, seen.skipped, seen.summary, adapter.reply === "stdout", agent.agentName ?? "", Boolean(agent.autoFull), agent)
  const command = commandFor(
    agent.agentName,
    agent.session,
    introduce(agent) + wrapped.text,
    agent.modelPick,
    agent.effortPick,
  )
  const hop = queue.hops
  const trigger = queue.trigger
  const answering = [...(queue.carryIds ?? []), ...queue.pending.map((item) => item.id)]
  queue.carryIds = undefined
  queue.pending = []
  queue.hops = 0
  queue.trigger = undefined
  syncLane(agentId)
  if (!command) {
    note(answering, agentId, "failed", { note: "拼不出它的唤起命令" })
    return
  }

  queue.running = true
  const startedLink = { agentName: agent.agentName, session: agent.session }
  const log = startRun(agentId, agent.name, "reply", { project: currentProject(), body, replyTo: trigger })
  queue.key = randomBytes(12).toString("hex")
  queue.project = currentProject()
  queue.log = log
  queue.midHop = undefined
  queue.calls = answering
  note(answering, agentId, "started", { runId: log.id })
  const seat = busy(agentId, "被点到了，正在回复")
  launch(agent, command, log, seat.live, ({ out, failure, stopped, lost }) => {
    queue.running = false
    queue.key = undefined
    queue.log = undefined
    // Those it was handed in the middle of the run are answered with it.
    const answered = queue.calls ?? answering
    queue.calls = undefined
    const reach = Math.max(hop, queue.midHop ?? 0)
    queue.midHop = undefined
    const still = agentState(agentId)
    const sameBinding = still?.agentName === startedLink.agentName && still?.session === startedLink.session
    if (lost && !stopped) {
      postSystem(shortSys(`${agent.name} 单行超 8MB 已略过`), log.id)
    }
    if (stopped) {
      if (queue.whisper === undefined) queue.retries = undefined
      // Stopped for an interjection: pick these messages up again after it.
      if (queue.whisper !== undefined) {
        queue.carry = body
        queue.carryIds = answered
        queue.trigger ??= trigger
        queue.hops = Math.max(queue.hops, hop)
        syncLane(agentId)
        note(answered, agentId, "queued", { note: "被单独说打断，回完接着做" })
      } else {
        note(answered, agentId, "stopped")
      }
      endRun(log, "failed", queue.whisper !== undefined ? "被单独插话打断，回完接着做" : "被你停下了")
      seat.settle()
      run(agentId)
      return
    } else if (failure) {
      const tries = queue.retries ?? 0
      const delays = retryDelays()
      const failedOrStreamTexts = log.steps.flatMap((s) =>
        s.state === "failed" || (s.id === "stream-error" && s.state === "running") ? [s.title, s.output] : [],
      )
      const network = !limitOf(log, out, failure) && isNetworkFailure(failure, failedStep(log), ...failedOrStreamTexts)
      if (network && netRetry() && tries < delays.length && sameBinding) {
        // The network dropped: the same messages go again by themselves after
        // a while, as if the wake had been cut short. Nothing is said in the
        // room unless the last try fails too.
        const wait = delays[tries]
        queue.retries = tries + 1
        queue.carry = body
        queue.carryIds = answered
        queue.trigger ??= trigger
        queue.hops = Math.max(queue.hops, hop)
        queue.retryAt = Date.now() + wait
        syncLane(agentId)
        note(answered, agentId, "retrying", { note: `${tries + 1}/${delays.length}，网络错误，${seconds(wait)}后再叫：${clipFirstLine(failure, 80)}` })
        const cap = capacityFailure(failure, unwrapErrorMessage(failure), ...failedOrStreamTexts)
        endRun(log, "failed", `${cap ? "服务端暂无容量（503）" : "网络错误"}，${seconds(wait)}后自动重试（${tries + 1}/${delays.length}）：${unwrapErrorMessage(failure)}`)
        seat.settle()
        armRetry(agentId, wait)
        return
      }
      queue.retries = undefined
      const tried = network && tries > 0 ? `（自动重试了 ${tries} 次）` : ""
      note(answered, agentId, "failed", { note: callFailureNote(failure, tried) })
      reportFailure(agent, log, `${failure}${tried}`, out, `${agent.name} 叫醒`)
    } else if (adapter.reply === "stdout" && still && sameBinding && out) {
      try {
        // Posted while the run is still open, so the message links to it.
        const said = sayAs({ type: "agent", id: still.id, name: still.name }, { text: out.slice(0, 4000) }, { final: true })
        hops().set(said.message.id, reach + 1)
        if (hops().size > 500) hops().delete(hops().keys().next().value ?? "")
      } catch (error) {
        console.error(error)
      }
    }
    if (!failure) {
      queue.retries = undefined
      markWoken(agentId, startedLink, wrapped.rules)
      // Ended well. Whether it spoke is a separate fact: a wake that ran to
      // the end without a word in the room is not an answer.
      const said = saidInRun(agentId, log.id)
      note(answered, agentId, said ? "answered" : "silent")
      // What it took by itself meanwhile (a wait loop inside this wake) too.
      if (said) {
        try {
          settleCalls(agentId)
        } catch {}
      }
    }
    const endShort = failure ? shortExplain(agent.agentName, failure) : undefined
    endRun(
      log,
      failure ? "failed" : "done",
      endShort ? `没成功：${endShort}` : undefined,
      failure && endShort !== failure ? failure : undefined,
    )
    seat.settle()
    run(agentId)
  }, () => note(queue.calls, agentId, "picked", { from: ["started"], run: log.id }))
}

// The error step the client's own stream ended on, if any (lib/events.ts).
function failedStep(log: Run) {
  return log.steps.find((step) => step.kind === "note" && step.state === "failed")?.title
}

function clearRetry(queue: Lane) {
  clearTimeout(queue.retryTimer)
  queue.retryTimer = undefined
  queue.retryAt = undefined
}

function armRetry(agentId: string, wait: number) {
  const queue = lane(agentId)
  clearTimeout(queue.retryTimer)
  queue.retryTimer = setTimeout(
    bindProject(() => {
      queue.retryTimer = undefined
      queue.retryAt = undefined
      // Stopped or taken out of the queue meanwhile: nothing left to try.
      if (!queue.carry) {
        queue.retries = undefined
        return
      }
      run(agentId)
    }),
    wait,
  )
}

function intoTerminal(agent: NonNullable<ReturnType<typeof agentState>>, queue: ReturnType<typeof lane>) {
  if (queue.paused) return
  // A /goal is typed in just as the user wrote it: the client's own command.
  if (queue.goal !== undefined && accepting(agent.id)) {
    deliver(agent.id, goalLine(queue.goal))
    queue.goal = undefined
    syncLane(agent.id)
  }
  // On its way out: it all waits for the closing, then runs the usual way.
  if ((queue.pending.length === 0 && !queue.carry) || !accepting(agent.id)) return
  const seen = catchUp(agent.id, CATCH_UP_CHARS, queue.dropped ? new Set(queue.dropped) : undefined)
  queue.dropped = undefined
  const fresh = seen.text || queue.pending.map((item: { line: string }) => item.line).join("\n\n")
  const carried = queue.carry
  queue.carry = undefined
  const body = withCarry(carried, fresh)
  clearRetry(queue)
  queue.retries = undefined
  // No wake to follow from here on: it counts as answered when the seat next
  // speaks in the room (settleCalls).
  note([...(queue.carryIds ?? []), ...queue.pending.map((item) => item.id)], agent.id, "picked", { note: "打进了它开着的终端" })
  queue.carryIds = undefined
  queue.pending = []
  queue.hops = 0
  queue.trigger = undefined
  syncLane(agent.id)
  // Typed in, there is no answer to read off stdout: it replies with bench_say.
  // Its permission prompts show in the terminal itself, not on the page.
  const startedLink = { agentName: agent.agentName, session: agent.session }
  const owes = owesLine(agent.id, body)
  const wrapped = envelope(owes ? `${body}\n\n${owes}` : body, seen.skipped, seen.summary, false, "", false, agent)
  deliver(agent.id, introduce(agent) + wrapped.text)
  markWoken(agent.id, startedLink, wrapped.rules)
}

export function isSeatBusy(agentId: string) {
  return Boolean(lanesMap().get(agentId)?.running) || terminalOpen(agentId)
}

// The user opens a seat's terminal. Not while a headless wake runs on the
// same session: they would both write to it.
export function openSeatTerminal(agentId: string, cols?: unknown, rows?: unknown) {
  const agent = agentState(agentId)
  if (!agent) throw new ApiError(404, "这个席位不在了")
  if (lane(agentId).running) throw new ApiError(409, `${agent.name} 正在跑一轮，等它做完或先停下，再开终端`)
  return openTerminal(agentId, cols, rows)
}

function writeSummary(agent: NonNullable<ReturnType<typeof agentState>>, adapter: Adapter) {
  const byStdout = adapter.reply === "stdout"
  const prompt = summaryPrompt(byStdout)
  const command = commandFor(agent.agentName ?? "", agent.session ?? "", prompt.text, agent.modelPick, agent.effortPick)
  if (!command) return
  const queue = lane(agent.id)
  queue.running = true
  const asked = Date.now()
  startSummaryJob(agent.id, prompt.upToSeq, prompt.flowsAt)
  const log = startRun(agent.id, agent.name, "summary", { project: currentProject() })
  const seat = busy(agent.id, "在写房间摘要")
  launch(agent, command, log, seat.live, ({ out, failure, stopped }) => {
    queue.running = false
    endRun(log, failure || stopped ? "failed" : "done", stopped ? "被停下了" : failure ? `没成功：${failure}` : undefined)
    seat.settle()
    endSummaryJob(agent.id)
    if (stopped) {
      // An interjection asks for the summary again afterwards; a plain stop drops it.
      if (queue.whisper !== undefined) queue.summary = true
    } else if (failure) {
      reportFailure(agent, log, failure, out, `${agent.name} 写摘要`)
    } else if (byStdout) {
      try {
        saveSummary(out, agent.name, prompt.upToSeq, prompt.flowsAt)
      } catch {
        postSystem(shortSys(`${agent.name} 未写出房间摘要`), log.id)
      }
    } else if ((snapshot().summary?.at ?? 0) < asked) {
      // Some models write the summary as their answer instead of calling
      // bench_summary; a full one in the asked format is taken as handed in.
      const written = out.slice(out.indexOf("## 结论")).trim()
      if (out.includes("## 结论") && written.includes("## 进行中") && written.includes("## 待定")) {
        saveSummary(written, agent.name, prompt.upToSeq, prompt.flowsAt)
      } else {
        postSystem(shortSys(`${agent.name} 本轮未交房间摘要`), log.id)
      }
    }
    run(agent.id)
  })
}

// 「请验收时先复验」: when an owner asks for review, the project's checker
// (Agent.checker, set in the project settings) is woken on its own, like a
// summary: nothing goes into the room. It gets the task and is told to look
// without changing anything, and to answer with one verdict line; the room
// reads that off its output (no bridge tool to add, so no client has to
// restart its bridge). The verdict stays on the task (Task.check) for the
// review card; a "failed" doesn't send the task back, the user decides.
const VERDICT = /复验结论\s*[:：]\s*(通过|没过|没验到)/g
const VERDICT_STATE = { 通过: "passed", 没过: "failed", 没验到: "unverified" } as const
const CHECK_KIND_RE = /类别\s*[:：]\s*(跑得出(?:结果)?|要人看|只能本人签)/g
const CHECK_GAPS_RE = /(?:^|\n)\s*没验到的\s*[:：]\s*([\s\S]*)$/
const CHECK_COMPACT_EVERY = Number(process.env.BENCH_CHECK_COMPACT_EVERY) || 5

// A seat whose check could not run is left alone this long before the pick
// tries it again.
const FAILED_CHECKER_MS = 30 * 60_000

function pickAutoChecker(task: Task, avoid: string[] = []): { seat?: PublicAgent; why?: string } {
  const snap = snapshot()
  const owner = task.ownerId ? agentState(task.ownerId) : undefined
  const ownerKind = owner?.agentName ?? ""
  const now = Date.now()
  const limited = limitedAgentNames(now)
  const isLimited = (kind: string) => Boolean(kind) && (limited.has(kind) || isKindQuotaBlocked(kind, now))

  const others = snap.agents.filter((item) => !item.demo && item.id !== task.ownerId)
  if (others.length === 0) {
    return { why: "自动挑复验人：项目里没有除负责人以外的席位，这次跳过" }
  }

  // Who has had a to-do of their own in this project (peers).
  const worked = new Set<string>()
  for (const item of snap.tasks) if (item.ownerId) worked.add(item.ownerId)
  // Whose check could not run lately: the wake failed or it answered without
  // a verdict (checkTask notes it; not one cut by a restart or stopped by the
  // user). Kept in memory, not read off the to-dos: queueing a check again
  // replaces the record of the one that failed before the pick runs.
  const failed = (g().__benchCheckFailed ??= new Map())
  const failedLately = (id: string) => now - (failed.get(id) ?? 0) < FAILED_CHECKER_MS

  const reasons: string[] = []
  const candidates = others.filter((item) => {
    if (avoid.includes(item.id)) {
      reasons.push(`${item.name} 刚才没接上`)
      return false
    }
    const agent = agentState(item.id)
    if (!agent?.agentName || !agent.session || !adapterFor(agent.agentName)) {
      reasons.push(`${item.name} 叫不醒`)
      return false
    }
    if (isStandby(item.id)) {
      reasons.push(`${item.name} 正在守候`)
      return false
    }
    if (terminalOpen(item.id) || lane(item.id).paused) {
      reasons.push(`${item.name} 队列暂停或终端开着`)
      return false
    }
    if (isLimited(agent.agentName)) {
      reasons.push(`${item.name}（${agent.agentName}）正被限额拦着`)
      return false
    }
    if (failedLately(item.id)) {
      reasons.push(`${item.name} 刚才复验没跑成`)
      return false
    }
    return true
  })

  if (candidates.length === 0) {
    return { why: `自动挑不到复验人（${reasons.join("；") || "无可用席位"}），这次跳过` }
  }

  // Peers before anyone else: a seat that has had work of its own here knows
  // the code and how to run it. Helper seats (the one kept for gists, on a
  // cheap model) never own a to-do; in AverageJoe's rooms on 2026-11-16,
  // "a different client first" alone would have given all 21 waiting to-dos
  // of one project to its gist seat, the only seat there not on Claude. With
  // no peer to be had (a small project), anyone who can be woken may check.
  const peers = candidates.filter((item) => worked.has(item.id))
  const pool = peers.length > 0 ? peers : candidates

  pool.sort((a, b) => {
    // 1. Different client kind from the task owner first.
    const aDiff = ownerKind && a.agentName !== ownerKind ? 0 : 1
    const bDiff = ownerKind && b.agentName !== ownerKind ? 0 : 1
    if (aDiff !== bDiff) return aDiff - bDiff

    // 2. Not currently running first (and fewer queued items when both idle).
    const aBusy = lane(a.id).running || Boolean(activeRun(a.id)) || a.status === "working" ? 1 : 0
    const bBusy = lane(b.id).running || Boolean(activeRun(b.id)) || b.status === "working" ? 1 : 0
    if (aBusy !== bBusy) return aBusy - bBusy

    const aLoad = (lane(a.id).checks?.length ?? 0) + lane(a.id).pending.length
    const bLoad = (lane(b.id).checks?.length ?? 0) + lane(b.id).pending.length
    if (aLoad !== bLoad) return aLoad - bLoad

    // 3. Quietest for longest (smallest last-active timestamp) first.
    const aLast = Math.max(a.lastSeenAt ?? 0, a.ranUntil ?? 0)
    const bLast = Math.max(b.lastSeenAt ?? 0, b.ranUntil ?? 0)
    return aLast - bLast
  })

  return { seat: pool[0] }
}

// `cause`: why it is being queued again (lib/summon.ts repickCheck): it sat
// in a queue too long, or its checker hit a usage limit. Then the project's
// chosen checker gives way to the pick too, and no seat at all is an error
// (or, for a limit, a wait for the soonest reset), not a skip.
function requestCheck(taskId: string, at: number, cause?: "stale" | "limit") {
  const snap = snapshot()
  const task = snap.tasks.find((item) => item.id === taskId)
  if (!task || task.check?.at !== at) return
  const skip = (note: string) => setTaskCheck(taskId, at, { state: "skipped", note })
  const avoid = task.check?.avoid ?? []

  const fixed = snap.agents.find((item) => item.checker)
  const fixedKind = fixed ? agentState(fixed.id)?.agentName : undefined
  const fixedLimited = Boolean(fixedKind && (limitedAgentNames().has(fixedKind) || isKindQuotaBlocked(fixedKind)))
  let seat = fixed && !avoid.includes(fixed.id) && !fixedLimited ? fixed : undefined
  if (!seat) {
    if (fixed || cause || autoCheckHere()) {
      const picked = pickAutoChecker(task, avoid)
      if (!picked.seat) {
        if (!cause && !fixed) skip(picked.why ?? "自动挑不到复验人，这次跳过")
        else noCheckerLeft(task, cause ?? "limit")
        return
      }
      seat = picked.seat
    } else {
      skip("复验人已经取消了，这次没复验")
      return
    }
  } else if (seat.id === task.ownerId) {
    skip(`复验人 ${seat.name} 就是这条的负责人，这次跳过`)
    return
  }

  const agent = agentState(seat.id)
  if (!agent?.agentName || !agent.session || !adapterFor(agent.agentName)) {
    return skip(`复验人 ${seat.name} 叫不醒（没有会话或唤起命令），这次跳过`)
  }
  if (isStandby(agent.id)) return skip(`复验人 ${seat.name} 正挂在 bench_wait 里自己守着房间，叫不醒，这次跳过`)
  setTaskCheck(taskId, at, { state: "queued", by: seat.id, name: seat.name, queuedAt: Date.now() })
  const queue = lane(agent.id)
  queue.checks = [...(queue.checks ?? []).filter((item) => item.taskId !== taskId), { taskId, at }]
  syncLane(agent.id)
  run(agent.id)
}

// Checks a seat had queued, when it can't take them after all.
function dropChecks(queue: Lane, why: string) {
  for (const item of queue.checks ?? []) {
    try {
      if (setTaskCheck(item.taskId, item.at, { state: "error", note: `复验没跑成：${why}` })) noteCheckSettled(item.taskId)
    } catch {}
  }
  queue.checks = undefined
}

// ---- A check never waits for ever (t_96eb4124) ----
// A check queued on a seat that never gets to it (its queue paused, a
// terminal open, a long wake) goes to another seat after BENCH_CHECK_STALE_MS
// (15 minutes), at most twice, then it is an error. One whose checker hits
// a usage limit goes to another seat at once, also at most twice; with
// every seat out of quota it waits for the soonest reset, once. One whose
// owner never asked for review is not checked. A sweep looks every minute;
// no timer per check.
const CHECK_MAX_REPICKS = 2
const CHECK_SWEEP_MS = 60_000
const CHECK_SWEEP_VERSION = 1

function dropQueuedCheck(seatId: string, taskId: string) {
  const queue = lanesMap().get(seatId)
  if (!queue?.checks?.some((item) => item.taskId === taskId)) return
  queue.checks = queue.checks.filter((item) => item.taskId !== taskId)
  if (queue.checks.length === 0) queue.checks = undefined
  syncLane(seatId, false)
}

function noCheckerLeft(task: Task, cause: "stale" | "limit") {
  const check = task.check
  if (!check) return
  if (cause === "limit" && !check.waited) {
    const waitUntil = earliestLimitReset() ?? Date.now() + 30 * 60_000
    setTaskCheck(task.id, check.at, {
      state: "queued",
      by: undefined,
      name: undefined,
      waitUntil,
      note: `能查的 AI 都撞了额度，${whenText(waitUntil)}重置后再排一次`,
    })
    return
  }
  setTaskCheck(task.id, check.at, { state: "error", note: "没有空着的 AI 来检查" })
  noteCheckSettled(task.id)
}

// Take a check off the seat it waits on and give it to another.
function repickCheck(taskId: string, cause: "stale" | "limit", from?: string) {
  const task = snapshot().tasks.find((item) => item.id === taskId)
  const check = task?.check
  if (!task || !check) return
  const away = from ?? check.by
  if (away) dropQueuedCheck(away, taskId)
  const avoid = [...new Set([...(check.avoid ?? []), ...(away ? [away] : [])])]
  const repicks = (check.repicks ?? 0) + 1
  if (repicks > CHECK_MAX_REPICKS) {
    setTaskCheck(taskId, check.at, { avoid, repicks })
    noCheckerLeft({ ...task, check: { ...check, avoid, repicks } }, cause)
    return
  }
  setTaskCheck(taskId, check.at, { state: "queued", by: undefined, name: undefined, runId: undefined, note: undefined, avoid, repicks })
  requestCheck(taskId, check.at, cause)
}

export function sweepChecks(now = Date.now()) {
  for (const project of listProjects()) {
    if (project.front) continue
    try {
      inProject(project.id, () => {
        for (const task of snapshot().tasks) {
          const check = task.check
          if (check?.state !== "queued") continue
          if (!reviewAsked(task)) {
            if (check.by) dropQueuedCheck(check.by, task.id)
            setTaskCheck(task.id, check.at, { state: "skipped", note: "负责人还没请验收，等它请了再检查" })
            continue
          }
          if (check.waitUntil) {
            if (now < check.waitUntil) continue
            // The reset has come: every seat again, once.
            setTaskCheck(task.id, check.at, { waitUntil: undefined, waited: true, avoid: [], repicks: 0, note: undefined })
            requestCheck(task.id, check.at, "limit")
            continue
          }
          if (now - (check.queuedAt ?? check.at) >= checkStaleMs()) repickCheck(task.id, "stale")
        }
      })
    } catch (error) {
      console.error(error)
    }
  }
}

function ensureCheckSweep() {
  const current = g().__benchCheckSweep
  if (current?.version === CHECK_SWEEP_VERSION) return
  if (current) clearInterval(current.timer)
  const timer = setInterval(() => sweepChecks(), envDelay("BENCH_CHECK_SWEEP_MS", CHECK_SWEEP_MS) || CHECK_SWEEP_MS)
  timer.unref?.()
  g().__benchCheckSweep = { version: CHECK_SWEEP_VERSION, timer }
}

// ---- The desk hears of verdicts in one go ----
// Each verdict (or failed run) waits: when none has landed for
// BENCH_CHECK_QUIET_MS (3 minutes), or BENCH_CHECK_QUIET_MAX_MS (10) after
// the first, the desk's AI is woken once with all of them. Before, each one
// woke it (a morning of 7 or 8 wakes, 2026-11-18).
const CHECK_QUIET_MS = 3 * 60_000
const CHECK_QUIET_MAX_MS = 10 * 60_000

function noteCheckSettled(taskId: string) {
  const project = currentProject()
  const all = (g().__benchCheckSettled ??= new Map())
  const now = Date.now()
  const entry = all.get(project) ?? { ids: new Set<string>(), first: now }
  entry.ids.add(taskId)
  all.set(project, entry)
  if (entry.timer) clearTimeout(entry.timer)
  const quiet = envDelay("BENCH_CHECK_QUIET_MS", CHECK_QUIET_MS)
  const most = envDelay("BENCH_CHECK_QUIET_MAX_MS", CHECK_QUIET_MAX_MS)
  entry.timer = setTimeout(() => tellChecksSettled(project), Math.max(0, Math.min(quiet, entry.first + most - now)))
  entry.timer.unref?.()
}

function tellChecksSettled(project: string) {
  const all = g().__benchCheckSettled
  const entry = all?.get(project)
  all?.delete(project)
  if (!entry) return
  try {
    inProject(project, () => {
      const info = currentProjectInfo()
      if (info.front) return
      let passed = 0
      let failed = 0
      let unverified = 0
      let other = 0
      // Could not run (the wake failed, no verdict): the desk hears of these
      // too, or a batch that all fell on a seat out of quota would sit there
      // with nobody told. Skipped ones alone wake nobody.
      let errored = 0
      for (const task of snapshot().tasks) {
        if (!entry.ids.has(task.id)) continue
        const state = task.check?.state
        if (state === "passed") passed++
        else if (state === "failed") failed++
        else if (state === "unverified") unverified++
        else if (state === "error") {
          other++
          errored++
        } else if (state === "skipped") other++
      }
      if (passed + failed + unverified + errored === 0) return
      noteChecksSettled({ projectId: info.id, project: info.name, passed, failed, unverified, other })
    })
  } catch (error) {
    console.error(error)
  }
}

// After a restart: checks that were queued or running never finish.
function abandonChecks() {
  for (const project of listProjects()) {
    try {
      inProject(project.id, () => {
        for (const task of snapshot().tasks) {
          if (task.check && (task.check.state === "queued" || task.check.state === "running")) {
            setTaskCheck(task.id, task.check.at, { state: "error", note: "复验没跑成：服务器重启，打断了" })
          }
        }
      })
    } catch {}
  }
}

function checkPrompt(task: Task) {
  const dir = currentProjectInfo().dir
  const steps = (task.steps ?? []).map((step, index) => `${index + 1}. [${step.state === "done" ? "做完" : step.state === "doing" ? "在做" : "待做"}] ${step.text}${step.note ? `\n   说明：${step.note}` : ""}`)
  return [
    `【并坐房间请你复验一条待办】${userName()} 验收之前，先由你照着验一遍。这一轮不进群聊，只有房间读你的回答，${userName()} 会在验收卡片上看到你的结论。`,
    "",
    `待办：「${task.title}」（${task.id}）`,
    `负责人：${task.ownerName ?? "没有"}`,
    dir ? `项目目录：${dir}` : "项目没设目录。",
    task.detail ? `说明：\n${task.detail}` : "",
    steps.length ? `步骤：\n${steps.join("\n")}` : "",
    task.review?.note ? `负责人请验收时写的「怎么看效果」：\n${task.review.note}` : "",
    task.check?.prev
      ? [
          "",
          `这是改过以后再查（第 ${task.check.round ?? 1} 次）。上一次${task.check.prev.name ? ` ${task.check.prev.name} ` : ""}的结论是「${task.check.prev.state === "failed" ? "没过" : "没验到"}」，原因：`,
          task.check.prev.note || "（没写原因）",
          "负责人这次说改了什么，看上面的「怎么看效果」。先逐条核对上一次的问题是不是真的改好了，再整体看一遍。",
        ].join("\n")
      : "",
    "",
    "要求：",
    "- 只读：不改工作区的代码和数据，不提交，不重启服务，不在群里说话（不用 bench_say），也不改这条待办。",
    "- 要跑起来看，就按项目目录里 MAINTENANCE.md 的做法起隔离副本，用副本自己的数据和口令，用完删掉。",
    "- 只验你真的验到的；没法验的（比如要真机、要花额度、要人眼看）写进「没验到的」。",
    "",
    "回答直接输出，格式：",
    "第一行只写一个结论：复验结论：通过 / 复验结论：没过 / 复验结论：没验到",
    "第二行必填类别：类别：跑得出 / 类别：要人看 / 类别：只能本人签",
    "- 跑得出：结果能靠跑测试、调接口、查数据或对代码客观证明的（如 bug 修复、接口和逻辑改动、清理、文档核对）。",
    "- 要人看：涉及界面排版、视觉样式、文案语气、交互手感这类需要人眼看的。",
    "- 只能本人签：动了权限、全权、沙盒、口令、凭证、密钥，或删数据、花钱、提交、推送、发版、改验收或代签规则的。",
    "接着写依据：做了什么、看到了什么。",
    "最后一段以「没验到的：」开头，列出没验到的部分；全验到了就写「没验到的：无」。",
  ]
    .filter((line, index, all) => line || all[index - 1])
    .join("\n")
}

function parseCheckKind(text: string): TaskCheck["kind"] {
  const hit = [...text.matchAll(CHECK_KIND_RE)].at(-1)?.[1]
  if (!hit) return undefined
  if (hit.startsWith("跑得出")) return "run"
  if (hit === "要人看") return "look"
  if (hit === "只能本人签") return "you"
  return undefined
}

function parseCheckGaps(text: string): string | undefined {
  const match = CHECK_GAPS_RE.exec(text)
  if (!match) return undefined
  const raw = match[1].trim()
  const normalized = raw.replace(/[。.\s]+$/g, "").trim()
  if (!normalized || normalized === "无" || normalized === "没有" || normalized.toLowerCase() === "none") {
    return undefined
  }
  return raw.slice(0, 500)
}

function verdictOf(out: string): Pick<TaskCheck, "state" | "note" | "kind" | "gaps"> {
  const found = [...out.matchAll(VERDICT)].at(-1)
  if (!found) {
    const tail = out.trim().slice(-200)
    return { state: "error", note: `复验没交结论${tail ? `，它最后说：${tail}` : ""}`, kind: undefined, gaps: undefined }
  }
  const afterVerdict = out.slice((found.index ?? 0) + found[0].length).trim()
  const kind = parseCheckKind(afterVerdict) ?? parseCheckKind(out)
  const gaps = parseCheckGaps(afterVerdict)
  const bodyNote = afterVerdict.replace(/^\s*类别\s*[:：]\s*(?:跑得出(?:结果)?|要人看|只能本人签)\s*\n?/, "").trim()
  return {
    state: VERDICT_STATE[found[1] as keyof typeof VERDICT_STATE],
    note: (bodyNote || afterVerdict).slice(0, 2000) || undefined,
    kind,
    gaps,
  }
}

function checkTask(agent: NonNullable<ReturnType<typeof agentState>>, item: { taskId: string; at: number }) {
  const task = snapshot().tasks.find((one) => one.id === item.taskId)
  // Sent back, signed off or asked again meanwhile: this check is moot.
  // Still this one but nobody asks for it now: say so, it is not left queued.
  // Or it has gone to another seat meanwhile (repickCheck), or was settled.
  if (!task || task.check?.at !== item.at || task.check.by !== agent.id || task.check.state !== "queued" || !reviewAsked(task)) {
    if (task?.check?.at === item.at && task.check.state === "queued") {
      setTaskCheck(item.taskId, item.at, { state: "skipped", note: "负责人还没请验收，等它请了再检查" })
    }
    run(agent.id)
    return
  }
  const command = commandFor(agent.agentName ?? "", agent.session ?? "", checkPrompt(task), agent.modelPick, agent.effortPick)
  if (!command) {
    setTaskCheck(item.taskId, item.at, { state: "error", note: "复验没跑成：拼不出唤起命令" })
    noteCheckSettled(item.taskId)
    run(agent.id)
    return
  }
  const queue = lane(agent.id)
  queue.running = true
  const log = startRun(agent.id, agent.name, "check", { project: currentProject(), ask: `复验「${task.title}」` })
  setTaskCheck(item.taskId, item.at, { state: "running", runId: log.id })
  const seat = busy(agent.id, `在复验「${task.title}」`)
  launch(agent, command, log, seat.live, ({ out, failure, stopped }) => {
    queue.running = false
    const verdict = stopped ? null : failure ? null : verdictOf(out)
    endRun(
      log,
      stopped || failure || verdict?.state === "error" ? "failed" : "done",
      stopped ? "被停下了" : failure ? `没成功：${failure}` : verdict?.state === "error" ? "没交结论" : undefined,
    )
    if (!stopped && !failure) log.answer = out.slice(0, 4000)
    seat.settle()
    // Its checker ran out of allowance: the check goes to another seat now.
    const limited = !stopped && (failure || verdict?.state === "error") && noteLimit(agent, log, out, failure ?? "")
    if (limited) repickCheck(item.taskId, "limit", agent.id)
    else if (stopped) setTaskCheck(item.taskId, item.at, { state: "error", note: "复验没跑成：被停下了" })
    else if (failure) {
      setTaskCheck(item.taskId, item.at, { state: "error", note: `复验没跑成：${shortExplain(agent.agentName, failure)}` })
    } else if (verdict) {
      setTaskCheck(item.taskId, item.at, verdict)
      autoAcceptChecked(item.taskId)
    }
    // The pick leaves a seat alone for a while after this (pickAutoChecker).
    if (!stopped) {
      const failed = (g().__benchCheckFailed ??= new Map())
      if (failure || verdict?.state === "error") failed.set(agent.id, Date.now())
      else failed.delete(agent.id)
    }
    // Compact every CHECK_COMPACT_EVERY checks so a checker's context doesn't bloat.
    if (!stopped) {
      const counts = (g().__benchCheckCounts ??= new Map())
      const done = (counts.get(agent.id) ?? 0) + 1
      counts.set(agent.id, done)
      if (done % CHECK_COMPACT_EVERY === 0 && CONTEXT_KINDS.includes(agent.agentName ?? "")) {
        queue.compact = true
      }
    }
    if (!limited) noteCheckSettled(item.taskId)
    run(agent.id)
  })
}

// 「谁来补摘要句」: a long reply whose first line the rules could not use as
// its gist (lib/text.ts gistOf) waits a few seconds for others, then the
// project's summary seat (Agent.gister) is woken with the batch on its own,
// like a check: nothing goes into the room. It answers one line per message;
// the room writes those back as Message.gist (by its name). A failed batch
// is let go: no retry, no note in the room, the page shows the rules' cut.
// Its session grows by a batch at a time, so every GIST_COMPACT_EVERY
// batches the room compacts it (Claude Code and Codex; others compact by
// themselves or not at all).
const GIST_LONG = 200
const GIST_BATCH = 12
const GIST_GATHER_MS = Number(process.env.BENCH_GIST_MS) || 5_000
const GIST_COMPACT_EVERY = 20
// The prompt rides in one command-line argument (see SUMMARY_PROMPT_BYTES).
const GIST_PROMPT_BYTES = 80_000
const GIST_EACH_CHARS = 2_000

function noteGistless(message: Message) {
  if (message.kind !== "chat" || message.authorId === "human" || message.authorId === "room") return
  if (message.gist || message.ask || message.recalled || message.text.length <= GIST_LONG) return
  if (!gisterSeat()) return
  const project = currentProject()
  const gather = (g().__benchGistGather ??= new Map())
  const batch = gather.get(project) ?? { ids: [] }
  gather.set(project, batch)
  batch.ids.push(message.id)
  if (batch.ids.length >= GIST_BATCH) flushGists(project)
  else batch.timer ??= setTimeout(() => flushGists(project), GIST_GATHER_MS)
}

function flushGists(project: string) {
  const batch = g().__benchGistGather?.get(project)
  if (!batch) return
  g().__benchGistGather?.delete(project)
  clearTimeout(batch.timer)
  try {
    inProject(project, () => {
      const seat = gisterSeat()
      if (!seat) return
      const agent = agentState(seat.id)
      if (!agent?.agentName || !agent.session || !adapterFor(agent.agentName) || isStandby(agent.id)) return
      const queue = lane(agent.id)
      queue.gists = [...new Set([...(queue.gists ?? []), ...batch.ids])].slice(-GIST_BATCH * 4)
      run(agent.id)
    })
  } catch (error) {
    console.error(error)
  }
}

function gistPrompt(list: Message[]) {
  const parts: string[] = []
  let bytes = 0
  const taken: Message[] = []
  for (const message of list) {
    const text = message.text.length > GIST_EACH_CHARS ? `${message.text.slice(0, GIST_EACH_CHARS)}…（后面略）` : message.text
    const part = `【${message.id}】${message.authorName} · ${stamp(message.createdAt)}\n${text}`
    if (taken.length > 0 && bytes + Buffer.byteLength(part) > GIST_PROMPT_BYTES) break
    bytes += Buffer.byteLength(part)
    parts.push(part)
    taken.push(message)
  }
  const text = [
    `【并坐房间请你给下面 ${taken.length} 条回复各写一句摘要】这一轮不进群聊，只有房间读你的回答。群里会在那条回复的位置只显示你写的这一句，点开才看全文。`,
    `每条写一句 60 字以内的结论：做完了什么、结果怎样、要 ${userName()} 做什么。只照原文写，不评价，不添原文没有的事，不要用 @。`,
    "不要调用工具，不要改文件，不要在群里说话。",
    "回答直接输出，一条一行，格式是「[消息 id] 摘要句」，例如：",
    "[m_1234abcd] 网络重试做完了，等你验收，重启 4399 后生效。",
    "",
    parts.join("\n\n"),
  ].join("\n")
  return { text, taken }
}

// One line a summary seat wrote for a message: no @ (it calls nobody, but
// shown on the page it would look like a call), no wrapping quotes, short.
function cleanGist(line: string) {
  const text = line
    .replace(/[@＠]/g, "")
    .replace(/^[\s"'“”「」]+|[\s"'“”「」]+$/g, "")
    .replace(/\s+/g, " ")
  return text.length > GIST_MAX ? `${text.slice(0, GIST_MAX - 1)}…` : text
}

function writeGists(agent: NonNullable<ReturnType<typeof agentState>>, ids: string[]) {
  const messages = snapshot().messages
  const wanted = ids
    .map((id) => messages.find((message) => message.id === id))
    .filter((message): message is Message => Boolean(message && !message.recalled && !message.gist))
  if (wanted.length === 0) {
    run(agent.id)
    return
  }
  const { text, taken } = gistPrompt(wanted)
  const command = commandFor(agent.agentName ?? "", agent.session ?? "", text, agent.modelPick, agent.effortPick)
  if (!command) {
    run(agent.id)
    return
  }
  const queue = lane(agent.id)
  queue.running = true
  const log = startRun(agent.id, agent.name, "gist", { project: currentProject(), ask: `补 ${taken.length} 条回复的摘要句` })
  const seat = busy(agent.id, `在补 ${taken.length} 条回复的摘要句`)
  launch(agent, command, log, seat.live, ({ out, failure, stopped }) => {
    queue.running = false
    let wrote = 0
    if (!stopped && !failure) {
      const mine = new Set(taken.map((message) => message.id))
      for (const line of out.split("\n")) {
        const found = /^\s*[\[【(（]?\s*(m_[0-9a-z]+)\s*[\]】)）]?\s*[:：-]?\s*(.+)$/i.exec(line)
        if (!found || !mine.has(found[1])) continue
        const gist = cleanGist(found[2])
        if (!gist) continue
        mine.delete(found[1])
        try {
          if (setMessageGist(found[1], { text: gist, by: agent.name, at: Date.now() })) wrote++
        } catch (error) {
          console.error(error)
        }
      }
      log.answer = out.slice(0, 4000)
    }
    endRun(
      log,
      stopped || failure || wrote === 0 ? "failed" : "done",
      stopped ? "被停下了" : failure ? `没成功：${failure}` : wrote === 0 ? "没交出摘要句" : `补了 ${wrote}/${taken.length} 条`,
    )
    seat.settle()
    // Every so many batches, compact its session so it doesn't grow forever.
    const batches = (g().__benchGistBatches ??= new Map())
    const done = (batches.get(agent.id) ?? 0) + 1
    batches.set(agent.id, done)
    if (done % GIST_COMPACT_EVERY === 0 && CONTEXT_KINDS.includes(agent.agentName ?? "")) queue.compact = true
    run(agent.id)
  })
}

// The user asked to compact a seat's context: one turn of /compact on its
// session (Claude Code runs it headless; scripts/codex-app.mjs turns it into
// thread/compact/start). Nothing goes into its conversation besides the
// summary the client writes itself.
function tokensText(context: SeatContext | null) {
  if (!context || context.tokens === null) return null
  return context.tokens >= 10_000 ? `${(context.tokens / 10_000).toFixed(1)} 万` : `${context.tokens}`
}

function compactSession(agent: NonNullable<ReturnType<typeof agentState>>) {
  const command = commandFor(agent.agentName ?? "", agent.session ?? "", "/compact", agent.modelPick, agent.effortPick)
  if (!command) return
  const queue = lane(agent.id)
  queue.running = true
  const before = seatContext(agent.agentName, agent.session, agent)
  const log = startRun(agent.id, agent.name, "compact", { project: currentProject() })
  const seat = busy(agent.id, "在压缩上下文")
  launch(agent, command, log, seat.live, ({ out, failure: said, stopped }) => {
    queue.running = false
    const after = stopped ? null : seatContext(agent.agentName, agent.session, agent)
    // Only a new compaction in its record counts: a short conversation
    // gets "Not enough messages to compact." and stays as it was. And one
    // that is there has worked, whatever the process said on the way out.
    const done = (after?.compacted?.at ?? 0) > (before?.compacted?.at ?? 0)
    const failure = done ? undefined : said
    endRun(log, failure || stopped ? "failed" : "done", stopped ? "被停下了" : failure ? `没成功：${failure}` : undefined)
    seat.settle()
    if (failure && !stopped) reportFailure(agent, log, failure, out, `${agent.name} 压缩`)
    else if (!stopped) {
      if (!done && out.trim()) {
        putStep(log, { id: "compact-note", at: Date.now(), kind: "note", state: "done", title: "未压缩原因", output: out.trim() })
      }
      const was = tokensText(before)
      const now = tokensText(after)
      postSystem(
        shortSys(
          !done
            ? `${agent.name} 本次未压缩`
            : now
              ? `${agent.name} 已压缩${was ? `：${was}→${now}` : `（现 ${now}）`}`
              : `${agent.name} 已压缩上下文`,
        ),
        !done && out.trim() ? log.id : undefined,
      )
    }
    run(agent.id)
  })
}

export function requestCompact(agentId: string) {
  const agent = wakeable(agentId)
  if (!CONTEXT_KINDS.includes(agent.agentName ?? "")) {
    throw new ApiError(400, `${agent.name} 这种客户端房间还不会替它压缩，在它自己的窗口里用 /compact`)
  }
  const queue = lane(agent.id)
  if (queue.running || queue.compact) throw new ApiError(409, `${agent.name} 正在忙，等这一轮做完再压缩`)
  queue.compact = true
  syncLane(agent.id)
  run(agent.id)
  return { started: queue.running }
}

// /goal from the room's input (components/room/composer.tsx): the client's
// own goal command, run on the seat's session as it is. Claude Code takes
// "/goal <condition>" headless and keeps working until the condition holds;
// scripts/codex-app.mjs turns it into thread/goal/set, and Codex then works
// on it by itself. The goal stays on the session: later wakes keep at it
// until it is met or cleared ("/goal clear"). What it says at the end goes
// into the room as its reply, and messages that call it meanwhile go into
// the run the way they do in a reply run (takeQueued).
const GOAL_KINDS = ["claude", "codex"]
const CLEAR_GOAL = /^(clear|清除|清掉)$/i

function goalLine(text: string) {
  return CLEAR_GOAL.test(text) ? "/goal clear" : `/goal ${text}`
}

function setGoal(agent: NonNullable<ReturnType<typeof agentState>>, adapter: Adapter, text: string) {
  const command = commandFor(agent.agentName ?? "", agent.session ?? "", goalLine(text), agent.modelPick, agent.effortPick)
  if (!command) return
  const clearing = CLEAR_GOAL.test(text)
  const queue = lane(agent.id)
  queue.running = true
  const startedLink = { agentName: agent.agentName, session: agent.session }
  const log = startRun(agent.id, agent.name, "goal", { project: currentProject(), ask: text })
  queue.key = randomBytes(12).toString("hex")
  queue.project = currentProject()
  queue.log = log
  queue.midHop = undefined
  const seat = busy(agent.id, clearing ? "在清掉目标" : "在按目标干活")
  launch(agent, command, log, seat.live, ({ out, failure, stopped }) => {
    queue.running = false
    queue.key = undefined
    queue.log = undefined
    queue.midHop = undefined
    const still = agentState(agent.id)
    const sameBinding = still?.agentName === startedLink.agentName && still?.session === startedLink.session
    if (failure && !stopped) reportFailure(agent, log, failure, out, clearing ? `${agent.name} 清目标` : `${agent.name} 设目标`)
    else if (!stopped && clearing) postSystem(shortSys(`${agent.name} 已清除目标`))
    else if (!stopped && adapter.reply === "stdout" && still && sameBinding && out) {
      try {
        sayAs({ type: "agent", id: still.id, name: still.name }, { text: out.slice(0, 4000) })
      } catch (error) {
        console.error(error)
      }
    }
    if (!failure) markWoken(agent.id, startedLink)
    endRun(log, failure || stopped ? "failed" : "done", stopped ? "被你停下了" : failure ? `没成功：${failure}` : undefined)
    seat.settle()
    run(agent.id)
  })
}

export function requestGoal(agentId: string, input: unknown) {
  const agent = wakeable(agentId)
  const text = typeof input === "string" ? input.trim() : ""
  if (!text) throw new ApiError(400, "/goal 后面写上要达成什么，或者 clear 清掉目标")
  if (text.length > 4000) throw new ApiError(400, "目标太长了，4000 字以内")
  if (!GOAL_KINDS.includes(agent.agentName ?? "")) {
    throw new ApiError(400, `${agent.name} 这种客户端没有 /goal（现在只有 Claude Code 和 Codex 有）`)
  }
  const queue = lane(agent.id)
  if (queue.goal !== undefined) throw new ApiError(409, `上一条 /goal 还没交给 ${agent.name}，稍等`)
  clearSeatUserStopped(agent.id)
  queue.goal = text
  syncLane(agent.id)
  const clearing = CLEAR_GOAL.test(text)
  postSystem(
    shortSys(
      clearing
        ? `正在清除 ${agent.name} 的目标`
        : `已给 ${agent.name} 设目标（/stop 可停）`,
    ),
  )
  const waiting = queue.running || terminalOpen(agent.id) || Boolean(queue.paused)
  run(agent.id)
  return { queued: waiting && !terminalOpen(agent.id) }
}

// Something the user says to one seat alone. It doesn't go into the room and
// the answer doesn't either: both are kept on the run, and the 「单独说」
// dialog lists them.
function whisperPrompt(text: string, interrupted: boolean) {
  return [
    `【并坐房间里的 ${userName()} 单独对你说】`,
    "这句话没有发到群里，只有你看得到；你的回答也只给他看，不会贴进群聊，不要用 bench_say 发到群里。",
    interrupted ? "你刚才手上的事被这句话打断了。先回应这句；回完之后房间会把你没回完的消息重新交给你，接着做就行。" : "",
    "",
    text,
    "",
    "（回答直接输出就行。）",
  ]
    .filter((line, index) => line || index > 1)
    .join("\n")
}

function answerWhisper(agent: NonNullable<ReturnType<typeof agentState>>, text: string) {
  const queue = lane(agent.id)
  const interrupted = Boolean(queue.carry) || queue.summary === true
  const command = commandFor(
    agent.agentName ?? "",
    agent.session ?? "",
    introduce(agent) + whisperPrompt(text, interrupted),
    agent.modelPick,
    agent.effortPick,
  )
  if (!command) return
  queue.running = true
  const startedLink = { agentName: agent.agentName, session: agent.session }
  const log = startRun(agent.id, agent.name, "private", { project: currentProject(), ask: text })
  const seat = busy(agent.id, "在回你单独说的话")
  launch(agent, command, log, seat.live, ({ out, failure, stopped }) => {
    queue.running = false
    if (!stopped && !failure) {
      log.answer = out.slice(0, 4000)
      markWoken(agent.id, startedLink)
    }
    // Nothing is said in the room about a failed private turn, except that the
    // account ran out: that one comes with its card.
    if (failure && !stopped) noteLimit(agent, log, out, failure)
    endRun(log, failure || stopped ? "failed" : "done", stopped ? "被停下了" : failure ? `没成功：${failure}` : undefined)
    seat.settle()
    run(agent.id)
  })
}

function wakeable(agentId: string) {
  const agent = agentState(agentId)
  if (!agent) throw new ApiError(404, "这个席位不在了")
  if (isStandby(agent.id)) throw new ApiError(409, `${agent.name} 正挂在 bench_wait 里自己守着房间，直接在群里 @ 它`)
  if (!agent.agentName || !agent.session || !adapterFor(agent.agentName)) {
    throw new ApiError(400, `${agent.name} 叫不醒，没法单独说`)
  }
  return agent
}

// Say something to one seat alone. If it is busy, what it is doing is stopped
// and taken up again after it answers.
export function whisper(agentId: string, text: string) {
  const agent = wakeable(agentId)
  const clean = text.trim()
  if (!clean) throw new ApiError(400, "说点什么")
  if (clean.length > 4000) throw new ApiError(400, "太长了，4000 字以内")
  const queue = lane(agent.id)
  if (queue.whisper !== undefined) throw new ApiError(409, `上一句还没交给 ${agent.name}，稍等`)
  clearSeatUserStopped(agent.id)
  queue.whisper = clean
  syncLane(agent.id)
  const interrupted = queue.running
  if (interrupted) queue.stop?.()
  else run(agent.id)
  return { interrupted }
}

// Stop what a seat is running now and drop what was queued after it.
export function stopAgent(agentId: string) {
  const agent = agentState(agentId)
  if (!agent) throw new ApiError(404, "这个席位不在了")
  const queue = lane(agentId)
  if (!queue.stop && queue.retryAt) {
    // Waiting to try a wake again after the network dropped: no more tries.
    clearRetry(queue)
    queue.retries = undefined
    const dropped = queue.pending.length
    note(queue.carryIds, agentId, "stopped", { note: "等重试时被你停下了" })
    note(queue.pending.map((item) => item.id), agentId, "dropped", { note: "停止时一起取消了" })
    queue.carryIds = undefined
    queue.carry = undefined
    queue.pending = []
    queue.trigger = undefined
    queue.hops = 0
    markSeatUserStopped(agentId)
    syncLane(agentId)
    return { dropped, retryCancelled: true }
  }
  if (!queue.stop) {
    // Marked running with no process to stop: a start that failed halfway
    // (spawn E2BIG once left a summary job behind). Clear the marks so the
    // seat is free again, instead of answering "not running" to a seat the
    // page shows as working.
    const stale = queue.running || summaryJob()?.agentId === agentId || activeRun(agentId)
    if (!stale) throw new ApiError(409, `${agent.name} 现在没在跑`)
    const dropped = queue.pending.length
    note([...queue.pending.map((item) => item.id), ...(queue.carryIds ?? [])], agentId, "dropped", { note: "停止时一起取消了" })
    note(queue.calls, agentId, "cut", { note: "进程已经不在了" })
    queue.calls = undefined
    queue.carryIds = undefined
    queue.pending = []
    queue.carry = undefined
    dropChecks(queue, "复验人被停下了")
    queue.gists = undefined
    queue.summary = false
    queue.compact = false
    queue.goal = undefined
    queue.running = false
    endSummaryJob(agentId)
    const orphan = activeRun(agentId)
    if (orphan) endRun(orphan, "failed", "进程已经不在了，状态被清掉")
    try {
      pulseAgent(agentId, "idle", "")
    } catch {}
    markSeatUserStopped(agentId)
    syncLane(agentId)
    return { dropped, cleared: true }
  }
  const dropped = queue.pending.length
  note([...queue.pending.map((item) => item.id), ...(queue.carryIds ?? [])], agentId, "dropped", { note: "停止时一起取消了" })
  queue.carryIds = undefined
  queue.pending = []
  queue.carry = undefined
  dropChecks(queue, "复验人被停下了")
  queue.gists = undefined
  queue.summary = false
  queue.compact = false
  queue.goal = undefined
  clearRetry(queue)
  queue.retries = undefined
  markSeatUserStopped(agentId)
  syncLane(agentId)
  queue.stop()
  return { dropped }
}

// Pause or resume automatic wakes on a seat's lane. Queued messages stay safe
// in SQLite and can be inspected or dropped individually while paused.
export function pauseQueue(agentId: string, paused: boolean) {
  const agent = agentState(agentId)
  if (!agent) throw new ApiError(404, "这个席位不在了")
  const queue = lane(agentId)
  queue.paused = paused || undefined
  queue.restartPaused = undefined
  syncLane(agentId)
  if (!paused) {
    run(agentId)
  }
  return { paused: Boolean(queue.paused), queuedCount: queue.pending.length }
}

// Drop one queued message (or all when messageId is omitted / "*") from a seat's lane.
export function dropQueuedMessage(agentId: string, messageId?: string) {
  const agent = agentState(agentId)
  if (!agent) throw new ApiError(404, "这个席位不在了")
  const queue = lane(agentId)
  const before = queue.pending.length
  if (!messageId || messageId === "*") {
    const ids = queue.pending.map((item) => item.id)
    if (ids.length > 0) queue.dropped = [...new Set([...(queue.dropped ?? []), ...ids])].slice(-200)
    note([...ids, ...(queue.carryIds ?? [])], agentId, "dropped")
    queue.carryIds = undefined
    queue.pending = []
    queue.carry = undefined
    queue.trigger = undefined
    queue.hops = 0
    clearRetry(queue)
    queue.retries = undefined
  } else {
    const had = queue.pending.some((item) => item.id === messageId)
    queue.pending = queue.pending.filter((item) => item.id !== messageId)
    if (had) {
      queue.dropped = [...new Set([...(queue.dropped ?? []), messageId])].slice(-200)
      note([messageId], agentId, "dropped")
    }
    // One of the messages a failed wake will be tried again with: out of it;
    // with none left, no more tries.
    if (queue.carryIds?.includes(messageId)) {
      queue.carryIds = queue.carryIds.filter((id) => id !== messageId)
      queue.dropped = [...new Set([...(queue.dropped ?? []), messageId])].slice(-200)
      note([messageId], agentId, "dropped")
      if (queue.carryIds.length === 0 && queue.retryAt) {
        queue.carryIds = undefined
        queue.carry = undefined
        clearRetry(queue)
        queue.retries = undefined
      }
    }
    if (queue.trigger === messageId) queue.trigger = queue.pending.at(-1)?.id
  }
  syncLane(agentId)
  return { dropped: before - queue.pending.length, queuedCount: queue.pending.length }
}

// Messages that call a seat while it is in a reply run wait in its lane for
// the next run. A run that can take them now asks here: Claude Code's hook
// after every tool call (scripts/bench-hook.mjs, by BENCH_RUN_KEY), or any
// seat's bench bridge after one of its tools (by seat). They are handed over
// with what else came in since, marked on the page, and wake nobody later.
// The seat whose current run holds this key (BENCH_RUN_KEY). A woken Codex
// turn (scripts/codex-app.mjs) has no seat token, only this, and asks the
// room's permission cards with it (app/api/v1/permit).
export function seatOfRunKey(key: string) {
  for (const [id, item] of lanesMap()) if (item.key === key && item.running) return id
  return null
}

export function takeQueued(by: { key?: string; agentId?: string }) {
  let agentId = by.agentId
  if (by.key) {
    for (const [id, item] of lanesMap()) if (item.key === by.key) agentId = id
    if (!agentId) throw new ApiError(404, "这次唤起已经结束了")
  }
  if (!agentId) return { text: "", count: 0 }
  const queue = lane(agentId)
  if (queue.paused || !queue.running || !queue.key || !queue.project || queue.pending.length === 0) {
    return { text: "", count: 0 }
  }
  const items = queue.pending
  const log = queue.log
  const droppedSet = queue.dropped ? new Set(queue.dropped) : undefined
  const text = inProject(queue.project, () => {
    const seen = catchUp(agentId, CATCH_UP_CHARS, droppedSet)
    const ids = items.map((item: { id: string }) => item.id)
    markReached(ids, agentId)
    note(ids, agentId, "picked", { runId: log?.id, note: "干活中途送到" })
    queue.calls = [...(queue.calls ?? []), ...ids]
    return seen.text || items.map((item: { line: string }) => item.line).join("\n\n")
  })
  queue.dropped = undefined
  queue.pending = []
  queue.trigger = undefined
  queue.midHop = Math.max(queue.midHop ?? 0, queue.hops)
  queue.hops = 0
  syncLane(agentId)
  if (log) {
    putStep(log, {
      id: `mid-${Date.now()}`,
      at: Date.now(),
      kind: "note",
      title: `干活中途收到 ${items.length} 条叫它的新消息，已经送进这一轮`,
      output: text,
      state: "done",
    })
  }
  return {
    count: items.length,
    text: `【并坐转来的新消息：你这轮还没做完，又有人找你】\n${text}\n\n（★ 是在叫你的。手上的事别丢，先判断它要不要你马上改方向：要停就停、要改就改，不急的做完再说。最后的回答里一并回应这些消息；回答还是挂在最早叫你的那条下面，要单独回某条就用 bench_say 的 replyTo 填它的 id。）`,
  }
}

// The user picked this seat to write the room summary.
export function requestSummary(agentId: string) {
  const agent = agentState(agentId)
  if (!agent) throw new ApiError(404, "这个席位不在了")
  if (!agent.agentName || !agent.session || !adapterFor(agent.agentName)) {
    throw new ApiError(400, `${agent.name} 叫不醒，没法写摘要`)
  }
  const current = summaryJob()
  if (current) {
    const writer = agentState(current.agentId)
    throw new ApiError(409, `${writer?.name ?? "有人"}正在写摘要`)
  }
  lane(agentId).summary = true
  syncLane(agentId)
  run(agentId)
  return snapshot()
}

// How far down a relay each seat was last called: the hop of the latest
// message that called it. Whatever a seat says next, by its stdout answer,
// bench_say in the middle of a run, a handoff, or from a session the room
// didn't wake (a wait loop, its own window), is one hop further. So every way
// two agents can keep @-ing each other is counted, and the user speaking puts
// it back to the start. Nothing is capped on it any more (see wake).
function calledAt() {
  return (g().__benchCalledHop ??= new Map())
}

function hopOf(message: Message) {
  const known = hops().get(message.id)
  if (known !== undefined) return known
  if (message.authorId === "human" || message.authorId === "room") return 0
  const called = calledAt().get(message.authorId)
  return called === undefined ? 0 : called + 1
}

function wake(message: Message) {
  if (message.kind === "system" && message.mentions.length === 0) return
  // Said outside any wake (its wait loop, its terminal, its own window): what
  // it took there has its answer.
  if (message.authorId !== "human" && message.authorId !== "room" && !message.runId) {
    try {
      settleCalls(message.authorId)
    } catch (error) {
      console.error(error)
    }
  }
  const hop = hopOf(message)
  const fromHuman = message.authorId === "human"
  // 【本轮结束】 needs nothing here: that message mentions nobody, so it wakes
  // nobody, and it stops only its own line. It used to close every agent-to-
  // agent line in the project until the user spoke, which silently dropped
  // mentions that had nothing to do with it.
  for (const agent of summonCandidates(message)) {
    // Between agents only an explicit @ or a handoff wakes someone.
    if (!fromHuman && !message.mentions.includes(agent.id) && message.handoff?.toId !== agent.id) {
      continue
    }
    if (fromHuman) clearSeatUserStopped(agent.id)
    // No cap on agents relaying to each other (the user's call, 2026-11-11):
    // a line stops when a seat ends it (【本轮结束】 / end: true, which
    // mentions nobody) or the user steps in. The hop is still kept per seat.
    calledAt().set(agent.id, hop)
    // A seat on standby picks the message up from its own wait loop; waking it
    // with a command would start a second run on the same session.
    if (isStandby(agent.id)) {
      // Blocked in the wait now: it has the message already. Between two
      // waits, say so, or the room looks like it ignored the mention; and if
      // the loop turns out to be gone without taking it, wake it after all.
      if (!isWaiting(agent.id)) {
        if (cooled(`${agent.id}:standby`, NOTE_GAP_MS)) {
          postSystem(shortSys(`${agent.name} 正忙，消息排队等它取`))
        }
        note([message.id], agent.id, "held")
        watchStandby(agent.id, message, hop)
      } else {
        note([message.id], agent.id, "picked", { note: "它守着房间，当场取走" })
      }
      continue
    }
    enqueue(agent, message, hop)
  }
}

// Queue a message for a seat and wake it, or say why it can't be woken.
function enqueue(agent: { id: string; name: string; agentName?: string; session?: string }, message: Message, hop: number) {
  if (!agent.agentName || !agent.session) {
    if (cooled(`${agent.id}:session`, NOTE_GAP_MS)) {
      postSystem(shortSys(`${agent.name} 未报会话 id，叫不醒`))
    }
    note([message.id], agent.id, "failed", { note: "还没报会话，叫不醒" })
    return
  }
  if (!adapterFor(agent.agentName)) {
    if (cooled(`${agent.id}:config`, NOTE_GAP_MS)) {
      postSystem(shortSys(`${agent.name} 缺少 ${agent.agentName} 唤起命令`))
    }
    note([message.id], agent.id, "failed", { note: `没有 ${agent.agentName} 的唤起命令` })
    return
  }
  const queue = lane(agent.id)
  queue.projectId = currentProject()
  queue.pending.push({
    id: message.id,
    line: `${message.authorName}：${withAttachments(message.wakeText ?? message.text, message.attachments)}`,
  })
  queue.hops = Math.max(queue.hops, hop)
  queue.trigger = message.id
  syncLane(agent.id)
  run(agent.id)
  // Still in the lane: behind the run it is in, or the lane is paused.
  if (queue.pending.some((item) => item.id === message.id)) note([message.id], agent.id, "queued")
}

// A mention held for a seat between two of its waits. Once the seat has read
// past it, done; while it is still on standby, look again later; once it no
// longer is (its session went away without another wait), wake it the usual
// way so the mention isn't lost.
const STANDBY_CHECK_MS = 30_000
function watchStandby(agentId: string, message: Message, hop: number) {
  const check = bindProject(() => {
    const agent = agentState(agentId)
    if (agent && (agent.seenSeq ?? 0) >= message.seq) note([message.id], agentId, "picked", { from: ["held"], note: "它守着房间，自己取走了" })
    if (!agent || (agent.seenSeq ?? 0) >= message.seq) return
    if (isStandby(agentId)) {
      setTimeout(check, STANDBY_CHECK_MS)
      return
    }
    enqueue(agent, message, hop)
  })
  setTimeout(check, STANDBY_CHECK_MS)
}

// After a restart: say in each project which wakes were cut off, once, so
// the user can wake them again (the button under that note).
function announceInterrupted() {
  const byProject = new Map<string, Run[]>()
  const cut = takeUnannounced()
  scheduleRestartResume(cut)
  for (const item of cut) {
    if (!item.project) continue
    byProject.set(item.project, [...(byProject.get(item.project) ?? []), item])
  }
  for (const [project, list] of byProject) {
    try {
      inProject(project, () => {
        for (const item of list) {
          try {
            pulseAgent(item.agentId, "idle", INTERRUPTED_DOING)
          } catch {}
        }
        const shown = list.length === 1 ? list[0].agentName : `${list[0].agentName} 等 ${list.length} 个席位`
        postInterrupted(
          shortSys(`重启打断了 ${shown}，${list.some((item) => !userPaused(item.agentId)) ? "稍后自动接上" : "点下方重新叫醒"}`),
          list.map((item) => ({
            runId: item.id,
            agentId: item.agentId,
            agentName: item.agentName,
            purpose: item.purpose,
            replyTo: item.replyTo,
          })),
        )
      })
    } catch {
      // The project is gone.
    }
  }
}

// After a restart the room takes up what it cut short by itself (AverageJoe
// 2026-11-17, t_67bd9812): wakes that were running are woken again, lanes it
// paused are let go. Not all at once: a minute after the start, then one
// seat every half minute. Only what this restart cut: a pause the user made,
// or one from an earlier restart, stays; so does a seat the user stopped or
// whose client is out of quota (the note's button is still there).
const RESTART_RESUME_FIRST_MS = 60_000
const RESTART_RESUME_GAP_MS = 30_000

function bootPaused() {
  return (g().__benchBootPaused ??= new Set<string>())
}

function envDelay(name: string, fallback: number) {
  const raw = Number(process.env[name])
  return process.env[name] !== undefined && process.env[name] !== "" && Number.isFinite(raw) && raw >= 0 ? raw : fallback
}

function scheduleRestartResume(cut: Run[]) {
  const seats: string[] = []
  const runsOf = new Map<string, string[]>()
  for (const item of cut) {
    if (!item.project) continue
    if (!runsOf.has(item.agentId)) seats.push(item.agentId)
    runsOf.set(item.agentId, [...(runsOf.get(item.agentId) ?? []), item.id])
  }
  for (const agentId of bootPaused()) if (!runsOf.has(agentId)) seats.push(agentId)
  bootPaused().clear()
  const first = envDelay("BENCH_RESTART_RESUME_MS", RESTART_RESUME_FIRST_MS)
  const gap = envDelay("BENCH_RESTART_RESUME_GAP_MS", RESTART_RESUME_GAP_MS)
  seats.forEach((agentId, index) => {
    const timer = setTimeout(() => {
      try {
        resumeSeatAfterRestart(agentId, runsOf.get(agentId) ?? [])
      } catch (error) {
        console.error(error)
      }
    }, first + index * gap)
    timer.unref?.()
  })
}

// Paused, and not by this restart: the user's (or an earlier restart's).
function userPaused(agentId: string) {
  const queue = lanesMap().get(agentId)
  return Boolean(queue?.paused && !queue.restartPaused)
}

function resumeSeatAfterRestart(agentId: string, runIds: string[]) {
  // Run from a timer: no project yet, the seat's own is used.
  inSeat(agentId, () => resumeSeatHere(agentId, runIds))
}

function resumeSeatHere(agentId: string, runIds: string[]) {
  const agent = agentState(agentId)
  if (!agent || isSeatStoppedByUser(agentId)) return
  if (agent.agentName && isKindQuotaBlocked(agent.agentName)) return
  // Waking the cut-off run would lift the user's pause too (rewake does), so
  // it all waits for the user's 「重新叫醒」.
  if (userPaused(agentId)) return
  for (const runId of runIds) {
    const item = getRun(runId)
    if (!item || item.resumedAt) continue
    try {
      rewake(runId, true)
    } catch (error) {
      console.log(`重启后接上 ${agent.name} 没成：${error instanceof Error ? error.message : error}`)
    }
  }
  const queue = lanesMap().get(agentId)
  // Still the restart's pause: the user hasn't paused or resumed it since.
  if (!queue?.paused || !queue.restartPaused) return
  queue.paused = undefined
  queue.restartPaused = undefined
  syncLane(agentId)
  run(agentId)
}

// After a restart: every call that was on its way is checked against what the
// room still holds. Queued ones are in the lanes (they are saved); a running
// wake is gone with the old process, and so is a wait loop's watch. What has
// nothing behind it any more is marked cut, not left looking under way.
function settleOpenCalls() {
  for (const project of listProjects()) {
    try {
      inProject(project.id, () => {
        for (const { messageId, seq, call } of openCalls()) {
          const queue = lanesMap().get(call.id)
          if (call.state === "queued") {
            if (queue?.pending.some((item) => item.id === messageId) || queue?.carryIds?.includes(messageId)) continue
          } else if (call.state === "retrying") {
            // The timer went with the old process; the messages are still in
            // the lane, which a restart pauses, so they go when it resumes.
            if (queue?.carry !== undefined && queue.carryIds?.includes(messageId)) {
              note([messageId], call.id, "queued", { note: "等重试时房间重启了，恢复自动唤起后接着叫" })
              continue
            }
          } else if (call.state === "held") {
            if (isStandby(call.id)) continue
            if ((agentState(call.id)?.seenSeq ?? 0) >= seq) {
              note([messageId], call.id, "picked", { note: "它守着房间，自己取走了" })
              continue
            }
          } else if (call.runId) {
            if (activeRun(call.id)?.id === call.runId) continue
          } else {
            // Taken in a wait loop or a terminal: no wake of the room's to lose.
            continue
          }
          note([messageId], call.id, "cut", { note: "房间重启时断了" })
        }
      })
    } catch {
      // The project is gone.
    }
  }
}

// Wake a seat again with what a cut-off run was doing: one the room's restart
// stopped, or one that ended on the usage limit.
export function rewake(runId: string, byAutoTimer = false) {
  const item = getRun(runId)
  if (!item || !(item.interrupted || item.limited)) throw new ApiError(404, "这次唤起不是被重启或额度打断的，或者记录已经不在了")
  if (item.resumedAt) throw new ApiError(409, `${item.agentName} 已经重新叫醒过了`)
  if (!item.project) throw new ApiError(400, "这次唤起没记下项目，叫不回去")
  return inProject(item.project, () => {
    const agent = wakeable(item.agentId)
    if (!byAutoTimer) clearSeatUserStopped(agent.id)
    const queue = lane(agent.id)
    takeBack(item, agent, queue)
    syncLane(agent.id)
    run(agent.id)
    return { agent: agent.name, started: queue.running }
  })
}

// Put a cut-off run's work back on its seat's queue (not started here: the
// caller runs the lane once, after every run it takes back).
function takeBack(item: Run, agent: { id: string; name: string }, queue: Lane) {
  // A check goes to another seat when its checker hits the limit (requestCheck).
  if (item.purpose === "check" || item.purpose === "gist") throw new ApiError(400, "这是一次检查，叫不回去；检查房间会自己换人查")
  {
    if (item.purpose === "private") {
      if (!item.ask) throw new ApiError(400, "没记下当时单独说了什么")
      if (queue.whisper !== undefined) throw new ApiError(409, `上一句还没交给 ${agent.name}，稍等`)
      queue.whisper = item.ask
    } else if (item.purpose === "summary") {
      if (summaryJob()) throw new ApiError(409, "有人正在写摘要")
      queue.summary = true
    } else if (item.purpose === "compact") {
      queue.compact = true
    } else if (item.purpose === "goal") {
      if (!item.ask) throw new ApiError(400, "没记下当时的目标")
      queue.goal = item.ask
    } else {
      if (!item.body) throw new ApiError(400, "没记下当时在回哪些消息")
      queue.carry = queue.carry ? `${item.body}\n\n${queue.carry}` : item.body
      queue.trigger ??= item.replyTo
      const back = callsOfRun(item.id)
      queue.carryIds = [...new Set([...(queue.carryIds ?? []), ...back])]
      note(back, agent.id, "queued", { note: "重新叫醒" })
    }
    markResumed(item)
    markInterruptedResumed(item.id, item.resumedAt ?? Date.now())
    markLimited(item.id, { state: "resumed", at: item.resumedAt ?? Date.now(), note: undefined })
    if (item.interrupted) {
      queue.paused = undefined
      queue.restartPaused = undefined
    }
  }
}

// Carry over a usage-limited run onto the seat's newly rebound AI backend and
// wake it right away so the work continues without waiting for quota reset.
export function resumeLimitedAfterRebind(runId: string, reboundToLabel: string) {
  const item = getRun(runId)
  if (!item?.limited || item.resumedAt || !item.project) return { started: false }
  return inProject(item.project, () => {
    const agent = agentState(item.agentId)
    if (!agent) return { started: false }
    const queue = lane(agent.id)
    queue.projectId = item.project
    queue.paused = undefined
    queue.restartPaused = undefined
    if (item.purpose === "private" && item.ask) {
      queue.whisper = item.ask
    } else if (item.purpose === "summary") {
      if (!summaryJob()) queue.summary = true
    } else if (item.purpose === "goal" && item.ask) {
      if (GOAL_KINDS.includes(agent.agentName ?? "")) queue.goal = item.ask
      else queue.carry = queue.carry ? `【原持续目标】${item.ask}\n\n${queue.carry}` : `【原持续目标】${item.ask}`
    } else if (item.body) {
      queue.carry = queue.carry ? `${item.body}\n\n${queue.carry}` : item.body
      queue.trigger ??= item.replyTo
      const back = callsOfRun(item.id)
      queue.carryIds = [...new Set([...(queue.carryIds ?? []), ...back])]
      note(back, agent.id, "queued", { note: "重新叫醒" })
    }
    setLimited(item, { resetsAt: item.limited?.resetsAt })
    markResumed(item)
    markLimited(item.id, {
      state: "rebound",
      at: item.resumedAt ?? Date.now(),
      reboundTo: reboundToLabel,
      note: undefined,
    })
    syncLane(agent.id)
    run(agent.id)
    return { started: queue.running }
  })
}

// ---- After a usage limit: wake the seat again when it resets ----
// A little after the time the client named, so the window really has reopened.
const RESUME_MARGIN_MS = 45_000
// A reset the room finds long past after a restart is not acted on: the user
// has probably moved on.
const RESUME_STALE_MS = 6 * 3600_000

function resumeTimers() {
  return (g().__benchResumeTimers ??= new Map<string, NodeJS.Timeout>())
}

// One timer per seat and time (t_16ecccd4): a seat cut off on several wakes
// before the reset (a queue of checks, a reply, the desk's batch) used to get
// a timer each, and as many lines in the chat when they fired; 2026-11-17
// evening, 23 lines「到点自动叫醒没成功」at one minute. Now the timer wakes
// the seat once with all of them, and says so in one line.
function resumeKey(agentId: string, at: number) {
  return `${agentId}@${at}`
}

function armResume(runId: string, at: number) {
  const item = getRun(runId)
  if (!item) return
  const key = resumeKey(item.agentId, at)
  if (resumeTimers().has(key)) return
  const wait = Math.max(0, at - Date.now())
  // setTimeout can't count past ~24 days; a reset is hours away.
  const timer = setTimeout(() => fireResume(item.agentId, at), Math.min(wait, 2 ** 31 - 1))
  timer.unref?.()
  resumeTimers().set(key, timer)
}

function fireResume(agentId: string, at: number) {
  resumeTimers().delete(resumeKey(agentId, at))
  // Read off the records, not memory: what a restart re-armed is the same.
  const due = pendingResumes().filter((item) => item.agentId === agentId && item.limited?.resumeAt === at && !item.resumedAt && item.project)
  if (due.length === 0) return
  autoFired().set(agentId, Date.now())
  const project = due[0].project!
  const name = due[0].agentName
  const failed = (item: Run, why: string) => {
    setLimited(item, { ...item.limited, resumeAt: undefined })
    try {
      inProject(item.project!, () => markLimited(item.id, { state: "failed", at: Date.now(), note: why }))
    } catch {}
  }
  let taken = 0
  let why = ""
  try {
    inProject(project, () => {
      let agent: ReturnType<typeof wakeable>
      try {
        agent = wakeable(agentId)
      } catch (error) {
        why = error instanceof Error ? error.message : String(error)
        for (const item of due) failed(item, why)
        return
      }
      const queue = lane(agent.id)
      for (const item of due) {
        try {
          if (item.project !== project) throw new ApiError(400, "不在同一个项目")
          if (!rewakeable(item)) throw new ApiError(400, item.purpose === "check" ? "检查叫不回去，房间已经换人查" : "没记下当时在做什么")
          takeBack(item, agent, queue)
          taken++
        } catch (error) {
          why ||= error instanceof Error ? error.message : String(error)
          failed(item, error instanceof Error ? error.message : String(error))
        }
      }
      if (taken === 0) return
      syncLane(agent.id)
      run(agent.id)
    })
  } catch (error) {
    why ||= error instanceof Error ? error.message : String(error)
  }
  try {
    inProject(project, () =>
      postSystem(
        taken > 0
          ? `${name} 的额度恢复了，已经接着做`
          : `${name} 的额度恢复了，但没接上：${why}。要它接着做就 @${name}，或在额度卡上点「现在重试」`,
        taken > 0 ? undefined : due[0]?.id,
      ),
    )
  } catch {}
}

// What the user chose on the card: "schedule" (wake it after the reset), "now"
// (wake it now), "cancel" (take the schedule back) or "dismiss".
export function limitChoice(runId: string, action: string) {
  const item = getRun(runId)
  if (!item?.limited) throw new ApiError(404, "这次唤起没撞额度，或者记录已经不在了")
  if (item.resumedAt) throw new ApiError(409, `${item.agentName} 已经叫醒过了`)
  if (!item.project) throw new ApiError(400, "这次唤起没记下项目，叫不回去")
  return inProject(item.project, () => {
    if (action === "now") return rewake(runId)
    if (action === "schedule") {
      const resets = item.limited?.resetsAt
      if (!resets) throw new ApiError(400, "没读出几点重置，不能定时；可以点「现在重试」")
      // A check, or a wake with nothing kept to send again: the timer could
      // only fail (2026-11-17: 23 of them at 22:40, 8 more at 07:18).
      if (!rewakeable(item)) {
        throw new ApiError(400, item.purpose === "check" ? "这是一次检查，到点也叫不回去；检查房间会自己换人查" : "没记下当时在做什么，到点也叫不回去；要它接着做就直接 @ 它")
      }
      // A reset already past: a little from now (still one timer per seat).
      const at = Math.max(resets + RESUME_MARGIN_MS, Math.ceil((Date.now() + RESUME_MARGIN_MS) / 60_000) * 60_000)
      setLimited(item, { resetsAt: resets, resumeAt: at })
      markLimited(runId, { state: "scheduled", at, note: undefined })
      armResume(runId, at)
      return { scheduled: at }
    }
    if (action === "cancel" || action === "dismiss") {
      // The seat's timer stays for its other runs; this one is off the list.
      setLimited(item, { resetsAt: item.limited?.resetsAt })
      markLimited(runId, { state: action === "cancel" ? "open" : "dismissed", at: undefined })
      return { ok: true }
    }
    throw new ApiError(400, "action 只能是 schedule、now、cancel 或 dismiss")
  })
}

// After a restart: the timers are gone, set the ones still owed.
function rearmResumes() {
  for (const item of pendingResumes()) {
    const at = item.limited?.resumeAt
    if (!at || !item.project) continue
    if (Date.now() - at > RESUME_STALE_MS) {
      setLimited(item, { resetsAt: item.limited?.resetsAt })
      try {
        inProject(item.project, () => markLimited(item.id, { state: "dismissed", at: undefined, note: "服务器重启时已经过了很久，没有自动继续" }))
      } catch {}
      continue
    }
    armResume(item.id, at)
  }
}

// The user took a message back: a seat it called and that hasn't started on it
// yet no longer will. A run already going has read it.
export function forgetMessage(messageId: string) {
  for (const [agentId, queue] of lanesMap()) {
    if (queue.running) continue
    const left = queue.pending.filter((item) => item.id !== messageId)
    if (left.length === queue.pending.length) continue
    queue.pending = left
    if (queue.trigger === messageId) queue.trigger = left.at(-1)?.id
    syncLane(agentId)
  }
}

export function ensureSummon() {
  g().__benchSummonHandler = wake
  ensureCheckSweep()
  g().__benchCheckHandler = ({ project, taskId, at }) => {
    try {
      inProject(project, () => requestCheck(taskId, at))
    } catch (error) {
      console.error(error)
    }
  }
  if (!g().__benchCheckBound) {
    g().__benchCheckBound = true
    // After the request for review is saved and answered.
    onCheckWanted((wanted) => setImmediate(() => g().__benchCheckHandler?.(wanted)))
  }
  lanesMap()
  if (!g().__benchTermBound) {
    g().__benchTermBound = true
    // What waited while the terminal was open runs now, the usual way.
    onTerminalClosed((agentId) => {
      try {
        inSeat(agentId, () => run(agentId))
      } catch {}
    })
  }
  if (!g().__benchSummonAnnounced) {
    g().__benchSummonAnnounced = true
    settleOpenCalls()
    abandonChecks()
    announceInterrupted()
    rearmResumes()
  }
  g().__benchGistHandler = (message) => {
    try {
      noteGistless(message)
    } catch (error) {
      console.error(error)
    }
  }
  if (!g().__benchGistBound) {
    g().__benchGistBound = true
    onMessage((message) => setImmediate(() => g().__benchGistHandler?.(message)))
  }
  if (g().__benchSummonBound) return
  g().__benchSummonBound = true
  // Deferred so a reply posted from stdout has its hop count recorded first.
  onMessage((message) => setImmediate(() => g().__benchSummonHandler?.(message)))
}
