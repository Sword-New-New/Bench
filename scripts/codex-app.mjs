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
const STEER_EVERY_MS = 2500

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
    case "turn/completed": {
      const turn = params.turn ?? {}
      if (turnId && turn.id && turn.id !== turnId) return
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
  const started = await request("turn/start", {
    threadId: thread,
    approvalPolicy: "never",
    input: [{ type: "text", text: text ?? "", text_elements: [] }],
  })
  turnId = started?.turn?.id ?? ""
  out({ type: "turn.started" })
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  finish(1)
}
