import { spawn } from "node:child_process"
import { StringDecoder } from "node:string_decoder"

import { adapterFor, commandFor, summonPath, type Adapter } from "@/lib/adapters"
import { createParser, liveLine } from "@/lib/events"
import { ApiError } from "@/lib/http"
import { endRun, getRun, markResumed, putStep, startRun, takeUnannounced } from "@/lib/runs"
import {
  agentState,
  bindProject,
  CATCH_UP_CHARS,
  currentProject,
  currentProjectInfo,
  catchUp,
  inProject,
  markInterruptedResumed,
  postInterrupted,
  endSummaryJob,
  isStandby,
  markWoken,
  onMessage,
  postSystem,
  pulseAgent,
  relayClosed,
  saveSummary,
  sayAs,
  snapshot,
  startSummaryJob,
  summaryJob,
  summarySource,
  summonCandidates,
  END_MARK,
} from "@/lib/store"
import { withAttachments } from "@/lib/text"
import type { Message, RoomSummary, Run } from "@/lib/types"

const NOTE_GAP_MS = 30_000
const RUN_LIMIT_MS = 15 * 60_000
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
// Agents answering agents can bounce forever. Stop the relay after this many
// automatic hops and wait for a human message.
const MAX_HOPS = 3

// One queue per seat. A seat runs one command at a time; messages that land
// while it runs are batched into the next run instead of being dropped.
// `summary`: the user asked this seat for a room summary; it runs before the
// next batch of messages.
// `stop`: ends the command running now, if any. `carry`: the room messages a
// run was answering when someone interjected; the next run takes them up again.
// `whisper`: what the user said to this seat alone, run before anything else.
type Lane = {
  running: boolean
  // What called it since its last run, by message id, so a recalled message
  // can be taken back out before the run starts.
  pending: { id: string; line: string }[]
  hops: number
  summary?: boolean
  stop?: () => void
  carry?: string
  whisper?: string
  // The latest message that called this seat; the next reply answers it.
  trigger?: string
}

type SummonGlobal = typeof globalThis & {
  __benchSummonBound?: boolean
  __benchSummonAnnounced?: boolean
  __benchSummonHandler?: (message: Message) => void
  __benchSummonAt?: Map<string, number>
  __benchLanes?: Map<string, Lane>
  __benchHops?: Map<string, number>
}

function g() {
  return globalThis as SummonGlobal
}

function lane(id: string) {
  const store = (g().__benchLanes ??= new Map())
  let found = store.get(id)
  if (!found) {
    found = { running: false, pending: [], hops: 0 }
    store.set(id, found)
  }
  return found
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

// Said once, on the first wake of a session the room created: it starts with
// no idea where it is.
function introduce(agent: NonNullable<ReturnType<typeof agentState>>) {
  if (!agent.fresh) return ""
  return `【你是并坐房间新开的会话】你在「${currentProjectInfo().name}」项目里叫 ${agent.name}，分工是「${agent.role}」，工作目录是 ${agent.workdir}。房间已经替你入座了，bench 工具直接能用，不用再 bench_join。别人 @${agent.name} 时房间会叫醒你。\n\n`
}

function envelope(body: string, skipped: number, summary: RoomSummary | undefined, replyByStdout: boolean, claude = false) {
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
    "jinbao 要你做新功能时，开工前必须先用 bench_task 建一条待办：title 写功能，steps 拆成几步，owner 填你自己；每开始一步用 bench_step 标 doing，做完标 done，note 写做了什么、怎么验的。已有待办的就接着推进，不要重复建。做完了用 bench_task_update 的 review 请 jinbao 验收（note 写怎么看效果）；「验收」那一步只有 jinbao 能在右栏点通过或打回，你不要自己勾，被打回会带着原因叫醒你。"
  // Two agents can keep @-ing each other; the one that sees the round is done ends it.
  const end = replyByStdout
    ? `如果这一轮交接已经完成、不需要谁再接手，回答以「${END_MARK}」开头，写一句做完了什么，不要 @ 任何人。`
    : `如果这一轮交接已经完成、不需要谁再接手，用 bench_say 带 end: true 发一句做完了什么，不要 @ 任何人。`
  // Claude Code's prompts reach the page (claude-code.sh, lib/permits.ts).
  const permit = claude
    ? "跑命令被权限拦住、需要确认或要用没放行的工具时，先用 bench_elevate 说明要做什么、为什么，请 jinbao 给这次唤起临时完整权限，别直接放弃或绕路；单条命令的确认也会弹到他的网页上等他点。sudo 密码只能他自己在终端输。"
    : ""
  const stop = `${end}这之后 agent 之间不再互相唤起，等 jinbao 发话再继续。`
  // Woken, nobody watches the client: questions go to the page.
  const ask =
    "要问 jinbao、让他拍板时用 bench_ask（可以给选项），不要用你客户端自带的提问工具，这里没人看得到；它会等他在网页上回答，答案作为工具结果返回。能自己判断的别问。"
  // Recordings, sounds and pictures ride along with the answer (lib/store.ts pinAttachments).
  const attach = replyByStdout
    ? "汇报里要给 jinbao 看视频、音频或图片时，用 bench_attach 挂上文件的绝对路径，会跟你的回答一起发出，网页上能直接播放。"
    : "汇报里要给 jinbao 看视频、音频或图片时，bench_say 的 attachments 填文件的绝对路径，网页上能直接播放。"
  // Say plainly how complete the batch is, so the seat does not go digging
  // for messages it already has, or trust a batch that was cut.
  const scope =
    skipped === 0
      ? "下面是你上次之后房间里的全部消息，一条没漏，不用再去 bench_inbox 查。"
      : summary
        ? `你上次之后的消息太多，更早的 ${skipped} 条没列；先附上房间摘要（${summary.by} 写于 ${stamp(summary.at)}，概括了那之前的对话），再列最近的原文。需要原文用 bench_inbox 查。`
        : `下面是你上次之后房间里的消息，太长只列了最近这些；更早还有 ${skipped} 条没列，需要的话用 bench_inbox 查。`
  const digest = skipped > 0 && summary ? `【房间摘要】\n${summary.text}\n\n【最近的原文】\n` : ""
  return `【并坐「${currentProjectInfo().name}」项目转来的消息】\n${scope}只略去了你自己说的话和入座、离席这类系统通知。★ 是在叫你的。\n\n${digest}${body}\n\n（${how}${thread}${todo}${ask}${attach}${permit}${stop}）`
}

function summaryPrompt(replyByStdout: boolean) {
  const source = summarySource()
  const previous = source.previous
    ? `【上一份摘要】（${source.previous.by} 写于 ${stamp(source.previous.at)}）\n${source.previous.text}`
    : "【上一份摘要】还没有，这是第一份。"
  const scope =
    source.shown === source.count
      ? `下面是上一份摘要之后的全部 ${source.count} 条对话，一条没漏。`
      : `上一份摘要之后共 ${source.count} 条对话，太长只列了最近 ${source.shown} 条，更早的略去了。`
  const how = replyByStdout
    ? "直接输出摘要全文就行，你这次的输出会存成房间摘要，不会贴进群聊。"
    : "写好后调用 bench_summary 工具交上来，不要用 bench_say 发到群里。"
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
      source.text || "（没有新对话）",
      "",
      `（${how}）`,
    ].join("\n"),
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
  if (agentName === "dsh" && /cannot compose presets/.test(failure)) {
    return "它是在 DeepSeek Harness 网页端开的会话，带着 Agent 预设；房间用的 dsh-agent 只能接着跑它自己 exec 开的、不带预设的会话，叫不醒网页端的。让它在网页端「守着房间」（循环 bench_wait）就不用唤起；要叫得醒，就在终端用 dsh-agent exec 开会话再接入并坐。写摘要可以先换别人。"
  }
  return failure
}

function tail(text: string, max: number) {
  const clean = text.trim().replace(/\s+/g, " ")
  return clean.length > max ? `…${clean.slice(-max)}` : clean
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
    // so the answer goes up now and not when the 15 minutes run out. Not left
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
  const finish = bindProject((code: number | null, failure?: string) => {
    if (finished) return
    finished = true
    lane(agent.id).stop = undefined
    clearTimeout(timer)
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
  const child = spawn(command, {
    shell: true,
    detached: true,
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PATH: summonPath(),
      BENCH_URL: roomUrl(),
      BENCH_AGENT: agent.agentName,
      BENCH_UUID: agent.session,
      BENCH_SESSION: agent.session,
      // A session the room created: where its first wake starts it.
      ...(agent.workdir ? { BENCH_NEW_DIR: agent.workdir } : {}),
    },
  })
  const kill = () => {
    try {
      if (child.pid) process.kill(-child.pid, "SIGTERM")
    } catch {
      child.kill("SIGTERM")
    }
  }
  lane(agent.id).stop = () => {
    stopped = true
    kill()
    finish(null)
  }
  const timer = setTimeout(() => {
    kill()
    finish(null, "超过 15 分钟没结束，已停掉")
  }, RUN_LIMIT_MS)
  let quiet: NodeJS.Timeout | undefined
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
      if (!still || still.doing !== shown) return
      shown = line
      try {
        pulseAgent(agentId, "working", line)
      } catch {}
    },
    settle() {
      const still = agentState(agentId)
      if (still && still.doing === shown) {
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
    return
  }
  const adapter = adapterFor(agent.agentName)
  if (!adapter) {
    queue.pending = []
    queue.summary = false
    return
  }
  if (queue.whisper !== undefined) {
    const text = queue.whisper
    queue.whisper = undefined
    answerWhisper(agent, text)
    return
  }
  if (queue.summary) {
    queue.summary = false
    writeSummary(agent, adapter)
    return
  }
  if (queue.pending.length === 0 && !queue.carry) return

  const seen = catchUp(agentId, CATCH_UP_CHARS)
  // Its inbox may already have shown it the mention; fall back to the queue.
  const fresh = seen.text || queue.pending.map((item: { line: string }) => item.line).join("\n\n")
  const carried = queue.carry
  queue.carry = undefined
  const body = carried
    ? `【刚才被打断、还没回的】\n${carried}${fresh ? `\n\n【之后的新消息】\n${fresh}` : ""}`
    : fresh
  const command = commandFor(
    agent.agentName,
    agent.session,
    introduce(agent) + envelope(body, seen.skipped, seen.summary, adapter.reply === "stdout", agent.agentName === "claude"),
  )
  const hop = queue.hops
  const trigger = queue.trigger
  queue.pending = []
  queue.hops = 0
  queue.trigger = undefined
  if (!command) return

  queue.running = true
  const log = startRun(agentId, agent.name, "reply", { project: currentProject(), body, replyTo: trigger })
  const seat = busy(agentId, "被点到了，正在回复")
  launch(agent, command, log, seat.live, ({ out, failure, stopped, lost }) => {
    queue.running = false
    const still = agentState(agentId)
    if (lost && !stopped) {
      postSystem(`${agent.name} 这次有一行输出太长（超过 8MB）没读，下面贴出的回答可能不完整，「查看过程」里能看到读到的部分`)
    }
    if (stopped) {
      // Stopped for an interjection: pick these messages up again after it.
      if (queue.whisper !== undefined) {
        queue.carry = body
        queue.trigger ??= trigger
      }
      endRun(log, "failed", queue.whisper !== undefined ? "被单独插话打断，回完接着做" : "被你停下了")
      seat.settle()
      run(agentId)
      return
    } else if (failure) {
      postSystem(`唤起 ${agent.name} 没成功：${explain(agent.agentName, failure)}`)
    } else if (adapter.reply === "stdout" && still && out) {
      try {
        // Posted while the run is still open, so the message links to it.
        const said = sayAs({ type: "agent", id: still.id, name: still.name }, { text: out.slice(0, 4000) })
        hops().set(said.message.id, hop + 1)
        if (hops().size > 500) hops().delete(hops().keys().next().value ?? "")
      } catch (error) {
        console.error(error)
      }
    }
    if (!failure && agent.fresh) markWoken(agentId)
    endRun(log, failure ? "failed" : "done", failure ? `没成功：${failure}` : undefined)
    seat.settle()
    run(agentId)
  })
}

function writeSummary(agent: NonNullable<ReturnType<typeof agentState>>, adapter: Adapter) {
  const byStdout = adapter.reply === "stdout"
  const prompt = summaryPrompt(byStdout)
  const command = commandFor(agent.agentName ?? "", agent.session ?? "", prompt.text)
  if (!command) return
  const queue = lane(agent.id)
  queue.running = true
  const asked = Date.now()
  startSummaryJob(agent.id, prompt.upToSeq)
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
      postSystem(`请 ${agent.name} 写摘要没成功：${explain(agent.agentName, failure)}`)
    } else if (byStdout) {
      try {
        saveSummary(out, agent.name, prompt.upToSeq)
      } catch {
        postSystem(`${agent.name} 没写出摘要`)
      }
    } else if ((snapshot().summary?.at ?? 0) < asked) {
      // Some models write the summary as their answer instead of calling
      // bench_summary; a full one in the asked format is taken as handed in.
      const written = out.slice(out.indexOf("## 结论")).trim()
      if (out.includes("## 结论") && written.includes("## 进行中") && written.includes("## 待定")) {
        saveSummary(written, agent.name, prompt.upToSeq)
      } else {
        postSystem(`${agent.name} 这一轮没交摘要`)
      }
    }
    run(agent.id)
  })
}

// Something the user says to one seat alone. It doesn't go into the room and
// the answer doesn't either: both are kept on the run, and the 「单独说」
// dialog lists them.
function whisperPrompt(text: string, interrupted: boolean) {
  return [
    "【并坐房间里的 jinbao 单独对你说】",
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
  const command = commandFor(agent.agentName ?? "", agent.session ?? "", introduce(agent) + whisperPrompt(text, interrupted))
  if (!command) return
  queue.running = true
  const log = startRun(agent.id, agent.name, "private", { project: currentProject(), ask: text })
  const seat = busy(agent.id, "在回你单独说的话")
  launch(agent, command, log, seat.live, ({ out, failure, stopped }) => {
    queue.running = false
    if (!stopped && !failure) {
      log.answer = out.slice(0, 4000)
      if (agent.fresh) markWoken(agent.id)
    }
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
  if (!queue.stop) throw new ApiError(409, `${agent.name} 现在没在跑`)
  const dropped = queue.pending.length
  queue.pending = []
  queue.carry = undefined
  queue.summary = false
  queue.stop()
  return { dropped }
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
  run(agentId)
  return snapshot()
}

function wake(message: Message) {
  if (message.kind === "system") return
  const hop = hops().get(message.id) ?? 0
  const fromHuman = message.authorId === "human"
  // Someone ended the round: agents' messages wake nobody until the user speaks.
  if (!fromHuman && relayClosed()) return
  for (const agent of summonCandidates(message)) {
    // Between agents only an explicit @ or a handoff wakes someone.
    if (!fromHuman && !message.mentions.includes(agent.id) && message.handoff?.toId !== agent.id) {
      continue
    }
    if (hop >= MAX_HOPS) {
      if (cooled("relay-cap", NOTE_GAP_MS)) {
        postSystem(`agent 之间已经自动接力 ${MAX_HOPS} 轮，先停下，等 jinbao 发话再继续`)
      }
      continue
    }
    // A seat on standby picks the message up from its own wait loop; waking it
    // with a command would start a second run on the same session.
    if (isStandby(agent.id)) continue
    if (!agent.agentName || !agent.session) {
      if (cooled(`${agent.id}:session`, NOTE_GAP_MS)) {
        postSystem(`${agent.name} 被点到了，但还没报 agent 和 uuid，叫不醒`)
      }
      continue
    }
    if (!adapterFor(agent.agentName)) {
      if (cooled(`${agent.id}:config`, NOTE_GAP_MS)) {
        postSystem(`${agent.name} 被点到了，还没有 ${agent.agentName} 的唤起命令`)
      }
      continue
    }
    const queue = lane(agent.id)
    queue.pending.push({ id: message.id, line: `${message.authorName}：${withAttachments(message.text, message.attachments)}` })
    queue.hops = Math.max(queue.hops, hop)
    queue.trigger = message.id
    run(agent.id)
  }
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
        const what = { reply: "回复", private: "单独回话", summary: "写摘要" } as const
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

// Wake a seat again with what a cut-off run was doing.
export function rewake(runId: string) {
  const item = getRun(runId)
  if (!item || !item.interrupted) throw new ApiError(404, "这次唤起不是被重启打断的，或者记录已经不在了")
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
    } else {
      if (!item.body) throw new ApiError(400, "没记下当时在回哪些消息")
      queue.carry = queue.carry ? `${item.body}\n\n${queue.carry}` : item.body
      queue.trigger ??= item.replyTo
    }
    markResumed(item)
    markInterruptedResumed(item.id, item.resumedAt ?? Date.now())
    run(agent.id)
    return { agent: agent.name, started: queue.running }
  })
}

// The user took a message back: a seat it called and that hasn't started on it
// yet no longer will. A run already going has read it.
export function forgetMessage(messageId: string) {
  for (const queue of g().__benchLanes?.values() ?? []) {
    if (queue.running) continue
    const left = queue.pending.filter((item) => item.id !== messageId)
    if (left.length === queue.pending.length) continue
    queue.pending = left
    if (queue.trigger === messageId) queue.trigger = left.at(-1)?.id
  }
}

export function ensureSummon() {
  g().__benchSummonHandler = wake
  if (!g().__benchSummonAnnounced) {
    g().__benchSummonAnnounced = true
    announceInterrupted()
  }
  if (g().__benchSummonBound) return
  g().__benchSummonBound = true
  // Deferred so a reply posted from stdout has its hop count recorded first.
  onMessage((message) => setImmediate(() => g().__benchSummonHandler?.(message)))
}
