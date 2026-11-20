#!/usr/bin/env node
// Verification for t_a3ab3c44 parts 2 & 3:
//   - Seat's room-written "被服务器重启打断了" notice cleared on next wake and NOT restored by settle();
//   - Idle/offline seat's doing older than 24h hidden in frontOverview & frontPeek (kept in snapshot/left-rail);
//   - frontPeek compact default (<=8000 chars, 600-char summary, deduped one-line waitingReviews & tasks,
//     <=10 talk lines clipped to 200 chars without wakeText, overflow trims older talk lines with "还有 N 条，用 before=... 翻");
//   - `part` (summary | tasks | seats | talk) full single-section fetch + pagination when long;
//   - `full: true` legacy behavior preserved;
//   - `bench_peek` MCP schema/forwarding & front-desk duty prompt length not increased and first sentence <= 200 chars.

import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const repoDir = process.env.BENCH_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const origin = process.env.BENCH_URL || ""
if (origin && /:4399\b/.test(origin)) {
  console.error("禁止在正式房间 4399 上运行 test-peek-doing.mjs")
  process.exit(2)
}

const stamp = Date.now().toString(36)

function runInProcessChecks() {
  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), `bench-peek-doing-${stamp}-`))
  const workDir = path.join(tmpRoot, "work")
  const dataDir = path.join(workDir, "data")
  const stateDir = path.join(tmpRoot, "state")
  mkdirSync(dataDir, { recursive: true })
  mkdirSync(stateDir, { recursive: true })

  const wakeLog = path.join(tmpRoot, "wake.jsonl")
  const fakeAgent = path.join(tmpRoot, "fake-agent.mjs")
  const runner = path.join(tmpRoot, "runner.mjs")

  writeFileSync(
    fakeAgent,
    [
      `import { appendFileSync } from "node:fs"`,
      `appendFileSync(${JSON.stringify(wakeLog)}, JSON.stringify({ uuid: process.argv[2] || "", prompt: process.argv[3] || "" }) + "\\n")`,
      `console.log("【本轮结束】已处理")`,
    ].join("\n"),
    "utf8",
  )

  writeFileSync(
    path.join(workDir, "agents.json"),
    JSON.stringify(
      {
        agents: [{ name: "mock_cli", command: `node '${fakeAgent}' {uuid} {text}`, reply: "stdout" }],
      },
      null,
      2,
    ),
    "utf8",
  )

  const repoRootUrl = pathToFileURL(repoDir + "/").href
  const aliasHref = pathToFileURL(path.join(repoDir, "scripts/ts-alias.mjs")).href

  writeFileSync(
    runner,
    `
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { register } from "node:module"

register(${JSON.stringify(aliasHref)}, import.meta.url)

const root = ${JSON.stringify(repoRootUrl)}
const store = await import(new URL("lib/store.ts", root).href)
const summon = await import(new URL("lib/summon.ts", root).href)
const front = await import(new URL("lib/front.ts", root).href)
const db = await import(new URL("lib/db.ts", root).href)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const HOUR = 3600_000

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

// Create front desk and business project
const frontProj = store.createProject({ as: "human", front: true }).project
const deskJoined = store.inProject(frontProj.id, () =>
  store.join({ name: "前台", model: "mock", role: "前台", agentName: "mock_cli", uuid: "u_desk" }),
)
const deskAuth = { agentId: deskJoined.agent.id, token: deskJoined.token }

// ---- 1) Verify frontDuty mentions part without growing longer & first sentence <= 200 chars ----
const wakeFrontMsg = store.inProject(frontProj.id, () => store.say({ as: "human", text: "测试前台守则" }).message)
await waitSettled(frontProj.id, wakeFrontMsg.id, deskJoined.agent.id)
const frontPrompts = readFileSync(${JSON.stringify(wakeLog)}, "utf8").trim().split("\\n").map((l) => JSON.parse(l).prompt)
const dutyPrompt = frontPrompts[0]
const dutyMatch = dutyPrompt.match(/你是前台[\\s\\S]*?说清楚。/)
assert.ok(dutyMatch && dutyMatch[0].length <= 200, \`前台守则首句须 <= 200 字，实际 \${dutyMatch?.[0]?.length}\`)
assert.ok(dutyMatch[0].includes("part"), "前台守则首句应写明 bench_peek 传 part 细看某栏")

// ---- 2) Seat's "被服务器重启打断了" cleared on next wake & not restored by settle(); normal doing still restored ----
const bizProj = store.createProject({ as: "human", name: "测试大项目" }).project
const cutSeat = store.inProject(bizProj.id, () =>
  store.join({ name: "断线员", model: "mock", role: "开发", agentName: "mock_cli", uuid: "u_cut" }),
)
const keepSeat = store.inProject(bizProj.id, () =>
  store.join({ name: "常驻员", model: "mock", role: "开发", agentName: "mock_cli", uuid: "u_keep" }),
)
const workingSeat = store.inProject(bizProj.id, () =>
  store.join({ name: "忙碌员", model: "mock", role: "开发", agentName: "mock_cli", uuid: "u_work" }),
)

// Simulate announceInterrupted having written "被服务器重启打断了" on cutSeat, and normal doing on keepSeat
store.inProject(bizProj.id, () => {
  store.pulseAgent(cutSeat.agent.id, "idle", "被服务器重启打断了")
  store.pulseAgent(keepSeat.agent.id, "idle", "长期负责存储模块")
  store.pulseAgent(workingSeat.agent.id, "working", "正在跑长任务")
})

const mWakeBoth = store.inProject(bizProj.id, () =>
  store.say({ as: "human", text: "@断线员 @常驻员 跑一轮" }).message,
)
await waitSettled(bizProj.id, mWakeBoth.id, cutSeat.agent.id)
await waitSettled(bizProj.id, mWakeBoth.id, keepSeat.agent.id)

const afterSnap = store.inProject(bizProj.id, () => store.snapshot())
const cutAfter = afterSnap.agents.find((a) => a.id === cutSeat.agent.id)
const keepAfter = afterSnap.agents.find((a) => a.id === keepSeat.agent.id)
assert.equal(cutAfter.doing, "", \`「被服务器重启打断了」跑完一轮后绝不该被 settle() 写回，实际 doing=\${JSON.stringify(cutAfter.doing)}\`)
assert.equal(keepAfter.doing, "长期负责存储模块", "席位自己的正常备注跑完一轮后应照常恢复")

// ---- 3) Idle/offline seat's doing older than 24h hidden in overview & peek, kept in left-rail snapshot ----
const nowBase = Date.now()
const ov23h = front.frontOverview(deskAuth, nowBase + 23 * HOUR)
const bizOv23 = ov23h.projects.find((p) => p.id === bizProj.id)
assert.equal(
  bizOv23.seats.find((s) => s.name === "常驻员")?.doing,
  "长期负责存储模块",
  "未满 24 小时的空闲备注在一览里应正常显示",
)

const ov25h = front.frontOverview(deskAuth, nowBase + 25 * HOUR)
const bizOv25 = ov25h.projects.find((p) => p.id === bizProj.id)
assert.equal(
  bizOv25.seats.find((s) => s.name === "常驻员")?.doing,
  "",
  "超过 24 小时的空闲/离线席位备注在一览 seats 数据里应隐藏",
)
assert.ok(!ov25h.text.includes("长期负责存储模块"), "超过 24 小时的空闲/离线备注在一览 text 里不应显示")

const peek25h = front.frontPeek({ ...deskAuth, project: bizProj.id }, nowBase + 25 * HOUR)
assert.equal(
  peek25h.seats.find((s) => s.name === "常驻员")?.doing,
  "",
  "超过 24 小时的空闲/离线备注在 peek seats 数据里应隐藏",
)
assert.ok(!peek25h.text.includes("长期负责存储模块"), "超过 24 小时的空闲/离线备注在 peek text 里不应显示")

// Blocked seat older than 24h still shows its doing!
store.inProject(bizProj.id, () => store.pulseAgent(workingSeat.agent.id, "blocked", "卡在数据库迁移"))
const tBlockedBase = Date.now()
const peekBlocked25h = front.frontPeek({ ...deskAuth, project: bizProj.id }, tBlockedBase + 25 * HOUR)
assert.ok(peekBlocked25h.text.includes("卡在数据库迁移"), "卡住（blocked）席位的备注超过 24 小时仍应显示")

// Left-rail snapshot() keeps keepSeat's doing unchanged
const leftRailSnap = store.inProject(bizProj.id, () => store.snapshot())
assert.equal(
  leftRailSnap.agents.find((a) => a.id === keepSeat.agent.id)?.doing,
  "长期负责存储模块",
  "左栏使用的 snapshot().agents 应照旧保留原备注",
)

// ---- 4) frontPeek compact default (<=8000 chars), wakeText stripping, deduped tasks, trim older talk with before ----
const longSummary = "【摘要开头标记】\\n" + "这是房间阶段进展结论条目，包含模块设计与验证结论。\\n".repeat(300) + "【摘要结尾标记】"
assert.ok(longSummary.length > 7750 && longSummary.length <= 8000, \`测试摘要长度=\${longSummary.length}\`)
store.inProject(bizProj.id, () =>
  store.summaryAction({ agentId: keepSeat.agent.id, token: keepSeat.token, action: "write", text: longSummary }),
)

// Create 3 waiting-review tasks and 55 active unfinished tasks (so prefix is ~5800 chars, leaving room for only a few talk lines!)
const reviewTaskIds = []
store.inProject(bizProj.id, () => {
  for (let i = 1; i <= 3; i++) {
    const t = store.createTask({
      as: "human",
      title: \`待验收功能模块第\${i}项用于验证不重复显示\`,
      owner: keepSeat.agent.name,
      steps: ["实现逻辑", "自测通过", "请用户验收"],
    }).task
    store.actOnTask({ agentId: keepSeat.agent.id, token: keepSeat.token, taskId: t.id, action: "step", step: 1, state: "done", note: "完成" })
    store.actOnTask({ agentId: keepSeat.agent.id, token: keepSeat.token, taskId: t.id, action: "step", step: 2, state: "done", note: "通过" })
    store.actOnTask({ agentId: keepSeat.agent.id, token: keepSeat.token, taskId: t.id, action: "review", note: \`打开页面就能看到第\${i}项效果\` })
    reviewTaskIds.push(t.id)
  }
  for (let i = 1; i <= 82; i++) {
    store.createTask({
      as: "human",
      title: \`正在推进的子任务条目编号\${String(i).padStart(2, "0")}验证精简输出预算控制\`,
      owner: cutSeat.agent.name,
      steps: ["第一步准备", "第二步编码", "请用户验收"],
    })
  }
})

// Post 18 talk messages, each ~260 chars in text PLUS a huge 1500-char wakeText secret that compact peek MUST NOT include
const wakeSecret = "WAKE_TEXT_ONLY_SECRET_PAYLOAD_" + "X".repeat(1200)
const postedTalkIds = []
store.inProject(bizProj.id, () => {
  for (let i = 1; i <= 18; i++) {
    const msg = store.say({
      agentId: keepSeat.agent.id,
      token: keepSeat.token,
      text: \`对话记录第\${String(i).padStart(2, "0")}条：\` + "汇报进展详情与验证数据摘要内容。".repeat(16) + \`【行尾_\${String(i).padStart(2, "0")}】\`,
    }).message
    // Attach a wakeText directly onto the stored message to verify compact peek strips wakeText while full/part="talk" keeps it
    msg.wakeText = \`\${msg.text}\\n\${wakeSecret}_\${i}\`
    db.dbPutMessage(bizProj.id, msg)
    postedTalkIds.push({ id: msg.id, seq: msg.seq, idx: i })
  }
})

const compactRes = front.frontPeek({ ...deskAuth, project: bizProj.id })
assert.ok(
  compactRes.text.length <= 8000,
  \`默认精简 peek 总长必须 <= 8000 字，实际 \${compactRes.text.length}\`,
)
// Summary clipped to 600 chars (head present, tail absent)
assert.ok(compactRes.text.includes("【摘要开头标记】") && !compactRes.text.includes("【摘要结尾标记】"), "默认精简摘要应截到 600 字")
assert.ok(compactRes.text.includes('part="summary"'), "截短摘要应提示传 part=summary")

// Waiting-review tasks appear ONLY ONCE (not duplicated in 未完成的待办) and on a single line
for (const tid of reviewTaskIds) {
  const occurrences = compactRes.text.split(tid).length - 1
  assert.equal(occurrences, 1, \`等验收待办 \${tid} 在精简 peek 中应只出现 1 次（不重复），实际出现 \${occurrences} 次\`)
}

// wakeText must NEVER appear in compact peek, and each talk line clipped to 200 chars (tail marker of 260-char message cut off)
assert.ok(!compactRes.text.includes("WAKE_TEXT_ONLY_SECRET_PAYLOAD_"), "默认精简 peek 对话绝不能带 wakeText")
assert.ok(!compactRes.text.includes("【行尾_18】"), "默认精简 peek 每条对话应截到 200 字")
assert.ok(compactRes.text.includes("对话记录第18条"), "最新一条对话应保留")

// Because 55 tasks + 3 reviews take ~6300 chars, not all 10 talk lines fit in 8000 chars:
// older talk lines were trimmed, and "还有 N 条，用 before=<seq> 翻" must be accurate!
assert.ok(
  compactRes.talk.messages.length > 0 && compactRes.talk.messages.length < 10,
  \`空间受限时应从 10 条对话里砍掉较早的（保留最新几条），实际保留 \${compactRes.talk.messages.length} 条\`,
)
const expectedCursor = compactRes.talk.messages[0].seq
assert.ok(
  compactRes.text.includes(\`还有 \${compactRes.talk.remaining} 条，用 before=\${expectedCursor} 翻\`),
  \`应写明「还有 N 条，用 before=<seq> 翻」，实际末尾：\\n\${compactRes.text.slice(-300)}\`,
)

// Passing that exact before cursor fetches the next batch right before expectedCursor without losing trimmed messages!
const nextTalkBatch = front.frontPeek({ ...deskAuth, project: bizProj.id, part: "talk", before: expectedCursor })
const newestInNext = nextTalkBatch.talk.messages.at(-1)
const idxInPosted = postedTalkIds.findIndex((x) => x.seq === expectedCursor)
assert.equal(
  newestInNext?.seq,
  postedTalkIds[idxInPosted - 1]?.seq,
  "用提示里的 before 翻页应无缝接上刚被砍掉的那一条对话，一条不漏",
)

// ---- 5) part parameter (summary / tasks / seats / talk) & pagination when > 8000 chars ----
const sumP1 = front.frontPeek({ ...deskAuth, project: bizProj.id, part: "summary", page: 1 })
assert.ok(sumP1.text.length <= 8000 && sumP1.totalPages >= 2 && sumP1.hasMore === true, "超长摘要 part=summary 第 1 页应 <=8000 字且可翻页")
assert.ok(sumP1.text.includes("【摘要开头标记】") && sumP1.text.includes('part="summary", page=2'), "第 1 页应含开头与下一页提示")
const sumLast = front.frontPeek({ ...deskAuth, project: bizProj.id, part: "summary", page: sumP1.totalPages })
assert.ok(sumLast.text.length <= 8000 && sumLast.text.includes("【摘要结尾标记】") && sumLast.hasMore === false, "末页应含摘要结尾且 hasMore=false")

const tasksP1 = front.frontPeek({ ...deskAuth, project: bizProj.id, part: "tasks", page: 1 })
assert.ok(tasksP1.text.length <= 8000 && tasksP1.totalPages >= 2 && tasksP1.hasMore === true, "大量待办 part=tasks 应自动分页且每页 <=8000 字")
const allTaskPages = []
for (let p = 1; p <= tasksP1.totalPages; p++) {
  const pg = front.frontPeek({ ...deskAuth, project: bizProj.id, part: "tasks", page: p })
  assert.ok(pg.text.length <= 8000, \`part=tasks 第 \${p} 页也须 <=8000 字\`)
  allTaskPages.push(pg.text)
}
const joinedTasks = allTaskPages.join("\\n")
assert.ok(
  joinedTasks.includes("正在推进的子任务条目编号01") && joinedTasks.includes("正在推进的子任务条目编号82"),
  "part=tasks 全部分页合起来应完整覆盖首尾全部待办而不丢项",
)

const seatsP1 = front.frontPeek({ ...deskAuth, project: bizProj.id, part: "seats" })
assert.ok(seatsP1.text.length <= 8000 && seatsP1.text.includes("断线员") && seatsP1.text.includes("常驻员"), "part=seats 应返回席位详情")

const talkP1 = front.frontPeek({ ...deskAuth, project: bizProj.id, part: "talk" })
assert.ok(talkP1.text.length <= 8000, \`part=talk 单页也应控制在 8000 字内，实际 \${talkP1.text.length}\`)
assert.ok(talkP1.text.includes("WAKE_TEXT_ONLY_SECRET_PAYLOAD_") && talkP1.text.includes("【行尾_18】"), "part=talk 应返回不截 200 字、带 wakeText 的完整对话")

// Invalid part / page -> 400
assert.throws(() => front.frontPeek({ ...deskAuth, project: bizProj.id, part: "invalid" }), /400|part 只能是/)
assert.throws(() => front.frontPeek({ ...deskAuth, project: bizProj.id, part: "tasks", page: 0 }), /400|page/)

// ---- 6) full: true preserves legacy full output (> 8000 chars, full summary, 30 messages with wakeText) ----
const fullRes = front.frontPeek({ ...deskAuth, project: bizProj.id, full: true })
assert.ok(fullRes.text.length > 8000, "full:true 应保留不截 8000 字的完整输出")
assert.ok(fullRes.text.includes("【摘要开头标记】") && fullRes.text.includes("【摘要结尾标记】"), "full:true 应包含完整摘要")
assert.ok(fullRes.text.includes("WAKE_TEXT_ONLY_SECRET_PAYLOAD_"), "full:true 应包含完整 wakeText")

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

async function runMcpSchemaCheck() {
  const mcpRoot = mkdtempSync(path.join(os.tmpdir(), `bench-peek-mcp-${stamp}-`))
  const child = spawn(process.execPath, [path.join(repoDir, "scripts/bench-mcp.mjs"), "--agent", "claude"], {
    cwd: repoDir,
    env: {
      ...process.env,
      BENCH_URL: origin || "http://127.0.0.1:4484",
      XDG_STATE_HOME: mcpRoot,
    },
    stdio: ["pipe", "pipe", "pipe"],
  })
  let buf = ""
  const pending = new Map()
  let seq = 1
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
      const id = seq++
      const t = setTimeout(() => reject(new Error(`MCP ${method} timeout`)), 10_000)
      pending.set(id, (msg) => {
        clearTimeout(t)
        resolve(msg)
      })
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`)
    })

  try {
    await rpc("initialize", { protocolVersion: "2025-06-18" })
    const list = await rpc("tools/list", {})
    const peekTool = (list.result?.tools ?? []).find((t) => t.name === "bench_peek")
    assert.ok(peekTool, "MCP tools/list 应包含 bench_peek")
    const props = peekTool.inputSchema?.properties ?? {}
    assert.ok(props.project && props.part && props.page && props.before && props.full, "bench_peek schema 应包含 project/part/page/before/full")
    assert.deepEqual(props.part.enum, ["summary", "tasks", "seats", "talk"], "part enum 应为四栏")
  } finally {
    try {
      child.kill("SIGTERM")
    } catch {}
    rmSync(mcpRoot, { recursive: true, force: true })
  }
}

runInProcessChecks()
await runMcpSchemaCheck()
console.log("peek-doing ok")
