#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

const origin = (process.env.BENCH_URL || "http://127.0.0.1:43123").replace(/\/$/, "")
const dir = path.join(process.cwd(), ".bench")
const seatFile = path.join(dir, "seat.json")
const cursorFile = path.join(dir, "cursor.txt")

function readSeat() {
  try {
    return JSON.parse(readFileSync(seatFile, "utf8"))
  } catch {
    console.error("还没有入座。先运行：node scripts/bench.mjs join --name 名字 --model 模型 --role 分工")
    process.exit(1)
  }
}

function writeSeat(seat) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(seatFile, JSON.stringify(seat, null, 2))
}

function readCursor() {
  try {
    return Number(readFileSync(cursorFile, "utf8")) || 0
  } catch {
    return 0
  }
}

function writeCursor(seq) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(cursorFile, String(seq))
}

async function request(pathname, { method = "GET", body } = {}) {
  const res = await fetch(`${origin}${pathname}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(data.error || `${method} ${pathname} 失败（${res.status}）`)
  }
  return data
}

function flag(args, name) {
  const index = args.indexOf(`--${name}`)
  if (index === -1) return undefined
  return args[index + 1]
}

function help() {
  console.log(`并坐命令，房间地址 ${origin}

  node scripts/bench.mjs join --name 阿构 --model composer --role 实现 --strengths 界面,交互
  node scripts/bench.mjs session --agent codex --uuid THREAD_ID
  node scripts/bench.mjs pulse --status working --doing "在改导航"
  node scripts/bench.mjs say 导航好了 @阿证
  node scripts/bench.mjs inbox
  node scripts/bench.mjs room
  node scripts/bench.mjs task --title "导航空状态" --owner 阿证
  node scripts/bench.mjs handoff --task t_xxx --to 阿证 --note "请看窄屏"
  node scripts/bench.mjs done --task t_xxx
  node scripts/bench.mjs block --task t_xxx --note "缺接口"
  node scripts/bench.mjs leave
  node scripts/bench.mjs prompt
  node scripts/bench.mjs seat
  node scripts/bench.mjs dismiss

凭证写在当前目录的 .bench/seat.json。BENCH_URL 可改房间地址。`)
}

const [command, ...args] = process.argv.slice(2)

try {
  if (!command || command === "help" || command === "--help") {
    help()
  } else if (command === "prompt") {
    const data = await request("/api/v1/prompt")
    console.log(data.prompt)
  } else if (command === "join") {
    const name = flag(args, "name")
    if (!name) throw new Error("join 需要 --name")
    const strengths = (flag(args, "strengths") || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
    const data = await request("/api/v1/join", {
      method: "POST",
      body: {
        name,
        model: flag(args, "model") || "未填模型",
        role: flag(args, "role") || "未分工",
        strengths,
      },
    })
    writeSeat({
      agentId: data.agent.id,
      token: data.token,
      name: data.agent.name,
      origin,
    })
    console.log(`${data.agent.name} 已入座 ${data.agent.id}`)
  } else if (command === "session") {
    const seat = readSeat()
    const agentName = flag(args, "agent") || flag(args, "agentName")
    const uuid = flag(args, "uuid") || flag(args, "session")
    if (!agentName || !uuid) throw new Error("session 需要 --agent codex --uuid THREAD_ID，或 --agent dsh --uuid SESSION_ID")
    const data = await request("/api/v1/session", {
      method: "POST",
      body: { agentId: seat.agentId, token: seat.token, agentName, uuid },
    })
    console.log(`${data.agent.name} 已报 ${data.agent.agentName}`)
  } else if (command === "pulse") {
    const seat = readSeat()
    const data = await request("/api/v1/pulse", {
      method: "POST",
      body: {
        agentId: seat.agentId,
        token: seat.token,
        status: flag(args, "status") || "working",
        doing: flag(args, "doing") || "",
      },
    })
    console.log(`${data.agent.name}：${data.agent.status} ${data.agent.doing}`)
  } else if (command === "say") {
    const seat = readSeat()
    const text = flag(args, "text") || args.filter((arg) => !arg.startsWith("--")).join(" ")
    if (!text) throw new Error("say 需要一句话")
    const data = await request("/api/v1/say", {
      method: "POST",
      body: { agentId: seat.agentId, token: seat.token, text },
    })
    console.log(data.message.id)
  } else if (command === "inbox") {
    const seat = readSeat()
    const data = await request("/api/v1/inbox", {
      method: "POST",
      body: { agentId: seat.agentId, token: seat.token, after: readCursor() },
    })
    writeCursor(data.seq)
    console.log(JSON.stringify({ you: data.you, peers: data.peers, forYou: data.forYou, tasks: data.tasks, seq: data.seq, hasMore: data.hasMore }, null, 2))
  } else if (command === "room") {
    console.log(JSON.stringify(await request("/api/v1/room"), null, 2))
  } else if (command === "task") {
    const seat = readSeat()
    const title = flag(args, "title")
    if (!title) throw new Error("task 需要 --title")
    const data = await request("/api/v1/tasks", {
      method: "POST",
      body: {
        agentId: seat.agentId,
        token: seat.token,
        title,
        detail: flag(args, "detail") || "",
        owner: flag(args, "owner"),
      },
    })
    console.log(data.task.id)
  } else if (command === "handoff" || command === "done" || command === "block") {
    const seat = readSeat()
    const task = flag(args, "task")
    if (!task) throw new Error(`${command} 需要 --task`)
    const data = await request(`/api/v1/tasks/${task}`, {
      method: "POST",
      body: {
        agentId: seat.agentId,
        token: seat.token,
        action: command === "handoff" ? "handoff" : command,
        to: flag(args, "to"),
        note: flag(args, "note") || "",
      },
    })
    console.log(`${data.task.title} → ${data.task.status} ${data.task.ownerName ?? ""}`)
  } else if (command === "leave") {
    const seat = readSeat()
    await request("/api/v1/leave", {
      method: "POST",
      body: { agentId: seat.agentId, token: seat.token },
    })
    console.log(`${seat.name} 已离席`)
  } else if (command === "seat" || command === "dismiss") {
    const data = await request("/api/v1/demo", {
      method: "POST",
      body: { action: command === "seat" ? "seat" : "dismiss" },
    })
    console.log(command === "seat" ? `入座 ${data.created?.join("、") || "（已在）"}` : "演示已离席")
  } else {
    help()
    process.exit(1)
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
}
