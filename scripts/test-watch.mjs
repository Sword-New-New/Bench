#!/usr/bin/env node
// End-to-end + in-process verification for watched projects & direct coordinator nudge (t_0fefb44c).
// Runs:
//   1) Against a live isolated copy server when BENCH_URL & BENCH_KEY_FILE are set (never on :4399):
//      verifies HTTP `/api/v1/watch`, `/api/v1/relay`, `/api/v1/overview`, `/api/v1/peek` and real
//      `scripts/bench-mcp.mjs` stdio tools (`bench_watch` + `bench_nudge`).
//   2) In-process against an isolated temp dataDir with fake client scripts:
//      verifies patrol `sweep(false, virtualNow)` when active-reminder toggle is OFF, 10m idle gate,
//      quota/user-stop/queue-pause guards, one report per quiet stretch, a wake open but quiet 30m counted
//      as stopped, direct coordinator wake & non-human signature,
//      30m direct-nudge cooldown, auto-unwatch on all tasks handed over ("<项目> 的活都交了，在等用户"),
//      and 24h expiry.

import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

const origin = process.env.BENCH_URL || ""
const keyFile = process.env.BENCH_KEY_FILE || ""
if (origin && /:4399\b/.test(origin)) {
  console.error("禁止在正式房间 4399 上运行 test-watch.mjs")
  process.exit(2)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const stamp = Date.now().toString(36)

async function runHttpAndMcpPart() {
  if (!origin || !keyFile || !existsSync(keyFile)) return
  const humanKey = readFileSync(keyFile, "utf8").trim()

  const req = async (pathname, { proj = "", body, method = body ? "POST" : "GET" } = {}) => {
    const url = proj && method === "GET" ? `${origin}${pathname}?project=${encodeURIComponent(proj)}` : `${origin}${pathname}`
    const headers = body ? { "content-type": "application/json" } : {}
    if (body?.as === "human") headers["x-bench-human"] = humanKey
    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(proj ? { project: proj, ...body } : body) : undefined,
    })
    const raw = await res.text()
    let data = {}
    try {
      data = JSON.parse(raw)
    } catch {}
    return { status: res.status, data, raw }
  }

  const mcpRoot = mkdtempSync(path.join(os.tmpdir(), `bench-watch-mcp-${stamp}-`))
  const fakeCoordLog = path.join(mcpRoot, "coord-wake.jsonl")
  const fakeCoordScript = path.join(mcpRoot, "fake-coord.mjs")
  writeFileSync(
    fakeCoordScript,
    [
      `import { appendFileSync } from "node:fs"`,
      `appendFileSync(${JSON.stringify(fakeCoordLog)}, JSON.stringify({ uuid: process.argv[2] || "", prompt: process.argv[3] || "" }) + "\\n", "utf8")`,
      `console.log("【本轮结束】统筹已收到前台催促")`,
    ].join("\n"),
    "utf8",
  )

  const mcpProcs = []
  const startMcp = (uuidTag) => {
    const child = spawn(process.execPath, ["scripts/bench-mcp.mjs", "--agent", "claude"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        BENCH_URL: origin,
        XDG_STATE_HOME: mcpRoot,
        BENCH_UUID: uuidTag,
        CLAUDE_CODE_SESSION_ID: uuidTag,
      },
      stdio: ["pipe", "pipe", "pipe"],
    })
    mcpProcs.push(child)
    let seqId = 1
    const pending = new Map()
    let buf = ""
    child.stdout.on("data", (chunk) => {
      buf += chunk.toString("utf8")
      let idx
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim()
        buf = buf.slice(idx + 1)
        if (!line) continue
        try {
          const msg = JSON.parse(line)
          if (msg.id !== undefined && pending.has(msg.id)) {
            const resolve = pending.get(msg.id)
            pending.delete(msg.id)
            resolve(msg)
          }
        } catch {}
      }
    })
    const rpc = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = seqId++
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`MCP ${method} 超时`))
        }, 15_000)
        pending.set(id, (msg) => {
          clearTimeout(timer)
          resolve(msg)
        })
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`)
      })
    return { child, rpc }
  }

  const beforeProjects = (await req("/api/v1/projects")).data.projects ?? []
  const hadFrontBefore = beforeProjects.some((p) => p.front === true)
  let createdFrontId = ""
  let createdFrontSeatId = ""
  let pWatchId = ""
  let pUnwatchedId = ""
  let savedAdapters = null

  try {
    const curAdapters = await req("/api/v1/adapters")
    assert.equal(curAdapters.status, 200, "读取 adapters 失败")
    savedAdapters = curAdapters.data.agents.map(({ name, command, reply }) => ({ name, command, reply }))
    const mockCoordKind = `mockwcoord_${stamp}`
    const saveAd = await req("/api/v1/adapters", {
      body: {
        as: "human",
        agents: [
          ...savedAdapters,
          { name: mockCoordKind, command: `node '${fakeCoordScript}' {uuid} {text}`, reply: "stdout" },
        ],
      },
    })
    assert.equal(saveAd.status, 200, `注册假统筹客户端失败：${saveAd.raw}`)

    const frontRes = await req("/api/v1/projects", { body: { as: "human", front: true } })
    assert.ok(frontRes.status === 200 || frontRes.status === 201, "获取前台项目失败")
    const frontId = frontRes.data.project.id
    if (!hadFrontBefore) createdFrontId = frontId

    const frontRoom = (await req("/api/v1/room", { proj: frontId })).data
    let frontSeat = frontRoom.agents?.find((a) => !a.demo)
    let frontToken = ""
    if (!frontSeat) {
      const fj = await req("/api/v1/join", {
        proj: frontId,
        body: { name: `前台值班${stamp}`.slice(0, 18), model: "mock", role: "前台", agentName: mockCoordKind, uuid: `f_${stamp}` },
      })
      assert.equal(fj.status, 201, `前台席位入座失败：${fj.raw}`)
      frontSeat = fj.data.agent
      frontToken = fj.data.token
      createdFrontSeatId = frontSeat.id
    } else {
      // Re-join with session to obtain token if a seat already existed in the copy
      throw new Error("隔离副本前台已有别的席位占座，请在干净测试上下文运行")
    }

    const p1 = await req("/api/v1/projects", { body: { as: "human", name: `盯防项目${stamp}` } })
    const p2 = await req("/api/v1/projects", { body: { as: "human", name: `未盯项目${stamp}` } })
    assert.equal(p1.status, 201)
    assert.equal(p2.status, 201)
    pWatchId = p1.data.project.id
    const pWatchName = p1.data.project.name
    pUnwatchedId = p2.data.project.id

    const coordJoin = await req("/api/v1/join", {
      proj: pWatchId,
      body: { name: "总调度", model: "mock", role: "统筹", agentName: mockCoordKind, uuid: `coord_${stamp}` },
    })
    const memberJoin = await req("/api/v1/join", {
      proj: pWatchId,
      body: { name: "组员甲", model: "mock", role: "开发", agentName: mockCoordKind, uuid: `mem_${stamp}` },
    })
    const unwatchedJoin = await req("/api/v1/join", {
      proj: pUnwatchedId,
      body: { name: "未盯统筹", model: "mock", role: "统筹", agentName: mockCoordKind, uuid: `unw_${stamp}` },
    })
    const coord = { id: coordJoin.data.agent.id, name: coordJoin.data.agent.name, token: coordJoin.data.token }
    const member = { id: memberJoin.data.agent.id, name: memberJoin.data.agent.name, token: memberJoin.data.token }
    const unwatchedSeat = { id: unwatchedJoin.data.agent.id, name: unwatchedJoin.data.agent.name, token: unwatchedJoin.data.token }

    // 1) Auth & permission checks on /api/v1/watch
    const unauth = await req("/api/v1/watch", { body: { project: pWatchId } })
    assert.equal(unauth.status, 401, "无凭证调 /api/v1/watch 应返 401")

    const crossProj = await req("/api/v1/watch", {
      body: { agentId: coord.id, token: coord.token, project: pUnwatchedId },
    })
    assert.equal(crossProj.status, 403, "普通席位不能给别的项目设盯防")

    const wrongSeat = await req("/api/v1/watch", {
      body: { agentId: coord.id, token: coord.token, seat: member.name },
    })
    assert.equal(wrongSeat.status, 403, "普通席位设盯防不能指定别人做统筹")

    // Coordinator sets watch for its own project, then turns it off
    const selfWatch = await req("/api/v1/watch", {
      body: { agentId: coord.id, token: coord.token },
    })
    assert.equal(selfWatch.status, 200)
    assert.equal(selfWatch.data.watching, true)
    assert.equal(selfWatch.data.watch.seatId, coord.id)

    const selfUnwatch = await req("/api/v1/watch", {
      body: { agentId: coord.id, token: coord.token, on: false },
    })
    assert.equal(selfUnwatch.status, 200)
    assert.equal(selfUnwatch.data.watching, false)

    // 2) Unwatched project: bench_nudge MUST stay a draft card and MUST NOT post into the target project!
    const unwMsgsBefore = (await req("/api/v1/room", { proj: pUnwatchedId })).data.messages.length
    const unwNudge = await req("/api/v1/relay", {
      body: {
        agentId: frontSeat.id,
        token: frontToken,
        kind: "nudge",
        project: pUnwatchedId,
        seat: unwatchedSeat.name,
        text: "未盯项目看看进度",
      },
    })
    assert.equal(unwNudge.status, 200)
    assert.equal(
      unwNudge.data.relay?.state,
      "draft",
      `没盯的项目调 bench_nudge 必须只出 draft 草稿卡片，实际 state=${unwNudge.data.relay?.state}`,
    )
    assert.ok(!unwNudge.data.direct, "没盯的项目绝不能直接发出")
    const unwMsgsAfter = (await req("/api/v1/room", { proj: pUnwatchedId })).data.messages.length
    assert.equal(unwMsgsAfter, unwMsgsBefore, "没盯的项目调 bench_nudge 后目标房间不该多出任何消息")

    // 3) Front desk sets watch via real MCP `bench_watch` tool, then nudges coordinator via MCP `bench_nudge`
    mkdirSync(path.join(mcpRoot, "bench-mcp"), { recursive: true })
    writeFileSync(
      path.join(mcpRoot, "bench-mcp", `claude-desk_watch_${stamp}.json`),
      JSON.stringify({ agentId: frontSeat.id, token: frontToken, name: frontSeat.name, project: frontId, cursor: 0 }),
    )
    const deskMcp = startMcp(`desk_watch_${stamp}`)
    await deskMcp.rpc("initialize", { protocolVersion: "2025-06-18" })
    const listedTools = (await deskMcp.rpc("tools/list", {})).result?.tools?.map((t) => t.name) ?? []
    assert.ok(listedTools.includes("bench_watch"), "MCP tools/list 必须包含 bench_watch")

    const mcpWatchOn = await deskMcp.rpc("tools/call", {
      name: "bench_watch",
      arguments: { project: pWatchName, seat: coord.name },
    })
    assert.ok(!mcpWatchOn.result?.isError, `前台调 bench_watch 失败：${JSON.stringify(mcpWatchOn)}`)
    assert.ok(mcpWatchOn.result.content[0].text.includes("总调度"), "bench_watch 返回文案应包含统筹名字")

    // Overview & peek reflect watch status
    const ov = await req("/api/v1/overview", { body: { agentId: frontSeat.id, token: frontToken } })
    assert.ok(ov.data.text.includes("盯防：统筹 总调度"), "bench_overview 应显示盯防统筹")

    // Non-coordinator in a watched project -> still draft card!
    const nonCoordNudge = await req("/api/v1/relay", {
      body: {
        agentId: frontSeat.id,
        token: frontToken,
        kind: "nudge",
        project: pWatchId,
        seat: member.name,
        text: "催普通成员应出卡片",
      },
    })
    assert.equal(nonCoordNudge.data.relay?.state, "draft", "盯着的项目里催非统筹席位仍须出草稿卡片")

    // `bench_relay` (carrying user's words) to coordinator in watched project -> still draft card!
    const relayToCoord = await req("/api/v1/relay", {
      body: {
        agentId: frontSeat.id,
        token: frontToken,
        kind: "relay",
        project: pWatchId,
        seat: coord.name,
        text: "用户原话转达仍须点确认",
      },
    })
    assert.equal(relayToCoord.data.relay?.state, "draft", "盯着的项目里 bench_relay 转达用户原话仍须出草稿卡片")

    // Direct `bench_nudge` to watched project's coordinator via MCP -> sent immediately under front-desk's name!
    const mcpNudgeCoord = await deskMcp.rpc("tools/call", {
      name: "bench_nudge",
      arguments: {
        project: pWatchName,
        seat: coord.name,
        text: "组员甲做完了，接着派下一步",
        why: "全停超过 10 分钟",
      },
    })
    assert.ok(!mcpNudgeCoord.result?.isError, `MCP bench_nudge 催统筹失败：${JSON.stringify(mcpNudgeCoord)}`)
    assert.ok(mcpNudgeCoord.result.content[0].text.includes("以前台名义直接发进"), "MCP 返回应写明以前台名义直接发出")

    const watchRoomSnap = (await req("/api/v1/room", { proj: pWatchId })).data
    const directMsg = watchRoomSnap.messages.find((m) => m.text.includes("组员甲做完了，接着派下一步"))
    assert.ok(directMsg, "目标项目里应直接收到前台发出的消息")
    assert.notEqual(directMsg.authorId, "human", "直接发出的消息 authorId 绝不能是 human（严禁冒充用户）")
    assert.equal(directMsg.authorId, "front", "直接发出的消息 authorId 应是 front")
    assert.equal(directMsg.authorName, "前台", "直接发出的消息署名应是「前台」")
    assert.ok(
      directMsg.text.startsWith(`@${coord.name} 前台来看了一眼：`) && !directMsg.text.includes("经前台"),
      `直接发出正文格式错误或误带用户转达标记：${directMsg.text}`,
    )

    // Wait for fake coordinator process to wake and verify it does NOT see the human's name as author
    for (let i = 0; i < 40; i++) {
      if (existsSync(fakeCoordLog)) break
      await sleep(100)
    }
    assert.ok(existsSync(fakeCoordLog), "统筹席位应被直接唤起")
    const coordWakePrompt = readFileSync(fakeCoordLog, "utf8")
    assert.ok(
      coordWakePrompt.includes("前台：@总调度 前台来看了一眼：组员甲做完了，接着派下一步"),
      `统筹收到的提示词中发言人应为「前台」而非用户：${coordWakePrompt}`,
    )

    // Front desk chat keeps a `state: "sent"` record card
    const frontMsgs = (await req("/api/v1/room", { proj: frontId })).data.messages
    const sentCard = frontMsgs.find((m) => m.relay?.kind === "nudge" && m.relay?.sentId === directMsg.id)
    assert.ok(sentCard && sentCard.relay.state === "sent", "前台聊天里应留一条状态为「已发出（sent）」的记录卡片")

    // Second direct nudge within 30 minutes -> rejected with 429!
    const secondNudge = await req("/api/v1/relay", {
      body: {
        agentId: frontSeat.id,
        token: frontToken,
        kind: "nudge",
        project: pWatchId,
        seat: coord.name,
        text: "三十分钟内第二次催",
      },
    })
    assert.equal(secondNudge.status, 429, `同一项目 30 分钟内第二次直接发应返 429，实际 ${secondNudge.status}`)

    await req("/api/v1/watch", {
      body: { agentId: frontSeat.id, token: frontToken, project: pWatchId, on: false },
    })
  } finally {
    for (const p of mcpProcs) {
      try {
        p.kill("SIGTERM")
      } catch {}
    }
    if (pWatchId) {
      await req(`/api/v1/projects/${pWatchId}`, { body: { as: "human", action: "delete", confirm: "删除" } }).catch(() => {})
    }
    if (pUnwatchedId) {
      await req(`/api/v1/projects/${pUnwatchedId}`, { body: { as: "human", action: "delete", confirm: "删除" } }).catch(() => {})
    }
    // The desk seat goes whatever happened above: left behind, the next run
    // stops at 「前台已有别的席位占座」.
    if (createdFrontSeatId) {
      const fList = (await req("/api/v1/projects").catch(() => ({ data: {} }))).data.projects ?? []
      const fProj = fList.find((x) => x.front)
      if (fProj) {
        await req("/api/v1/leave", { proj: fProj.id, body: { as: "human", agentId: createdFrontSeatId } }).catch(() => {})
      }
    }
    if (createdFrontId) {
      await req(`/api/v1/projects/${createdFrontId}`, { body: { as: "human", action: "delete", confirm: "删除" } }).catch(() => {})
    }
    if (savedAdapters) {
      await req("/api/v1/adapters", { body: { as: "human", agents: savedAdapters } }).catch(() => {})
    }
    rmSync(mcpRoot, { recursive: true, force: true })
  }
}

function runInProcessPatrolAndLifecyclePart() {
  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), `bench-watch-proc-${stamp}-`))
  const workDir = path.join(tmpRoot, "work")
  const dataDir = path.join(workDir, "data")
  const stateDir = path.join(tmpRoot, "state")
  mkdirSync(dataDir, { recursive: true })
  mkdirSync(stateDir, { recursive: true })

  const frontLog = path.join(tmpRoot, "front.jsonl")
  const coordLog = path.join(tmpRoot, "coord.jsonl")
  const fakeFront = path.join(tmpRoot, "fake-front.mjs")
  const fakeCoord = path.join(tmpRoot, "fake-coord.mjs")
  const fakeSlow = path.join(tmpRoot, "fake-slow.mjs")
  const runner = path.join(tmpRoot, "runner.mjs")

  writeFileSync(
    fakeFront,
    `import { appendFileSync } from "node:fs"\nappendFileSync(${JSON.stringify(frontLog)}, JSON.stringify({ prompt: process.argv[3] || "" }) + "\\n")\nconsole.log("【本轮结束】前台收到盯防通知")\n`,
    "utf8",
  )
  writeFileSync(
    fakeCoord,
    `import { appendFileSync } from "node:fs"\nappendFileSync(${JSON.stringify(coordLog)}, JSON.stringify({ prompt: process.argv[3] || "" }) + "\\n")\nconsole.log("【本轮结束】统筹收到催促")\n`,
    "utf8",
  )
  writeFileSync(fakeSlow, `setTimeout(() => console.log("【本轮结束】"), 8000)\n`, "utf8")

  writeFileSync(
    path.join(workDir, "agents.json"),
    JSON.stringify(
      {
        agents: [
          { name: "mock_front", command: `node '${fakeFront}' {uuid} {text}`, reply: "stdout" },
          { name: "codebuddy", command: `node '${fakeCoord}' {uuid} {text}`, reply: "stdout" },
          { name: "mock_slow", command: `node '${fakeSlow}' {uuid} {text}`, reply: "stdout" },
        ],
      },
      null,
      2,
    ),
    "utf8",
  )

  const repoRootUrl = pathToFileURL(process.cwd() + "/").href
  const aliasHref = pathToFileURL(path.join(process.cwd(), "scripts/ts-alias.mjs")).href

  writeFileSync(
    runner,
    `
import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { register } from "node:module"

register(${JSON.stringify(aliasHref)}, import.meta.url)

const root = ${JSON.stringify(repoRootUrl)}
const store = await import(new URL("lib/store.ts", root).href)
const summon = await import(new URL("lib/summon.ts", root).href)
const patrol = await import(new URL("lib/patrol.ts", root).href)
const watch = await import(new URL("lib/watch.ts", root).href)
const relay = await import(new URL("lib/front-relay.ts", root).href)
const quotaReports = await import(new URL("lib/quota-reports.ts", root).href)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const MIN = 60_000
const readLines = (f) => (existsSync(f) ? readFileSync(f, "utf8").trim().split("\\n").filter(Boolean).map((x) => JSON.parse(x)) : [])

const waitSettled = async (projId, msgId, seatId) => {
  const done = new Set(["answered", "silent", "failed", "stopped", "cut", "dropped"])
  for (let i = 0; i < 150; i++) {
    const snap = store.inProject(projId, () => store.snapshot())
    const m = snap.messages.find((x) => x.id === msgId)
    const c = m?.calls?.find((x) => x.id === seatId)
    const s = snap.agents.find((x) => x.id === seatId)
    if (c && done.has(c.state) && !s?.runId) return
    await sleep(30)
  }
  throw new Error("等待唤起结算超时")
}

summon.ensureSummon()
// Keep active-reminder switch OFF! Watched projects MUST still be swept!
assert.equal(patrol.patrolOn(), false, "默认主动提醒开关应为关")

const frontProj = store.createProject({ as: "human", front: true }).project
const deskJoined = store.inProject(frontProj.id, () =>
  store.join({ name: "前台", model: "mock", role: "前台", agentName: "mock_front", uuid: "u_desk" }),
)
const deskSeat = deskJoined.agent
const deskToken = deskJoined.token

// Verify front-desk duty prompt mentions bench_watch while keeping first sentence <=200 chars
const wakeMsg0 = store.inProject(frontProj.id, () => store.say({ as: "human", text: "看一眼守则" }).message)
await waitSettled(frontProj.id, wakeMsg0.id, deskSeat.id)
const firstFrontPrompt = readLines(${JSON.stringify(frontLog)})[0]?.prompt ?? ""
const dutyMatch = firstFrontPrompt.match(/你是前台[\\s\\S]*?说清楚。/)
assert.ok(dutyMatch && dutyMatch[0].length <= 200, "前台守则第一句仍须 <= 200 字")
assert.ok(firstFrontPrompt.includes("bench_watch"), "前台守则应写明何时用 bench_watch")

// Two ordinary projects: pUnwatched (NOT watched) and pWatched (watched)
const pUnwatched = store.createProject({ as: "human", name: "老旧闲置房" }).project
const uSeat = store.inProject(pUnwatched.id, () =>
  store.join({ name: "旧统筹", model: "mock", role: "统筹", agentName: "codebuddy", uuid: "u_old" }).agent,
)
store.inProject(pUnwatched.id, () =>
  store.createTask({ as: "human", title: "闲置未盯的活", owner: uSeat.name, steps: ["一步", "请用户验收"] }),
)

const pWatched = store.createProject({ as: "human", name: "重点盯防房" }).project
const coordJoined = store.inProject(pWatched.id, () =>
  store.join({ name: "主统筹", model: "mock", role: "统筹", agentName: "codebuddy", uuid: "u_coord" }),
)
const slowJoined = store.inProject(pWatched.id, () =>
  store.join({ name: "执行员", model: "mock", role: "开发", agentName: "mock_slow", uuid: "u_slow" }),
)

// Create 4 unfinished tasks so we also verify "(列最多 3 件标题)" formatting
const createdTasks = store.inProject(pWatched.id, () => [
  store.createTask({ as: "human", title: "整理登录接口", owner: slowJoined.agent.name, steps: ["做", "请用户验收"] }).task,
  store.createTask({ as: "human", title: "补齐会话缓存", owner: slowJoined.agent.name, steps: ["做", "请用户验收"] }).task,
  store.createTask({ as: "human", title: "修复样式错位", owner: coordJoined.agent.name, steps: ["做", "请用户验收"] }).task,
  store.createTask({ as: "human", title: "编写部署脚本", owner: coordJoined.agent.name, steps: ["做", "请用户验收"] }).task,
])

const baseNow = Date.now()
watch.setProjectWatch({ agentId: deskSeat.id, token: deskToken, project: pWatched.id, seat: coordJoined.agent.name }, baseNow)

// 1) Before 10 minutes idle (at +8m) -> neither unwatched nor watched wakes front desk
const s8m = await patrol.sweep(false, baseNow + 8 * MIN)
assert.equal(s8m, null, "全停未满 10 分钟不该叫醒前台")

// 2) Guard: coordinator's client is quota-blocked -> at +15m must NOT wake front desk
quotaReports.report({
  kind: "codebuddy",
  source: "测试",
  windows: [{ span: "5h", label: "5 小时", percent: 100, resetsAt: new Date(baseNow + 2 * 3600_000).toISOString() }],
})
const sQuota = await patrol.sweep(false, baseNow + 15 * MIN)
assert.equal(sQuota, null, "统筹那家客户端撞额度时不该报卡住叫醒前台")
quotaReports.report({ kind: "codebuddy", windows: [] })

// 3) Guard: user paused coordinator's queue -> must NOT wake front desk
store.inProject(pWatched.id, () => summon.pauseQueue(coordJoined.agent.id, true))
assert.equal(await patrol.sweep(false, baseNow + 16 * MIN), null, "用户暂停了队列时不该叫醒前台")
store.inProject(pWatched.id, () => summon.pauseQueue(coordJoined.agent.id, false))

// 4) Guard: user clicked Stop on coordinator -> must NOT wake front desk until user calls again
store.inProject(pWatched.id, () => store.say({ as: "human", text: "@执行员 跑一下" }))
for (let i = 0; i < 30; i++) {
  if (store.inProject(pWatched.id, () => store.snapshot().agents.find((a) => a.id === slowJoined.agent.id)?.runId)) break
  await sleep(25)
}
store.inProject(pWatched.id, () => summon.stopAgent(slowJoined.agent.id))
store.inProject(pWatched.id, () => summon.pauseQueue(coordJoined.agent.id, true))
assert.equal(await patrol.sweep(false, baseNow + 17 * MIN), null, "用户手动停下时不该叫醒前台")
store.inProject(pWatched.id, () => summon.pauseQueue(coordJoined.agent.id, false))

// 5) Quiet for 35m (>10m idle, quota available, active-reminder OFF):
//    pWatched wakes front desk ONCE; pUnwatched is completely ignored!
const frontCountBefore = readLines(${JSON.stringify(frontLog)}).length
const T_hit = baseNow + 35 * MIN
const riskMsg = await patrol.sweep(false, T_hit)
assert.ok(riskMsg, "盯着的项目全停满 10 分钟且额度充足时，即使主动提醒关着也必须报给前台")
await waitSettled(frontProj.id, riskMsg.id, deskSeat.id)
const frontLogsAfter = readLines(${JSON.stringify(frontLog)})
assert.equal(frontLogsAfter.length, frontCountBefore + 1, "前台值班 AI 应被叫醒 1 次")
assert.ok(!riskMsg.text.includes("老旧闲置房"), "没盯的项目全停绝不该出现在通知里")
assert.ok(
  riskMsg.text.includes("【要紧】重点盯防房：席位全停了") &&
    riskMsg.text.includes("额度还有，还有 4 件没做完（") &&
    ["整理登录接口", "补齐会话缓存", "修复样式错位", "编写部署脚本"].filter((t) => riskMsg.text.includes("「" + t + "」")).length === 3 &&
    riskMsg.text.includes(" 等）") &&
    riskMsg.text.includes("统筹是 主统筹。") &&
    riskMsg.text.includes("先用 bench_peek 看是不是卡住") &&
    riskMsg.text.includes("bench_nudge"),
  \`叫醒前台的话不符合要求：\\n\${riskMsg.text}\`,
)

// The same quiet stretch is told once, however long it lasts.
assert.equal(await patrol.sweep(false, T_hit + 40 * MIN), null, "同一次停下，过 40 分钟不该再报")
assert.equal(await patrol.sweep(false, T_hit + 120 * MIN), null, "同一次停下，过 2 小时也不该再报")

// 6) Direct nudge in-process check (also guards fault injection!)
const unwDraft = relay.draftRelay({
  agentId: deskSeat.id,
  token: deskToken,
  kind: "nudge",
  project: pUnwatched.id,
  seat: uSeat.name,
  text: "没盯的项目测试",
})
assert.equal(unwDraft.relay.state, "draft", "没盯的项目调 draftRelay(nudge) 必须返回 draft 草稿卡片")
assert.ok(!unwDraft.direct, "没盯的项目绝不能直接发")

const directRes = relay.draftRelay({
  agentId: deskSeat.id,
  token: deskToken,
  kind: "nudge",
  project: pWatched.id,
  seat: coordJoined.agent.name,
  text: "请接手推进剩余四件待办",
})
assert.equal(directRes.direct, true, "盯着的项目对统筹调 nudge 应直接发出")
assert.equal(directRes.relay.state, "sent", "前台记录卡状态应为 sent")
const landedInWatched = store.inProject(pWatched.id, () =>
  store.snapshot().messages.find((m) => m.id === directRes.sent.id),
)
assert.ok(landedInWatched, "目标项目应落入该消息")
assert.notEqual(landedInWatched.authorId, "human", "直接发出的消息 authorId 绝不能是 human")
assert.equal(landedInWatched.authorId, "front", "直接发出的消息 authorId 必须是 front")
assert.equal(landedInWatched.authorName, "前台", "署名必须是前台")
assert.ok(
  landedInWatched.text === "@主统筹 前台来看了一眼：请接手推进剩余四件待办" && !landedInWatched.text.includes("经前台"),
  \`正文格式不对：\${landedInWatched.text}\`,
)
await waitSettled(pWatched.id, landedInWatched.id, coordJoined.agent.id)
assert.equal(readLines(${JSON.stringify(coordLog)}).length, 1, "统筹应被直接叫醒 1 次")

// Something happened (the desk's nudge, the coordinator ran): a new quiet
// stretch, told once it has lasted 10 minutes.
const R_after = Date.now()
assert.equal(await patrol.sweep(false, R_after + 8 * MIN), null, "有了新动作，再停不满 10 分钟不该报")
const again = await patrol.sweep(false, R_after + 11 * MIN)
assert.ok(again && again.text.includes("重点盯防房：席位全停了"), "有了新动作又停满 10 分钟，应再报一次")

// 7) All unfinished tasks handed over (done or waiting for user review) -> auto-unwatch + low-priority note!
store.inProject(pWatched.id, () => {
  // Pass first 2 as done, put remaining 2 into awaitingReview
  for (const t of createdTasks.slice(0, 2)) {
    store.actOnTask({ agentId: slowJoined.agent.id, token: slowJoined.token, taskId: t.id, action: "step", step: 1, state: "done", note: "完" })
    store.actOnTask({ agentId: slowJoined.agent.id, token: slowJoined.token, taskId: t.id, action: "review", note: "页面上能看到做完了" })
    store.actOnTask({ as: "human", taskId: t.id, action: "pass" })
  }
  for (const t of createdTasks.slice(2)) {
    store.actOnTask({ agentId: coordJoined.agent.id, token: coordJoined.token, taskId: t.id, action: "step", step: 1, state: "done", note: "完" })
    store.actOnTask({ agentId: coordJoined.agent.id, token: coordJoined.token, taskId: t.id, action: "review", note: "页面上能看到改好了" })
  }
})
const frontWakeCountBeforeDone = readLines(${JSON.stringify(frontLog)}).length
const doneNote = await patrol.sweep(false, T_hit + 40 * MIN)
assert.ok(doneNote, "活都交了应给前台留一条记录")
assert.equal(doneNote.mentions.length, 0, "不急记录不该马上叫醒前台")
assert.ok(
  doneNote.text.includes("重点盯防房 的活都交了，在等用户"),
  \`活交完记录文案不对：\${doneNote.text}\`,
)
assert.equal(watch.getWatchedProject(pWatched.id), undefined, "活交完后应从盯着的项目表里自动去掉")
assert.equal(readLines(${JSON.stringify(frontLog)}).length, frontWakeCountBeforeDone, "不急记录不应拉起前台进程")

// 8) 24-hour expiry auto-unwatch
const pExpire = store.createProject({ as: "human", name: "超时盯防房" }).project
const expSeat = store.inProject(pExpire.id, () =>
  store.join({ name: "超时统筹", model: "mock", role: "统筹", agentName: "codebuddy", uuid: "u_exp" }).agent,
)
store.inProject(pExpire.id, () =>
  store.createTask({ as: "human", title: "一天没做完的活", owner: expSeat.name, steps: ["一步", "请用户验收"] }),
)
const T_expStart = T_hit + 50 * MIN
watch.setProjectWatch({ agentId: deskSeat.id, token: deskToken, project: pExpire.id, seat: expSeat.name }, T_expStart)
const expNote = await patrol.sweep(false, T_expStart + 24 * 60 * MIN + MIN)
assert.ok(expNote && expNote.mentions.length === 0, "满 24 小时应留一条不急记录")
assert.equal(watch.getWatchedProject(pExpire.id), undefined, "满 24 小时应自动从表里去掉")

// 9) A wake still open but quiet for 30 minutes counts as stopped, and the
//    note names the seat (2026-11-17: one sat 6 hours, the desk took it as working).
const pHang = store.createProject({ as: "human", name: "挂住的房" }).project
const hangCoord = store.inProject(pHang.id, () =>
  store.join({ name: "挂房统筹", model: "mock", role: "统筹", agentName: "codebuddy", uuid: "u_hcoord" }),
)
const hangSlow = store.inProject(pHang.id, () =>
  store.join({ name: "哈基米", model: "mock", role: "开发", agentName: "mock_slow", uuid: "u_hslow" }),
)
store.inProject(pHang.id, () =>
  store.createTask({ as: "human", title: "挂住的活", owner: hangSlow.agent.name, steps: ["做", "请用户验收"] }),
)
store.inProject(pHang.id, () => store.say({ as: "human", text: "@哈基米 跑一下" }))
for (let i = 0; i < 40; i++) {
  if (store.inProject(pHang.id, () => store.snapshot().agents.find((a) => a.id === hangSlow.agent.id)?.runId)) break
  await sleep(25)
}
const R_hang = Date.now()
watch.setProjectWatch({ agentId: deskSeat.id, token: deskToken, project: pHang.id, seat: hangCoord.agent.name }, R_hang)
assert.equal(await patrol.sweep(false, R_hang + 20 * MIN), null, "一轮开着、20 分钟前还有动静，不该当它停了")
const hangMsg = await patrol.sweep(false, R_hang + 31 * MIN)
assert.ok(hangMsg, "一轮开着但 30 分钟没动静，应当它停了报给前台")
assert.ok(
  hangMsg.text.includes("哈基米 这一轮开了 31 分钟，最近 31 分钟没动静") &&
    hangMsg.text.includes("只有用户能停下一轮") &&
    hangMsg.text.includes("bench_peek") &&
    hangMsg.text.includes("「停止」"),
  \`挂住的报告应点出是谁、开了多久、多久没动静：\\n\${hangMsg.text}\`,
)
assert.equal(await patrol.sweep(false, R_hang + 3 * 60 * MIN), null, "同一次挂住只报一次")
store.inProject(pHang.id, () => summon.stopAgent(hangSlow.agent.id))
process.exit(0)
`,
    "utf8",
  )

  try {
    execFileSync(process.execPath, ["--no-warnings", runner], {
      cwd: workDir,
      env: {
        ...process.env,
        BENCH_DATA_DIR: dataDir,
        XDG_STATE_HOME: stateDir,
      },
      encoding: "utf8",
    })
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true })
  }
}

await runHttpAndMcpPart()
runInProcessPatrolAndLifecyclePart()
console.log("watch ok")
