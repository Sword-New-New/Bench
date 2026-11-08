import { spawn } from "node:child_process"

import { adapterFor, commandFor, summonPath, type Adapter } from "@/lib/adapters"
import { createParser, liveLine } from "@/lib/events"
import { ApiError } from "@/lib/http"
import { endRun, putStep, startRun } from "@/lib/runs"
import {
  agentState,
  CATCH_UP_CHARS,
  catchUp,
  endSummaryJob,
  isStandby,
  onMessage,
  postSystem,
  pulseAgent,
  saveSummary,
  sayAs,
  snapshot,
  startSummaryJob,
  summaryJob,
  summarySource,
  summonCandidates,
} from "@/lib/store"
import type { Message, RoomSummary, Run } from "@/lib/types"

const NOTE_GAP_MS = 30_000
const RUN_LIMIT_MS = 15 * 60_000
const OUT_LIMIT = 64_000
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
type Lane = { running: boolean; pending: string[]; hops: number; summary?: boolean }

type SummonGlobal = typeof globalThis & {
  __benchSummonBound?: boolean
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

function envelope(body: string, skipped: number, summary: RoomSummary | undefined, replyByStdout: boolean) {
  const how = replyByStdout
    ? "最后的回答直接输出就行，会作为你的发言贴回房间，不用调用 bench_say。中途的进度、逐条汇报直接说出来：这些话会实时显示在你自己的席位和过程记录里，用户看得到，但不会进群聊，所以不要用 bench_say 刷进度。"
    : `回复请发回房间：有 bench_say 工具就用它；没有的话 POST ${roomUrl()}/api/v1/say，带你入座时的 agentId 和 token。`
  // Say plainly how complete the batch is, so the seat does not go digging
  // for messages it already has, or trust a batch that was cut.
  const scope =
    skipped === 0
      ? "下面是你上次之后房间里的全部消息，一条没漏，不用再去 bench_inbox 查。"
      : summary
        ? `你上次之后的消息太多，更早的 ${skipped} 条没列；先附上房间摘要（${summary.by} 写于 ${stamp(summary.at)}，概括了那之前的对话），再列最近的原文。需要原文用 bench_inbox 查。`
        : `下面是你上次之后房间里的消息，太长只列了最近这些；更早还有 ${skipped} 条没列，需要的话用 bench_inbox 查。`
  const digest = skipped > 0 && summary ? `【房间摘要】\n${summary.text}\n\n【最近的原文】\n` : ""
  return `【并坐房间转来的消息】\n${scope}只略去了你自己说的话和入座、离席这类系统通知。★ 是在叫你的。\n\n${digest}${body}\n\n（${how}）`
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
  done: (result: { out: string; failure?: string }) => void,
) {
  const parser = createParser()
  let pending = ""
  let size = 0
  let err = ""
  let finished = false
  let shownAt = 0
  const take = (line: string) => {
    for (const step of parser.feed(line)) {
      putStep(run, step)
      const text = liveLine(step)
      if (text && Date.now() - shownAt >= LIVE_GAP_MS) {
        shownAt = Date.now()
        live(text)
      }
    }
  }
  const finish = (code: number | null, failure?: string) => {
    if (finished) return
    finished = true
    clearTimeout(timer)
    clearInterval(quiet)
    if (pending) take(pending)
    const why = failure ?? (code !== 0 ? tail(err, 160) || `退出码 ${code}` : undefined)
    done({ out: parser.answer(), failure: why })
  }

  const child = spawn(command, {
    shell: true,
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PATH: summonPath(),
      BENCH_URL: roomUrl(),
      BENCH_AGENT: agent.agentName,
      BENCH_UUID: agent.session,
      BENCH_SESSION: agent.session,
    },
  })
  const timer = setTimeout(() => {
    child.kill("SIGTERM")
    finish(null, "超过 15 分钟没结束，已停掉")
  }, RUN_LIMIT_MS)
  let quiet: NodeJS.Timeout | undefined
  if (streams(command)) {
    const since = Date.now()
    quiet = setInterval(() => {
      const waited = `还没开始回应，已等 ${seconds(Date.now() - since)}（多半是它的服务在排队）`
      putStep(run, { id: "wait", at: since, kind: "note", title: waited, state: "running" })
      live(waited)
    }, WAIT_NOTE_MS)
  }
  child.stdout.on("data", (chunk: Buffer) => {
    if (quiet) {
      clearInterval(quiet)
      quiet = undefined
      if (run.steps.some((step) => step.id === "wait")) {
        putStep(run, { id: "wait", at: run.startedAt, kind: "note", title: `等了 ${seconds(Date.now() - run.startedAt)} 才开始回应`, state: "done" })
      }
    }
    if (size > OUT_LIMIT * 16) return
    size += chunk.length
    const lines = (pending + chunk.toString("utf8")).split("\n")
    pending = lines.pop() ?? ""
    for (const line of lines) take(line)
  })
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
  if (queue.summary) {
    queue.summary = false
    writeSummary(agent, adapter)
    return
  }
  if (queue.pending.length === 0) return

  const seen = catchUp(agentId, CATCH_UP_CHARS)
  // Its inbox may already have shown it the mention; fall back to the queue.
  const body = seen.text || queue.pending.join("\n\n")
  const command = commandFor(
    agent.agentName,
    agent.session,
    envelope(body, seen.skipped, seen.summary, adapter.reply === "stdout"),
  )
  const hop = queue.hops
  queue.pending = []
  queue.hops = 0
  if (!command) return

  queue.running = true
  const log = startRun(agentId, agent.name, "reply")
  const seat = busy(agentId, "被点到了，正在回复")
  launch(agent, command, log, seat.live, ({ out, failure }) => {
    queue.running = false
    const still = agentState(agentId)
    if (failure) {
      postSystem(`唤起 ${agent.name} 没成功：${failure}`)
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
  const log = startRun(agent.id, agent.name, "summary")
  const seat = busy(agent.id, "在写房间摘要")
  launch(agent, command, log, seat.live, ({ out, failure }) => {
    queue.running = false
    endRun(log, failure ? "failed" : "done", failure ? `没成功：${failure}` : undefined)
    seat.settle()
    endSummaryJob(agent.id)
    if (failure) {
      postSystem(`请 ${agent.name} 写摘要没成功：${failure}`)
    } else if (byStdout) {
      try {
        saveSummary(out, agent.name, prompt.upToSeq)
      } catch {
        postSystem(`${agent.name} 没写出摘要`)
      }
    } else if ((snapshot().summary?.at ?? 0) < asked) {
      postSystem(`${agent.name} 这一轮没交摘要`)
    }
    run(agent.id)
  })
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
    queue.pending.push(`${message.authorName}：${message.text}`)
    queue.hops = Math.max(queue.hops, hop)
    run(agent.id)
  }
}

export function ensureSummon() {
  g().__benchSummonHandler = wake
  if (g().__benchSummonBound) return
  g().__benchSummonBound = true
  // Deferred so a reply posted from stdout has its hop count recorded first.
  onMessage((message) => setImmediate(() => g().__benchSummonHandler?.(message)))
}
