import { spawn } from "node:child_process"

import { adapterFor, commandFor, summonPath } from "@/lib/adapters"
import { agentState, onMessage, postSystem, pulseAgent, sayAs, summonCandidates } from "@/lib/store"
import type { Message } from "@/lib/types"

const NOTE_GAP_MS = 30_000
const RUN_LIMIT_MS = 15 * 60_000
const OUT_LIMIT = 64_000
// Agents answering agents can bounce forever. Stop the relay after this many
// automatic hops and wait for a human message.
const MAX_HOPS = 3

// One queue per seat. A seat runs one command at a time; messages that land
// while it runs are batched into the next run instead of being dropped.
type Lane = { running: boolean; pending: string[]; hops: number }

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

function envelope(lines: string[], replyByStdout: boolean) {
  const how = replyByStdout
    ? "直接回答就行，你这次的输出会作为你的发言贴回房间，不用再调用 bench_say。"
    : `回复请发回房间：有 bench_say 工具就用它（上下文用 bench_inbox）；没有的话 POST ${roomUrl()}/api/v1/say，带你入座时的 agentId 和 token。`
  return `【并坐房间转来的消息】\n${lines.join("\n\n")}\n\n（${how}）`
}

function tail(text: string, max: number) {
  const clean = text.trim().replace(/\s+/g, " ")
  return clean.length > max ? `…${clean.slice(-max)}` : clean
}

function run(agentId: string) {
  const queue = lane(agentId)
  if (queue.running || queue.pending.length === 0) return
  const agent = agentState(agentId)
  if (!agent || !agent.agentName || !agent.session) {
    queue.pending = []
    return
  }
  const adapter = adapterFor(agent.agentName)
  const command = adapter
    ? commandFor(agent.agentName, agent.session, envelope(queue.pending, adapter.reply === "stdout"))
    : null
  const hop = queue.hops
  queue.pending = []
  queue.hops = 0
  if (!adapter || !command) return

  queue.running = true
  const before = agent.doing
  try {
    pulseAgent(agent.id, "working", "被点到了，正在回复")
  } catch {}

  let out = ""
  let err = ""
  let finished = false
  const finish = (code: number | null, failure?: string) => {
    if (finished) return
    finished = true
    clearTimeout(timer)
    queue.running = false
    const still = agentState(agentId)
    if (still && still.doing === "被点到了，正在回复") {
      try {
        pulseAgent(still.id, "idle", before)
      } catch {}
    }
    if (failure || code !== 0) {
      const why = failure ?? (tail(err, 160) || `退出码 ${code}`)
      postSystem(`唤起 ${agent.name} 没成功：${why}`)
    } else if (adapter.reply === "stdout" && still) {
      const text = out.trim()
      if (text) {
        try {
          const said = sayAs(
            { type: "agent", id: still.id, name: still.name },
            { text: text.slice(0, 4000) },
          )
          hops().set(said.message.id, hop + 1)
          if (hops().size > 500) hops().delete(hops().keys().next().value ?? "")
        } catch (error) {
          console.error(error)
        }
      }
    }
    run(agentId)
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
  child.stdout.on("data", (chunk: Buffer) => {
    if (out.length < OUT_LIMIT) out += chunk.toString("utf8")
  })
  child.stderr.on("data", (chunk: Buffer) => {
    err = (err + chunk.toString("utf8")).slice(-4000)
  })
  child.on("error", (error) => finish(null, error.message))
  child.on("close", (code) => finish(code))
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
