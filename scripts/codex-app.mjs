#!/usr/bin/env node
// Usage: codex-app.mjs <thread-id> <text>
// One turn of a Codex session, run through `codex app-server` instead of
// `codex exec`, so that what calls the seat while it works reaches it in the
// same turn: every few seconds the room is asked (by BENCH_RUN_KEY, see
// lib/summon.ts takeQueued) and anything new goes in with `turn/steer`, the
// way typing into Codex's own window while it works does. Its events are
// printed as `codex exec --json` lines, which the room already reads.

import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { createInterface } from "node:readline"

const [thread, text] = process.argv.slice(2)
if (!thread || !/^[A-Za-z0-9._-]+$/.test(thread)) {
  console.error(`thread id 不对：${thread ?? ""}`)
  process.exit(2)
}
const room = (process.env.BENCH_URL || "http://127.0.0.1:4399").replace(/\/$/, "")
const key = process.env.BENCH_RUN_KEY
// The model the user picked for this seat in the room, if any.
const model = process.env.BENCH_MODEL || undefined
// And how hard it thinks (minimal … xhigh), if picked.
const effort = process.env.BENCH_EFFORT || undefined
// Where its context compacts by itself, if the user set one (lib/context.ts).
const compactAt = /^\d+$/.test(process.env.BENCH_COMPACT_WINDOW ?? "") ? process.env.BENCH_COMPACT_WINDOW : undefined
const STEER_EVERY_MS = 2500
// "/compact" from the room (lib/summon.ts compactSession) isn't a message:
// it asks the thread to compact its context instead of starting a turn.
const compacting = text === "/compact"
// "/goal <objective>" and "/goal clear" (lib/summon.ts setGoal): the thread's
// goal. Once one is set Codex starts a turn on it by itself, and may start
// more after it until the goal is met, so those turns are followed here.
const goal = /^\/goal(\s|$)/.test(text ?? "") ? text.slice(5).trim() : null
const clearing = goal !== null && /^(clear|清除|清掉)$/i.test(goal)
// After a goal's turn ends, how long to wait for Codex to start the next one.
const GOAL_NEXT_MS = 8000
let goalNext = null

function codexBin() {
  if (process.env.CODEX_BIN && existsSync(process.env.CODEX_BIN)) return process.env.CODEX_BIN
  for (const dir of (process.env.PATH || "").split(":")) if (dir && existsSync(`${dir}/codex`)) return `${dir}/codex`
  return "/usr/lib/chatgpt/resources/codex"
}

const out = (event) => process.stdout.write(`${JSON.stringify(event)}\n`)

// Same as codex-wake.sh: the bench bridge is told the thread id, and its tools
// need no clicking since nobody is there.
const server = spawn(
  codexBin(),
  [
    "app-server",
    "-c",
    `mcp_servers.bench.env.BENCH_UUID="${thread}"`,
    "-c",
    'mcp_servers.bench.default_tools_approval_mode="approve"',
    ...(compactAt ? ["-c", `model_auto_compact_token_limit=${compactAt}`] : []),
  ],
  { stdio: ["pipe", "pipe", "inherit"] },
)

let nextId = 1
const waiting = new Map()
function request(method, params) {
  const id = nextId++
  server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`)
  return new Promise((resolve, reject) => waiting.set(id, { resolve, reject }))
}
function notify(method, params) {
  server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, ...(params ? { params } : {}) })}\n`)
}

let turnId = ""
let finished = false
let failed = false

function finish(code) {
  if (finished) return
  finished = true
  clearTimeout(goalNext)
  clearInterval(steerTimer)
  try {
    server.kill("SIGTERM")
  } catch {}
  setTimeout(() => process.exit(code), 50)
}

// app-server items → `codex exec --json` items (lib/events.ts reads these).
function execItem(item) {
  switch (item?.type) {
    case "agentMessage":
      return { id: item.id, type: "agent_message", text: item.text ?? "" }
    case "commandExecution":
      return {
        id: item.id,
        type: "command_execution",
        command: item.command ?? "",
        exit_code: item.exitCode ?? null,
        aggregated_output: item.aggregatedOutput ?? "",
      }
    case "mcpToolCall":
      return {
        id: item.id,
        type: "mcp_tool_call",
        server: item.server,
        tool: item.tool,
        arguments: item.arguments,
        result: item.result,
        error: item.error,
      }
    case "fileChange":
      return { id: item.id, type: "file_change", changes: item.changes ?? [] }
    case "webSearch":
      return { id: item.id, type: "web_search", query: item.query ?? "" }
    default:
      return null
  }
}

function onMessage(message) {
  if (message.id !== undefined && waiting.has(message.id) && !message.method) {
    const { resolve, reject } = waiting.get(message.id)
    waiting.delete(message.id)
    if (message.error) reject(new Error(message.error.message || JSON.stringify(message.error)))
    else resolve(message.result)
    return
  }
  // A request from the server (an approval it wants): nobody is here to
  // click, and the turn runs with approvals off, so decline anything asked.
  if (message.id !== undefined && message.method) {
    server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { decision: "decline" } })}\n`)
    return
  }
  const params = message.params ?? {}
  switch (message.method) {
    case "item/started":
    case "item/completed": {
      const item = execItem(params.item)
      if (item) out({ type: message.method === "item/started" ? "item.started" : "item.completed", item })
      return
    }
    case "turn/started":
      // Codex starts the turns a goal runs in; the room didn't ask for them.
      if (goal !== null && params.turn?.id) {
        clearTimeout(goalNext)
        turnId = params.turn.id
      }
      return
    case "turn/completed": {
      const turn = params.turn ?? {}
      if (turnId && turn.id && turn.id !== turnId) return
      if (goal !== null && !(turn.status === "failed" || turn.error)) {
        // It may go on with the goal in another turn: end only once it doesn't.
        clearTimeout(goalNext)
        goalNext = setTimeout(() => {
          out({ type: "turn.completed", usage: {} })
          finish(0)
        }, GOAL_NEXT_MS)
        return
      }
      if (turn.status === "failed" || turn.error) {
        failed = true
        out({ type: "turn.failed", error: { message: turn.error?.message ?? "这一轮失败了" } })
        console.error(turn.error?.message ?? "这一轮失败了")
      } else {
        out({ type: "turn.completed", usage: {} })
      }
      finish(failed ? 1 : 0)
      return
    }
    case "thread/compacted":
      if (compacting) {
        out({ type: "item.completed", item: { id: "compact", type: "agent_message", text: "上下文压缩好了" } })
        out({ type: "turn.completed", usage: {} })
        finish(0)
      }
      return
    case "error":
      out({ type: "error", message: params.error?.message ?? params.message ?? "出错了" })
      return
    default:
  }
}

createInterface({ input: server.stdout }).on("line", (line) => {
  if (!line.trim()) return
  try {
    onMessage(JSON.parse(line))
  } catch {}
})
server.on("exit", (code) => {
  if (!finished) {
    console.error(`codex app-server 退出了（${code}）`)
    finish(code || 1)
  }
})
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => finish(143))

// Messages that called the seat since the turn began go into the turn.
let steering = false
async function steer() {
  if (!key || !turnId || steering || finished) return
  steering = true
  try {
    const res = await fetch(`${room}/api/v1/queue`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key }),
      signal: AbortSignal.timeout(3000),
    })
    const data = res.ok ? await res.json() : {}
    if (data.text) {
      await request("turn/steer", {
        threadId: thread,
        expectedTurnId: turnId,
        input: [{ type: "text", text: data.text, text_elements: [] }],
      })
    }
  } catch {
  } finally {
    steering = false
  }
}
const steerTimer = setInterval(() => void steer(), STEER_EVERY_MS)

try {
  await request("initialize", { clientInfo: { name: "bench", title: "并坐", version: "1" } })
  notify("initialized")
  await request("thread/resume", { threadId: thread, approvalPolicy: "never" })
  out({ type: "thread.started", thread_id: thread })
  if (compacting) {
    await request("thread/compact/start", { threadId: thread })
    out({ type: "turn.started" })
  } else if (clearing) {
    const result = await request("thread/goal/clear", { threadId: thread, origin: "user" })
    out({ type: "item.completed", item: { id: "goal", type: "agent_message", text: result?.cleared ? "目标清掉了" : "本来就没有目标" } })
    out({ type: "turn.completed", usage: {} })
    finish(0)
  } else if (goal !== null) {
    if (!goal) throw new Error("/goal 后面要写目标，或者 clear")
    await request("thread/goal/set", {
      threadId: thread,
      objective: goal,
      status: "active",
      origin: "user",
    })
    out({ type: "item.completed", item: { id: "goal", type: "agent_message", text: `Goal set: ${goal}` } })
    out({ type: "turn.started" })
    // Set but no turn came (the goal was already met, say): nothing to follow.
    // Its first turn may have started before this reply came back.
    if (!turnId) goalNext = setTimeout(() => {
      out({ type: "turn.completed", usage: {} })
      finish(0)
    }, GOAL_NEXT_MS * 2)
  } else {
    const started = await request("turn/start", {
      threadId: thread,
      approvalPolicy: "never",
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      input: [{ type: "text", text: text ?? "", text_elements: [] }],
    })
    turnId = started?.turn?.id ?? ""
    out({ type: "turn.started" })
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  finish(1)
}
