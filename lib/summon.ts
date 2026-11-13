import { spawn, type ChildProcessByStdio } from "node:child_process"
import type { Readable } from "node:stream"
import { createHash, randomBytes } from "node:crypto"
import { StringDecoder } from "node:string_decoder"

import { adapterFor, commandFor, summonPath, type Adapter } from "@/lib/adapters"
import { compactEnv, CONTEXT_KINDS, seatContext, type SeatContext } from "@/lib/context"
import { dbLoadLanes, dbSaveLane } from "@/lib/db"
import { createParser, liveLine } from "@/lib/events"
import { ApiError } from "@/lib/http"
import { registerLaneReader } from "@/lib/lane-state"
import { detectLimit, whenText } from "@/lib/limits"
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
  postInterrupted,
  postLimited,
  projectOfSeat,
  endSummaryJob,
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
} from "@/lib/store"
import { withAttachments } from "@/lib/text"
import type { Message, RoomSummary, Run } from "@/lib/types"
import { flowsOf } from "@/lib/flow"
import { flowSummaryPrompt, flowsToSummarize } from "@/lib/flow-summary"

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
}

type SummonGlobal = typeof globalThis & {
  __benchSummonBound?: boolean
  __benchSummonAnnounced?: boolean
  __benchTermBound?: boolean
  // Runs the user asked to be woken again after a usage limit: when.
  __benchResumeTimers?: Map<string, NodeJS.Timeout>
  __benchSummonHandler?: (message: Message) => void
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
        const entry: Lane = {
          running: false,
          paused: paused || undefined,
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
  if (!q.paused && q.pending.length === 0) return undefined
  return {
    paused: Boolean(q.paused),
    queuedCount: q.pending.length,
    queuedItems: q.pending,
  }
})

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

function envelope(
  body: string,
  skipped: number,
  summary: RoomSummary | undefined,
  replyByStdout: boolean,
  claude = false,
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
    `${userName()} 要你做新功能时，开工前必须先用 bench_task 建一条待办：title 写功能，steps 拆成几步，owner 填你自己；每开始一步用 bench_step 标 doing，做完标 done，note 写做了什么、怎么验的。已有待办的就接着推进，不要重复建。做完了用 bench_task_update 的 review 请 ${userName()} 验收（note 写怎么看效果）；「验收」那一步只有 ${userName()} 能在右栏点通过或打回，你不要自己勾，被打回会带着原因叫醒你。`
  // Two agents can keep @-ing each other; the one that sees the round is done ends it.
  const end = replyByStdout
    ? `如果这一轮交接已经完成、不需要谁再接手，回答以「${END_MARK}」开头，写一句做完了什么，不要 @ 任何人。`
    : `如果这一轮交接已经完成、不需要谁再接手，用 bench_say 带 end: true 发一句做完了什么，不要 @ 任何人。`
  // Claude Code's prompts reach the page (claude-code.sh, lib/permits.ts).
  const permit = claude && full
    ? `${userName()} 给了你这个席位默认的全部权限：命令和工具直接用，不用 bench_elevate 申请。改动、删除、对外发送这类事照样以他说的为准。sudo 密码只能他自己在终端输。`
    : claude
    ? `跑命令被权限拦住、需要确认或要用没放行的工具时，先用 bench_elevate 说明要做什么、为什么，请 ${userName()} 给这次唤起临时完整权限，别直接放弃或绕路；单条命令的确认也会弹到他的网页上等他点。sudo 密码只能他自己在终端输。`
    : ""
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
  const whole = `${how}${thread}${todo}${ask}${attach}${permit}${stop}`
  // The same rules in a line, for a session that has them whole further up.
  const brief = [
    "守则同前，要点：",
    replyByStdout ? "最后的回答直接输出，会挂成回复；" : "回复用 bench_say；",
    `新功能先用 bench_task 建待办、bench_step 逐步推进，做完用 review 请 ${userName()} 验收，验收不要自己勾；`,
    `问 ${userName()} 用 bench_ask；附件用 ${replyByStdout ? "bench_attach" : "bench_say 的 attachments"}；`,
    claude && full ? "你有默认全部权限，不用 bench_elevate；" : claude ? "被权限拦住先用 bench_elevate 申请；" : "",
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
  return failure
}

function tail(text: string, max: number) {
  const clean = text.trim().replace(/\s+/g, " ")
  return clean.length > max ? `…${clean.slice(-max)}` : clean
}

// Did the turn end on the account's usage limit? The client says so in its last
// words, but its error line (what `failure` holds) can be about anything else,
// so go by what it said. Said only when the turn failed: a seat that merely
// quotes the message is not limited.
function limitOf(log: Run, out: string) {
  const last = [...log.steps].reverse().find((step) => step.kind === "text")?.title ?? ""
  // Codex says it in the error that fails the turn (a note step, lib/events.ts).
  const failed = log.steps.find((step) => step.kind === "note" && step.state === "failed")?.title ?? ""
  for (const text of [out, last, failed]) {
    if (/^\s*You(?:'|’)ve hit your/i.test(text)) {
      const hit = detectLimit(text)
      if (hit) return hit
    }
  }
  return null
}

// Say in the room that a seat ran out of allowance, with the card that lets
// the user have it carry on once it resets. Returns whether it was one.
function noteLimit(agent: NonNullable<ReturnType<typeof agentState>>, log: Run, out: string) {
  const hit = limitOf(log, out)
  if (!hit) return false
  setLimited(log, { resetsAt: hit.resetsAt })
  const when = hit.resetsAt ? `${whenText(hit.resetsAt)} 重置` : "没写几点重置"
  postLimited(`${agent.name} 撞到了「${hit.label}」，${when}。这次没做完，可以让它重置后自动接着做`, {
    runId: log.id,
    agentId: agent.id,
    agentName: agent.name,
    label: hit.label,
    resetsAt: hit.resetsAt,
    state: "open",
  })
  return true
}

function reportFailure(agent: NonNullable<ReturnType<typeof agentState>>, log: Run, failure: string, out: string, what: string) {
  if (noteLimit(agent, log, out)) return
  postSystem(`${what}没成功：${explain(agent.agentName, failure)}`)
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
  const finish = bindProject((code: number | null, failure?: string) => {
    if (finished) return
    finished = true
    lane(agent.id).stop = undefined
    // A woken run is one-shot: a wait loop it ran (bench_wait) ends with it,
    // so later mentions wake it again instead of waiting for a loop that's gone.
    clearStandby(agent.id)
    clearTimeout(endedTimer)
    clearInterval(quiet)
    if (pending) take(pending)
    const out = parser.answer()
    // Some CLIs print their error to stderr and still exit 0 (WorkBuddy's when
    // signed out); with no answer at all, that error is the outcome.
    const silent = code === 0 && !out.trim() && run.steps.length === 0 && err.trim()
    const why = failure ?? (code !== 0 ? tail(err, 160) || `退出码 ${code}` : silent ? tail(err, 160) : undefined)
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
        ...(agent.modelPick ? { BENCH_MODEL: agent.modelPick } : {}),
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
  child.stdout.on("data", bindProject((chunk: Buffer) => {
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

// Shows the seat as busy while a command runs, and puts back what it was
// doing before, unless it changed that itself meanwhile.
function busy(agentId: string, doing: string) {
  const before = agentState(agentId)?.doing ?? ""
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
      const still = agentState(agentId)
      // A question still unanswered stays up after the run; an answered one gives way.
      if (still && (still.doing === shown || (askSettled(still.doing) && !still.doing.startsWith("问了")))) {
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
    queue.pending = []
    queue.summary = false
    queue.compact = false
    queue.goal = undefined
    syncLane(agentId)
    return
  }
  const adapter = adapterFor(agent.agentName)
  if (!adapter) {
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
  if (queue.goal !== undefined) {
    const text = queue.goal
    queue.goal = undefined
    syncLane(agentId)
    setGoal(agent, adapter, text)
    return
  }
  if (queue.pending.length === 0 && !queue.carry) return

  const seen = catchUp(agentId, CATCH_UP_CHARS, queue.dropped ? new Set(queue.dropped) : undefined)
  queue.dropped = undefined
  // Its inbox may already have shown it the mention; fall back to the queue.
  const fresh = seen.text || queue.pending.map((item: { line: string }) => item.line).join("\n\n")
  const carried = queue.carry
  queue.carry = undefined
  const body = carried
    ? `【刚才被打断、还没回的】\n${carried}${fresh ? `\n\n【之后的新消息】\n${fresh}` : ""}`
    : fresh
  const wrapped = envelope(body, seen.skipped, seen.summary, adapter.reply === "stdout", agent.agentName === "claude", Boolean(agent.autoFull), agent)
  const command = commandFor(
    agent.agentName,
    agent.session,
    introduce(agent) + wrapped.text,
    agent.modelPick,
    agent.effortPick,
  )
  const hop = queue.hops
  const trigger = queue.trigger
  queue.pending = []
  queue.hops = 0
  queue.trigger = undefined
  syncLane(agentId)
  if (!command) return

  queue.running = true
  const startedLink = { agentName: agent.agentName, session: agent.session }
  const log = startRun(agentId, agent.name, "reply", { project: currentProject(), body, replyTo: trigger })
  queue.key = randomBytes(12).toString("hex")
  queue.project = currentProject()
  queue.log = log
  queue.midHop = undefined
  const seat = busy(agentId, "被点到了，正在回复")
  launch(agent, command, log, seat.live, ({ out, failure, stopped, lost }) => {
    queue.running = false
    queue.key = undefined
    queue.log = undefined
    const reach = Math.max(hop, queue.midHop ?? 0)
    queue.midHop = undefined
    const still = agentState(agentId)
    const sameBinding = still?.agentName === startedLink.agentName && still?.session === startedLink.session
    if (lost && !stopped) {
      postSystem(`${agent.name} 这次有一行输出太长（超过 8MB）没读，下面贴出的回答可能不完整，「查看过程」里能看到读到的部分`)
    }
    if (stopped) {
      // Stopped for an interjection: pick these messages up again after it.
      if (queue.whisper !== undefined) {
        queue.carry = body
        queue.trigger ??= trigger
        syncLane(agentId)
      }
      endRun(log, "failed", queue.whisper !== undefined ? "被单独插话打断，回完接着做" : "被你停下了")
      seat.settle()
      run(agentId)
      return
    } else if (failure) {
      reportFailure(agent, log, failure, out, `唤起 ${agent.name} `)
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
    if (!failure) markWoken(agentId, startedLink, wrapped.rules)
    endRun(log, failure ? "failed" : "done", failure ? `没成功：${failure}` : undefined)
    seat.settle()
    run(agentId)
  })
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
  const body = carried ? `【刚才被打断、还没回的】\n${carried}${fresh ? `\n\n【之后的新消息】\n${fresh}` : ""}` : fresh
  queue.pending = []
  queue.hops = 0
  queue.trigger = undefined
  syncLane(agent.id)
  // Typed in, there is no answer to read off stdout: it replies with bench_say.
  // Its permission prompts show in the terminal itself, not on the page.
  const startedLink = { agentName: agent.agentName, session: agent.session }
  const wrapped = envelope(body, seen.skipped, seen.summary, false, false, false, agent)
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
      reportFailure(agent, log, failure, out, `请 ${agent.name} 写摘要`)
    } else if (byStdout) {
      try {
        saveSummary(out, agent.name, prompt.upToSeq, prompt.flowsAt)
      } catch {
        postSystem(`${agent.name} 没写出摘要`)
      }
    } else if ((snapshot().summary?.at ?? 0) < asked) {
      // Some models write the summary as their answer instead of calling
      // bench_summary; a full one in the asked format is taken as handed in.
      const written = out.slice(out.indexOf("## 结论")).trim()
      if (out.includes("## 结论") && written.includes("## 进行中") && written.includes("## 待定")) {
        saveSummary(written, agent.name, prompt.upToSeq, prompt.flowsAt)
      } else {
        postSystem(`${agent.name} 这一轮没交摘要`)
      }
    }
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
  launch(agent, command, log, seat.live, ({ out, failure, stopped }) => {
    queue.running = false
    endRun(log, failure || stopped ? "failed" : "done", stopped ? "被停下了" : failure ? `没成功：${failure}` : undefined)
    seat.settle()
    if (failure && !stopped) reportFailure(agent, log, failure, out, `压缩 ${agent.name} 的上下文`)
    else if (!stopped) {
      const after = seatContext(agent.agentName, agent.session, agent)
      // Only a new compaction in its record counts: a short conversation
      // gets "Not enough messages to compact." and stays as it was.
      const done = (after?.compacted?.at ?? 0) > (before?.compacted?.at ?? 0)
      const was = tokensText(before)
      const now = tokensText(after)
      postSystem(
        !done
          ? `${agent.name} 这次没压缩${out.trim() ? `：${out.trim().slice(0, 200)}` : ""}`
          : now
            ? `${agent.name} 的上下文压缩好了${was ? `：${was} → ${now}` : `，现在 ${now}`}`
            : `${agent.name} 的上下文压缩好了，现在多大要等它下一轮才知道`,
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
    if (failure && !stopped) reportFailure(agent, log, failure, out, clearing ? `清掉 ${agent.name} 的目标` : `让 ${agent.name} 按目标干活`)
    else if (!stopped && clearing) postSystem(`${agent.name} 的目标清掉了`)
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
  queue.goal = text
  syncLane(agent.id)
  const clearing = CLEAR_GOAL.test(text)
  postSystem(
    clearing
      ? `${userName()} 让 ${agent.name} 清掉目标`
      : `${userName()} 给 ${agent.name} 定了目标：${text}\n它会一直做到达成为止；要停就 /stop，要撤掉目标就 /goal clear`,
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
    if (failure && !stopped) noteLimit(agent, log, out)
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
  if (!queue.stop) {
    // Marked running with no process to stop: a start that failed halfway
    // (spawn E2BIG once left a summary job behind). Clear the marks so the
    // seat is free again, instead of answering "not running" to a seat the
    // page shows as working.
    const stale = queue.running || summaryJob()?.agentId === agentId || activeRun(agentId)
    if (!stale) throw new ApiError(409, `${agent.name} 现在没在跑`)
    const dropped = queue.pending.length
    queue.pending = []
    queue.carry = undefined
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
    syncLane(agentId)
    return { dropped, cleared: true }
  }
  const dropped = queue.pending.length
  queue.pending = []
  queue.carry = undefined
  queue.summary = false
  queue.compact = false
  queue.goal = undefined
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
    queue.pending = []
    queue.carry = undefined
    queue.trigger = undefined
    queue.hops = 0
  } else {
    const had = queue.pending.some((item) => item.id === messageId)
    queue.pending = queue.pending.filter((item) => item.id !== messageId)
    if (had) queue.dropped = [...new Set([...(queue.dropped ?? []), messageId])].slice(-200)
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
    markReached(items.map((item: { id: string }) => item.id), agentId)
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
  if (message.authorId === "human") return 0
  const called = calledAt().get(message.authorId)
  return called === undefined ? 0 : called + 1
}

function wake(message: Message) {
  if (message.kind === "system") return
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
          postSystem(`${agent.name} 正在守着房间（bench_wait），这会儿在处理上一条：消息排着等它来取。它要是不再守了，房间会改成直接叫醒它`)
        }
        watchStandby(agent.id, message, hop)
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
      postSystem(`${agent.name} 被点到了，但还没报 agent 和 uuid，叫不醒`)
    }
    return
  }
  if (!adapterFor(agent.agentName)) {
    if (cooled(`${agent.id}:config`, NOTE_GAP_MS)) {
      postSystem(`${agent.name} 被点到了，还没有 ${agent.agentName} 的唤起命令`)
    }
    return
  }
  const queue = lane(agent.id)
  queue.projectId = currentProject()
  queue.pending.push({ id: message.id, line: `${message.authorName}：${withAttachments(message.text, message.attachments)}` })
  queue.hops = Math.max(queue.hops, hop)
  queue.trigger = message.id
  syncLane(agent.id)
  run(agent.id)
}

// A mention held for a seat between two of its waits. Once the seat has read
// past it, done; while it is still on standby, look again later; once it no
// longer is (its session went away without another wait), wake it the usual
// way so the mention isn't lost.
const STANDBY_CHECK_MS = 30_000
function watchStandby(agentId: string, message: Message, hop: number) {
  const check = bindProject(() => {
    const agent = agentState(agentId)
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
  for (const item of takeUnannounced()) {
    if (!item.project) continue
    byProject.set(item.project, [...(byProject.get(item.project) ?? []), item])
  }
  for (const [project, list] of byProject) {
    try {
      inProject(project, () => {
        const what = { reply: "回复", private: "单独回话", summary: "写摘要", compact: "压缩上下文", goal: "按目标干活" } as const
        // Its seat still shows the reply it never finished.
        for (const item of list) {
          try {
            pulseAgent(item.agentId, "idle", "被服务器重启打断了")
          } catch {}
        }
        const names = list.map((item) => `${item.agentName}（${what[item.purpose]}）`).join("、")
        postInterrupted(
          `服务器重启，打断了 ${names}。没回完的话没发出来，点下面重新叫醒，会带着原来那些消息接着做`,
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

// Wake a seat again with what a cut-off run was doing: one the room's restart
// stopped, or one that ended on the usage limit.
export function rewake(runId: string) {
  const item = getRun(runId)
  if (!item || !(item.interrupted || item.limited)) throw new ApiError(404, "这次唤起不是被重启或额度打断的，或者记录已经不在了")
  if (item.resumedAt) throw new ApiError(409, `${item.agentName} 已经重新叫醒过了`)
  if (!item.project) throw new ApiError(400, "这次唤起没记下项目，叫不回去")
  return inProject(item.project, () => {
    const agent = wakeable(item.agentId)
    const queue = lane(agent.id)
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
    }
    markResumed(item)
    markInterruptedResumed(item.id, item.resumedAt ?? Date.now())
    markLimited(item.id, { state: "resumed", at: item.resumedAt ?? Date.now(), note: undefined })
    if (item.interrupted) queue.paused = undefined
    syncLane(agent.id)
    run(agent.id)
    return { agent: agent.name, started: queue.running }
  })
}

// Carry over a usage-limited run onto the seat's newly rebound AI backend and
// wake it right away so the work continues without waiting for quota reset.
export function resumeLimitedAfterRebind(runId: string, reboundToLabel: string) {
  const item = getRun(runId)
  if (!item?.limited || item.resumedAt || !item.project) return { started: false }
  return inProject(item.project, () => {
    clearTimeout(resumeTimers().get(runId))
    resumeTimers().delete(runId)
    const agent = agentState(item.agentId)
    if (!agent) return { started: false }
    const queue = lane(agent.id)
    queue.projectId = item.project
    queue.paused = undefined
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

function armResume(runId: string, at: number) {
  clearTimeout(resumeTimers().get(runId))
  const wait = Math.max(0, at - Date.now())
  // setTimeout can't count past ~24 days; a reset is hours away.
  resumeTimers().set(runId, setTimeout(() => fireResume(runId), Math.min(wait, 2 ** 31 - 1)))
}

function fireResume(runId: string) {
  resumeTimers().delete(runId)
  const item = getRun(runId)
  if (!item?.limited?.resumeAt || item.resumedAt || !item.project) return
  inProject(item.project, () => {
    try {
      rewake(runId)
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error)
      setLimited(item, { ...item.limited, resumeAt: undefined })
      markLimited(runId, { state: "failed", at: Date.now(), note: why })
      postSystem(`额度重置了，想叫醒 ${item.agentName} 接着做，没成功：${why}`)
    }
  })
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
      const at = resets + RESUME_MARGIN_MS
      setLimited(item, { resetsAt: resets, resumeAt: at })
      markLimited(runId, { state: "scheduled", at, note: undefined })
      armResume(runId, at)
      return { scheduled: at }
    }
    if (action === "cancel" || action === "dismiss") {
      clearTimeout(resumeTimers().get(runId))
      resumeTimers().delete(runId)
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
    announceInterrupted()
    rearmResumes()
  }
  if (g().__benchSummonBound) return
  g().__benchSummonBound = true
  // Deferred so a reply posted from stdout has its hop count recorded first.
  onMessage((message) => setImmediate(() => g().__benchSummonHandler?.(message)))
}
