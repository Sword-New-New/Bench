#!/usr/bin/env node
// Usage: codex-app.mjs <thread-id> <text>
// One turn of a Codex session, run through `codex app-server` instead of
// `codex exec`, so that what calls the seat while it works reaches it in the
// same turn: every few seconds the room is asked (by BENCH_RUN_KEY, see
// lib/summon.ts takeQueued) and anything new goes in with `turn/steer`, the
// way typing into Codex's own window while it works does. Its events are
// printed as `codex exec --json` lines, which the room already reads.

import { spawn } from "node:child_process"
import { readFileSync } from "node:fs"
import { createInterface } from "node:readline"
import { findCodex } from "./codex-bin.mjs"

const [thread, rawText] = process.argv.slice(2)
const text =
  process.env.BENCH_PROMPT_FILE
    ? readFileSync(process.env.BENCH_PROMPT_FILE, "utf8")
    : process.env.BENCH_TEXT_STDIN === "1"
      ? readFileSync(0, "utf8")
      : rawText
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

const out = (event) => process.stdout.write(`${JSON.stringify(event)}\n`)

const bin = findCodex()
if (!bin) {
  console.error("没找到 codex，先装 Codex 的命令行或桌面端")
  process.exit(127)
}

// Same as codex-wake.sh: the bench bridge is told the thread id, and its tools
// need no clicking since nobody is there.
const serverArgs = [
  "app-server",
  "-c",
  `mcp_servers.bench.env.BENCH_UUID="${thread}"`,
  "-c",
  'mcp_servers.bench.default_tools_approval_mode="approve"',
  ...(compactAt ? ["-c", `model_auto_compact_token_limit=${compactAt}`] : []),
]
const server =
  process.platform === "win32" && /\.(cmd|bat)$/i.test(bin)
    ? spawn(process.env.ComSpec || "cmd.exe", ["/d", "/c", bin, ...serverArgs], { stdio: ["pipe", "pipe", "inherit"], windowsHide: true })
    : /\.(m?js|cjs)$/i.test(bin)
      ? spawn(process.execPath, [bin, ...serverArgs], { stdio: ["pipe", "pipe", "inherit"], windowsHide: true })
      : spawn(bin, serverArgs, { stdio: ["pipe", "pipe", "inherit"], windowsHide: true })

let nextId = 1
const waiting = new Map()
server.stdin.on("error", () => {})
function request(method, params) {
  if (server.stdin.destroyed || server.killed) return Promise.reject(new Error("codex app-server 标准输入已关闭"))
  const id = nextId++
  try {
    server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`)
  } catch (err) {
    return Promise.reject(err instanceof Error ? err : new Error(String(err)))
  }
  return new Promise((resolve, reject) => waiting.set(id, { resolve, reject }))
}
function notify(method, params) {
  if (server.stdin.destroyed || server.killed) return
  try {
    server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, ...(params ? { params } : {}) })}\n`)
  } catch {}
}

function errorText(err, fallback = "这一轮失败了") {
  if (!err) return fallback
  if (typeof err === "string") return err.trim() || fallback
  const msg = typeof err.message === "string" ? err.message.trim() : ""
  const details = typeof err.additionalDetails === "string" ? err.additionalDetails.trim() : ""
  const code = typeof err.codexErrorInfo === "string" ? err.codexErrorInfo.trim() : ""
  if (msg && details && !msg.includes(details)) return `${msg} (${details})`
  if (msg && code && !msg.toLowerCase().includes(code.toLowerCase())) return `${msg} (${code})`
  return msg || details || fallback
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
  // A request from the server (an approval it wants): asked on the room's
  // page as a permission card, the way a woken Claude Code turn is.
  if (message.id !== undefined && message.method) {
    void answer(message)
    return
  }
  const params = message.params ?? {}
  switch (message.method) {
    case "item/started":
    case "item/completed": {
      // The files a change touches, for when it asks to write them.
      if (params.item?.type === "fileChange") filesOf.set(params.item.id, (params.item.changes ?? []).map((change) => change.path).filter(Boolean))
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
        const msg = errorText(turn.error, "这一轮失败了")
        out({ type: "turn.failed", error: { message: msg } })
        console.error(msg)
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
    case "error": {
      const msg = errorText(params.error, typeof params.message === "string" ? params.message : "出错了")
      const retry = params.willRetry === true || /^(?:Reconnecting|Retrying)\b/i.test(msg)
      out({ type: "error", message: msg, ...(retry ? { retry: true } : {}) })
      return
    }
    default:
  }
}

// ---- Permissions -------------------------------------------------------
// The room says how much the seat may do (lib/permits.ts): with full
// permission the turn runs without a sandbox and never asks; otherwise it
// may write in its workspace and asks for anything past that (another
// folder, the network, a command outside the sandbox). Codex sends those as
// requests; each becomes a card on the page and waits for the user. With no
// room to ask (no BENCH_RUN_KEY), nothing can be asked: it stays in the
// workspace and what needs more is refused.
const filesOf = new Map()
const ASK_WAIT_MS = 11 * 60_000

async function roomPermit(body, timeoutMs) {
  const res = await fetch(`${room}/api/v1/permit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key, ...body }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `房间回了 ${res.status}`)
  return data
}

async function fullNow() {
  if (!key) return false
  try {
    return (await roomPermit({ action: "mode" }, 5000)).full === true
  } catch {
    return false
  }
}

// One question on the page. { allow, full }: full means the user gave the
// seat full permission, so what it asks for the rest of the session goes.
async function askRoom(tool, text) {
  if (!key) return { allow: false }
  try {
    const data = await roomPermit({ action: "tool", tool, input: { command: text } }, ASK_WAIT_MS)
    return { allow: data.allow === true, full: data.full === true }
  } catch {
    return { allow: false }
  }
}

const withWhy = (text, why) => (why ? `${text}\n（${why}）` : text)
const listFiles = (paths) => (paths.length ? paths.join("\n") : "（没说哪些文件）")

function permissionsText(want) {
  const lines = []
  const fs = want?.fileSystem
  for (const entry of fs?.entries ?? []) {
    const where = entry.path?.path ?? entry.path?.pattern ?? entry.path?.value ?? JSON.stringify(entry.path)
    lines.push(`${entry.access === "write" ? "写" : entry.access === "read" ? "读" : entry.access} ${where}`)
  }
  for (const where of fs?.write ?? []) lines.push(`写 ${where}`)
  for (const where of fs?.read ?? []) lines.push(`读 ${where}`)
  if (want?.network?.enabled) lines.push("联网")
  return lines.join("\n") || JSON.stringify(want ?? {})
}

async function answer(message) {
  const p = message.params ?? {}
  const reply = (result) => server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`)
  try {
    switch (message.method) {
      case "item/commandExecution/requestApproval": {
        const host = p.networkApprovalContext?.host
        const what = p.command || (host ? `联网：${host}` : "（一条命令）")
        const decision = await askRoom(host && !p.command ? "网络" : "终端", withWhy(what, p.reason))
        return reply({ decision: decision.allow ? (decision.full ? "acceptForSession" : "accept") : "decline" })
      }
      case "item/fileChange/requestApproval": {
        const where = p.grantRoot ? `${p.grantRoot} 下的文件` : listFiles(filesOf.get(p.itemId) ?? [])
        const decision = await askRoom("文件编辑", withWhy(where, p.reason))
        return reply({ decision: decision.allow ? (decision.full ? "acceptForSession" : "accept") : "decline" })
      }
      case "item/permissions/requestApproval": {
        const decision = await askRoom("额外权限", withWhy(permissionsText(p.permissions), p.reason))
        return reply(
          decision.allow
            ? { permissions: p.permissions ?? {}, scope: decision.full ? "session" : "turn" }
            : { permissions: {}, scope: "turn" },
        )
      }
      // The older shapes of the same two questions.
      case "execCommandApproval": {
        const decision = await askRoom("终端", withWhy((p.command ?? []).join(" "), p.reason))
        return reply({ decision: decision.allow ? (decision.full ? "approved_for_session" : "approved") : "denied" })
      }
      case "applyPatchApproval": {
        const decision = await askRoom("文件编辑", withWhy(listFiles(Object.keys(p.fileChanges ?? {})), p.reason))
        return reply({ decision: decision.allow ? (decision.full ? "approved_for_session" : "approved") : "denied" })
      }
      // The bench tools are approved up front; another server's form has nobody to fill it.
      case "mcpServer/elicitation/request":
        return reply({ action: "decline" })
      case "item/tool/requestUserInput":
        return reply({ answers: {} })
      default:
        server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "并坐里没人能回答这个" } })}\n`)
    }
  } catch (error) {
    server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: String(error) } })}\n`)
  }
}

createInterface({ input: server.stdout }).on("line", (line) => {
  if (!line.trim()) return
  try {
    onMessage(JSON.parse(line))
  } catch {}
})
server.on("error", (error) => {
  if (!finished) {
    const msg = `起不来 codex：${error instanceof Error ? error.message : String(error)}`
    out({ type: "turn.failed", error: { message: msg } })
    console.error(msg)
    finish(1)
  }
})
server.on("exit", (code) => {
  if (!finished) {
    for (const { reject } of waiting.values()) reject(new Error(`codex app-server 退出了（${code}）`))
    waiting.clear()
    const msg = `codex app-server 退出了（${code}）`
    if (!failed && code !== 0) out({ type: "turn.failed", error: { message: msg } })
    console.error(msg)
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
  // Asked once per wake; granting full later lets what it asks through.
  const full = await fullNow()
  const policy = full ? "never" : key ? "on-request" : "never"
  const sandboxPolicy = full ? { type: "dangerFullAccess" } : { type: "workspaceWrite" }
  await request("thread/resume", {
    threadId: thread,
    approvalPolicy: policy,
    approvalsReviewer: "user",
    sandbox: full ? "danger-full-access" : "workspace-write",
  })
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
      approvalPolicy: policy,
      approvalsReviewer: "user",
      sandboxPolicy,
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      input: [{ type: "text", text: text ?? "", text_elements: [] }],
    })
    turnId = started?.turn?.id ?? ""
    out({ type: "turn.started" })
  }
} catch (error) {
  const msg = error instanceof Error ? error.message : String(error)
  out({ type: "turn.failed", error: { message: msg } })
  console.error(msg)
  finish(1)
}
