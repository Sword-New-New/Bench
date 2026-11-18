#!/usr/bin/env node
// In-process + cold-restart verification for auto-continue (t_4494da49, lib/continue.ts).
// Uses isolated temp directories and fake client scripts only (never touches live data or real clients).

import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

const stamp = Date.now().toString(36)

// Verify left-pane roster markup states 「房间已叫它接着做」 while keeping 「接着做」 button.
const rosterSrc = readFileSync(path.join(process.cwd(), "components/room/roster.tsx"), "utf8")
assert(
  rosterSrc.includes("房间已叫它接着做") && rosterSrc.includes("接着做") && rosterSrc.includes("owes.woken"),
  "components/room/roster.tsx 应在房间自动叫过以后显示「房间已叫它接着做」并保留「接着做」按钮",
)

const autoRoot = mkdtempSync(path.join(os.tmpdir(), `bench-continue-${stamp}-`))
const workDir = path.join(autoRoot, "work")
const dataDir = path.join(workDir, "data")
const stateDir = path.join(autoRoot, "state")
mkdirSync(dataDir, { recursive: true })
mkdirSync(stateDir, { recursive: true })

const workerLogFile = path.join(autoRoot, "worker-log.jsonl")
const frontLogFile = path.join(autoRoot, "front-log.jsonl")
const fakeWorkerScript = path.join(autoRoot, "fake-worker.mjs")
const fakeFrontScript = path.join(autoRoot, "fake-front.mjs")
const fakeSlowScript = path.join(autoRoot, "fake-slow.mjs")
const fakeNetErrScript = path.join(autoRoot, "fake-neterr.mjs")
const phase1Script = path.join(autoRoot, "phase1.mjs")
const phase2Script = path.join(autoRoot, "phase2.mjs")

writeFileSync(
  fakeWorkerScript,
  [
    `import { appendFileSync } from "node:fs"`,
    `const uuid = process.argv[2] || ""`,
    `const prompt = process.argv[3] || ""`,
    `appendFileSync(${JSON.stringify(workerLogFile)}, JSON.stringify({ uuid, prompt }) + "\\n", "utf8")`,
    `console.log("【本轮结束】假席位已收到续做提示")`,
  ].join("\n"),
  "utf8",
)
writeFileSync(
  fakeFrontScript,
  [
    `import { appendFileSync } from "node:fs"`,
    `const uuid = process.argv[2] || ""`,
    `const prompt = process.argv[3] || ""`,
    `appendFileSync(${JSON.stringify(frontLogFile)}, JSON.stringify({ uuid, prompt }) + "\\n", "utf8")`,
    `console.log("【本轮结束】前台已收到停滞汇报")`,
  ].join("\n"),
  "utf8",
)
writeFileSync(
  fakeSlowScript,
  `setTimeout(() => console.log("【本轮结束】慢任务结束"), 8000)\n`,
  "utf8",
)
writeFileSync(
  fakeNetErrScript,
  `process.stderr.write("Error: connect ECONNREFUSED 127.0.0.1:7897\\n"); process.exit(1)\n`,
  "utf8",
)

writeFileSync(
  path.join(workDir, "agents.json"),
  JSON.stringify(
    {
      agents: [
        { name: "mock_worker", command: `node '${fakeWorkerScript}' {uuid} {text}`, reply: "stdout" },
        { name: "mock_front", command: `node '${fakeFrontScript}' {uuid} {text}`, reply: "stdout" },
        { name: "mock_slow", command: `node '${fakeSlowScript}' {uuid} {text}`, reply: "stdout" },
        { name: "mock_neterr", command: `node '${fakeNetErrScript}' {uuid} {text}`, reply: "stdout" },
        { name: "mock_lim_card", command: `node '${fakeWorkerScript}' {uuid} {text}`, reply: "stdout" },
        { name: "codebuddy", command: `node '${fakeWorkerScript}' {uuid} {text}`, reply: "stdout" },
        { name: "mock_missing_bin", command: `'/nonexistent/bench-missing-cli-bin' {uuid} {text}`, reply: "stdout" },
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
  phase1Script,
  `
import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { register } from "node:module"

register(${JSON.stringify(aliasHref)}, import.meta.url)

const root = ${JSON.stringify(repoRootUrl)}
const store = await import(new URL("lib/store.ts", root).href)
const summon = await import(new URL("lib/summon.ts", root).href)
const cont = await import(new URL("lib/continue.ts", root).href)
const quotaReports = await import(new URL("lib/quota-reports.ts", root).href)
const termState = await import(new URL("lib/terminal-state.ts", root).href)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const readJsonl = (file) =>
  existsSync(file)
    ? readFileSync(file, "utf8")
        .trim()
        .split("\\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : []

const waitCallSettled = async (projId, msgId, seatId, timeoutMs = 8000) => {
  const settled = new Set(["answered", "silent", "failed", "stopped", "cut", "dropped"])
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const snap = store.inProject(projId, () => store.snapshot())
    const msg = snap.messages.find((m) => m.id === msgId)
    const call = msg?.calls?.find((c) => c.id === seatId)
    const seat = snap.agents.find((a) => a.id === seatId)
    if (call && settled.has(call.state) && !seat?.runId) return call
    await sleep(40)
  }
  throw new Error(\`等待消息 \${msgId} 对席位 \${seatId} 结算超时\`)
}

summon.ensureSummon()
const bootAt = cont.serverBootAt()
const MIN = 60_000

// 1) Front desk project + front seat (Guard: front-desk seat is NEVER auto-woken)
const frontProj = store.createProject({ as: "human", front: true }).project
const frontSeat = store.inProject(frontProj.id, () =>
  store.join({ name: "前台总管", model: "mock", role: "前台", agentName: "mock_front", uuid: "u_front" }).agent,
)
store.inProject(frontProj.id, () => {
  store.createTask({ as: "human", title: "前台内部待办不该被自动催", owner: frontSeat.name, steps: ["整理", "请用户验收"] })
})

// 2) Business project
const bizProj = store.listProjects().find((p) => !p.front)
const bizId = bizProj.id

const demoProj = store.createProject({ as: "human", name: "演示与冷启验证房" }).project

// Unwakeable seats in bizId: (a) no session, (b) uninstalled CLI binary
const noSessSeat = store.inProject(bizId, () =>
  store.join({ name: "无会话席", model: "mock", role: "开发" }).agent,
)
const missingBinSeat = store.inProject(bizId, () =>
  store.join({ name: "缺客户端席", model: "mock", role: "开发", agentName: "mock_missing_bin", uuid: "u_miss" }).agent,
)
store.inProject(bizId, () => {
  store.createTask({ as: "human", title: "无会话的活", owner: noSessSeat.name, steps: ["一步", "请用户验收"] })
  store.createTask({ as: "human", title: "缺客户端的活", owner: missingBinSeat.name, steps: ["一步", "请用户验收"] })
})

// Main worker seat + task
const mainSeat = store.inProject(bizId, () =>
  store.join({ name: "续做员", model: "mock", role: "主力", agentName: "mock_worker", uuid: "u_main" }).agent,
)
const tMain = store.inProject(bizId, () =>
  store.createTask({
    as: "human",
    title: "重构自动续做状态机",
    owner: mainSeat.name,
    steps: ["整理数据", "补齐校验", "请用户验收"],
  }).task,
)

// Wait 5ms so seat/task timestamps are >= bootAt
await sleep(5)

// Test <5m quiet does NOT wake, >=5m quiet wakes 1st time!
const T_4m = bootAt + 4 * MIN + 5_000
const r4m = cont.sweepContinue(T_4m)
assert.equal(r4m.woken.length, 0, "停着未满 5 分钟时不该叫醒")
assert.equal(readJsonl(${JSON.stringify(workerLogFile)}).length, 0, "未满 5 分钟假席位不应被调用")

// At 5m + 10s: mainSeat wakes for the 1st time; frontSeat, noSessSeat, missingBinSeat do NOT!
const T1 = bootAt + 5 * MIN + 10_000
const r1 = cont.sweepContinue(T1)
assert.ok(r1.woken.includes(mainSeat.id), "停满 5 分钟应自动叫醒续做员第 1 次")
assert.ok(!r1.woken.includes(frontSeat.id), "前台席位绝不该自动叫")
assert.ok(!r1.woken.includes(noSessSeat.id), "没有会话的席位绝不该自动叫")
assert.ok(!r1.woken.includes(missingBinSeat.id), "没装客户端的席位绝不该自动叫")

const snapAfter1 = store.inProject(bizId, () => store.snapshot())
const sysWakeMsgs1 = snapAfter1.messages.filter((m) => m.kind === "system" && m.mentions?.includes(mainSeat.id))
assert.equal(sysWakeMsgs1.length, 1, "群里应有 1 条房间发出的系统叫醒小字")
assert.equal(sysWakeMsgs1[0].authorId, "room", "必须以房间自己的名义发，不能冒充用户")
assert.ok(
  sysWakeMsgs1[0].text.startsWith(\`房间叫 \${mainSeat.name} 接着做 \${tMain.id}\`) && sysWakeMsgs1[0].text.length <= 30,
  \`群聊系统小字格式或长度不对：\${sysWakeMsgs1[0].text}\`,
)

await waitCallSettled(bizId, sysWakeMsgs1[0].id, mainSeat.id)

const logs1 = readJsonl(${JSON.stringify(workerLogFile)}).filter((x) => x.uuid === "u_main")
assert.equal(logs1.length, 1, "续做员第 1 次应被实际拉起 1 次")
assert.ok(
  logs1[0].prompt.includes(tMain.id) &&
    logs1[0].prompt.includes("重构自动续做状态机") &&
    logs1[0].prompt.includes("第 1 步「整理数据」") &&
    logs1[0].prompt.includes("接着做") &&
    logs1[0].prompt.includes("卡住") &&
    logs1[0].prompt.includes("bench_ask") &&
    logs1[0].prompt.includes("请验收"),
  \`给席位的话缺少关键要素：\${logs1[0].prompt}\`,
)

const mainOwes1 = store.inProject(bizId, () => store.snapshot().agents.find((a) => a.id === mainSeat.id)?.owes)
assert.equal(mainOwes1?.woken?.count, 1, "第 1 次叫完仍欠活时，左栏数据源 owes.woken.count 应为 1")

// Before 20 minutes after 1st wake -> must NOT wake 2nd time
const r19m = cont.sweepContinue(T1 + 19 * MIN)
assert.ok(!r19m.woken.includes(mainSeat.id), "第 1 次叫过未满 20 分钟不该叫第 2 次")

// At +20m + 5s -> wakes 2nd time!
const T2 = T1 + 20 * MIN + 5_000
const r2 = cont.sweepContinue(T2)
assert.ok(r2.woken.includes(mainSeat.id), "再过 20 分钟仍未推进应叫第 2 次")

const snapAfter2 = store.inProject(bizId, () => store.snapshot())
const sysWakeMsgs2 = snapAfter2.messages.filter((m) => m.kind === "system" && m.mentions?.includes(mainSeat.id))
assert.equal(sysWakeMsgs2.length, 2, "群里应有第 2 条房间系统叫醒小字")
await waitCallSettled(bizId, sysWakeMsgs2[1].id, mainSeat.id)

const logs2 = readJsonl(${JSON.stringify(workerLogFile)}).filter((x) => x.uuid === "u_main")
assert.equal(logs2.length, 2, "续做员应累计被叫醒 2 次")
const mainOwes2 = store.inProject(bizId, () => store.snapshot().agents.find((a) => a.id === mainSeat.id)?.owes)
assert.equal(mainOwes2?.woken?.count, 2, "第 2 次叫完仍欠活时 owes.woken.count 应为 2")

// After 2nd wake settles with no progress -> NEVER wake a 3rd time, and report to front desk once!
const T3 = T2 + 25 * MIN
const r3 = cont.sweepContinue(T3)
assert.ok(!r3.woken.includes(mainSeat.id), "同一批欠活最多叫 2 次，绝不能叫第 3 次")
assert.ok(r3.reported.includes(mainSeat.id), "两次都没动应记给前台")
assert.equal(
  readJsonl(${JSON.stringify(workerLogFile)}).filter((x) => x.uuid === "u_main").length,
  2,
  "即使再过 25 分钟，续做员总唤起次数仍必须严格为 2",
)

const frontSnap = store.inProject(frontProj.id, () => store.snapshot())
const riskMsg = frontSnap.messages.find(
  (m) => m.risk?.items?.some((it) => it.projectId === bizId && it.text.includes(\`\${mainSeat.name} 停了，叫了两次没动：\${tMain.id}\`)),
)
assert.ok(riskMsg, "前台房间应收到「XX 停了，叫了两次没动：t_… 标题」的隐藏说明")
assert.equal(riskMsg.risk.items[0].level, "high", "记给前台的级别必须是 high（【要紧】）")
assert.ok(riskMsg.text.includes("【要紧】"), "记给前台的文本须带【要紧】")
await waitCallSettled(frontProj.id, riskMsg.id, frontSeat.id)
assert.ok(readJsonl(${JSON.stringify(frontLogFile)}).length >= 1, "前台值班 AI 应被叫醒")

// Sweep again 1 hour later -> neither wakes a 3rd time nor reports a 2nd time
const frontRiskCountBefore = store.inProject(frontProj.id, () => store.snapshot().messages.filter((m) => Boolean(m.risk)).length)
const r4 = cont.sweepContinue(T3 + 60 * MIN)
assert.ok(!r4.woken.includes(mainSeat.id) && !r4.reported.includes(mainSeat.id), "已报过前台的不应重复报或重复叫")
assert.equal(
  store.inProject(frontProj.id, () => store.snapshot().messages.filter((m) => Boolean(m.risk)).length),
  frontRiskCountBefore,
  "前台不应收到重复的两次没动通知",
)

// ---- Test all 5 progress-reset conditions ----
const progProj = store.createProject({ as: "human", name: "进展清零房" }).project
const progJoined = store.inProject(progProj.id, () =>
  store.join({ name: "进展席", model: "mock", role: "开发", agentName: "mock_worker", uuid: "u_prog" }),
)
const progSeat = progJoined.agent
const progToken = progJoined.token
const tProg = store.inProject(progProj.id, () =>
  store.createTask({
    as: "human",
    title: "测试五种进展清零",
    owner: progSeat.name,
    steps: ["第一步", "第二步", "请用户验收"],
  }).task,
)

let curT = T3 + 70 * MIN
let rp = cont.sweepContinue(curT)
assert.ok(rp.woken.includes(progSeat.id), "进展席初始停满 5 分钟应叫第 1 次")
let pMsg = store.inProject(progProj.id, () => store.snapshot().messages.findLast((m) => m.mentions?.includes(progSeat.id)))
await waitCallSettled(progProj.id, pMsg.id, progSeat.id)
assert.equal(store.inProject(progProj.id, () => store.snapshot().agents.find((a) => a.id === progSeat.id)?.owes?.woken?.count), 1)

// Progress (a): step moves forward -> resets count to 0
store.inProject(progProj.id, () =>
  store.actOnTask({ agentId: progSeat.id, token: progToken, taskId: tProg.id, action: "step", step: 1, state: "done", note: "第一步完" }),
)
cont.sweepContinue(curT + 1_000)
assert.equal(
  store.inProject(progProj.id, () => store.snapshot().agents.find((a) => a.id === progSeat.id)?.owes?.woken),
  undefined,
  "步骤往前走后应立即清零已叫计数",
)
curT += 6 * MIN
rp = cont.sweepContinue(curT)
assert.ok(rp.woken.includes(progSeat.id), "步骤推进清零后，再停满 5 分钟（无需等 20 分钟）应作为新一批第 1 次叫醒")
pMsg = store.inProject(progProj.id, () => store.snapshot().messages.findLast((m) => m.mentions?.includes(progSeat.id)))
await waitCallSettled(progProj.id, pMsg.id, progSeat.id)

// Progress (b): bench_ask question -> clears count and does not wake while open
const askMsg = store.inProject(progProj.id, () =>
  store.askUser({ agentId: progSeat.id, token: progToken, text: "接口返回数组还是对象？" }).message,
)
curT += 30 * MIN
rp = cont.sweepContinue(curT)
assert.ok(!rp.woken.includes(progSeat.id), "提问等用户回答时不该自动叫")
store.inProject(progProj.id, () => store.say({ as: "human", text: "返回对象", replyTo: askMsg.id }))
const ansMsg = store.inProject(progProj.id, () => store.snapshot().messages.at(-1))
await waitCallSettled(progProj.id, ansMsg.id, progSeat.id)
curT += 6 * MIN
rp = cont.sweepContinue(curT)
assert.ok(rp.woken.includes(progSeat.id), "提问清零后若回答完又停满 5 分钟，应从第 1 次重新算")
pMsg = store.inProject(progProj.id, () => store.snapshot().messages.findLast((m) => m.mentions?.includes(progSeat.id)))
await waitCallSettled(progProj.id, pMsg.id, progSeat.id)

// Progress (c): mark task blocked -> clears count and does not wake
store.inProject(progProj.id, () =>
  store.actOnTask({ agentId: progSeat.id, token: progToken, taskId: tProg.id, action: "block", note: "等上游文档" }),
)
curT += 30 * MIN
assert.ok(!cont.sweepContinue(curT).woken.includes(progSeat.id), "待办标卡住后不该自动叫")

// Progress (d): resume step 2 as doing -> wakes once -> finish step 2 & ask for review -> clears count
store.inProject(progProj.id, () => {
  store.actOnTask({ agentId: progSeat.id, token: progToken, taskId: tProg.id, action: "claim", note: "继续做第二步" })
  store.actOnTask({ agentId: progSeat.id, token: progToken, taskId: tProg.id, action: "step", step: 2, state: "doing", note: "开始第二步" })
})
curT += 6 * MIN
rp = cont.sweepContinue(curT)
assert.ok(rp.woken.includes(progSeat.id), "恢复 doing 后停满 5 分钟应叫第 1 次")
pMsg = store.inProject(progProj.id, () => store.snapshot().messages.findLast((m) => m.mentions?.includes(progSeat.id)))
await waitCallSettled(progProj.id, pMsg.id, progSeat.id)
store.inProject(progProj.id, () => {
  store.actOnTask({ agentId: progSeat.id, token: progToken, taskId: tProg.id, action: "step", step: 2, state: "done", note: "第二步完" })
  store.actOnTask({ agentId: progSeat.id, token: progToken, taskId: tProg.id, action: "review", note: "刷新页面就能看到两步都做完了" })
})
curT += 30 * MIN
assert.ok(!cont.sweepContinue(curT).woken.includes(progSeat.id), "请验收后轮到用户，不该自动叫")

// Progress (e): task completed -> clears count and does not wake
store.inProject(progProj.id, () => store.actOnTask({ as: "human", taskId: tProg.id, action: "pass", note: "通过" }))
curT += 30 * MIN
assert.ok(!cont.sweepContinue(curT).woken.includes(progSeat.id), "待办完成后不该自动叫")

// ---- Test remaining "do NOT wake" guards ----
const guardProj = store.createProject({ as: "human", name: "守卫验证房" }).project

// Guard 1: User clicked Stop -> never auto-wake until user calls it again
const stopJoined = store.inProject(guardProj.id, () =>
  store.join({ name: "被停席", model: "mock", role: "开发", agentName: "mock_slow", uuid: "u_stop" }),
)
const stopSeat = stopJoined.agent
store.inProject(guardProj.id, () =>
  store.createTask({ as: "human", title: "用户点停的活", owner: stopSeat.name, steps: ["慢跑", "请用户验收"] }),
)
store.inProject(guardProj.id, () => store.say({ as: "human", text: \`@\${stopSeat.name} 开始跑\` }))
for (let i = 0; i < 40; i++) {
  const running = store.inProject(guardProj.id, () => store.snapshot().agents.find((a) => a.id === stopSeat.id)?.runId)
  if (running) break
  await sleep(30)
}
store.inProject(guardProj.id, () => summon.stopAgent(stopSeat.id))
await sleep(100)
curT += 30 * MIN
assert.ok(!cont.sweepContinue(curT).woken.includes(stopSeat.id), "用户点停止的那一轮之后，绝不该自动叫醒")

// Guard 2: User paused its queue
const pauseSeat = store.inProject(guardProj.id, () =>
  store.join({ name: "暂停席", model: "mock", role: "开发", agentName: "mock_worker", uuid: "u_pause" }).agent,
)
store.inProject(guardProj.id, () =>
  store.createTask({ as: "human", title: "队列暂停的活", owner: pauseSeat.name, steps: ["做事", "请用户验收"] }),
)
store.inProject(guardProj.id, () => summon.pauseQueue(pauseSeat.id, true))
curT += 10 * MIN
assert.ok(!cont.sweepContinue(curT).woken.includes(pauseSeat.id), "用户暂停队列的席位不该自动叫")

// Guard 3a: Client blocked by open usage-limit card (limitedAgentNames)
const limCardSeat = store.inProject(guardProj.id, () =>
  store.join({ name: "撞卡限额席", model: "mock", role: "开发", agentName: "mock_lim_card", uuid: "u_limcard" }).agent,
)
store.inProject(guardProj.id, () => {
  store.createTask({ as: "human", title: "撞限额卡的活", owner: limCardSeat.name, steps: ["做事", "请用户验收"] })
  store.postLimited("撞上 5 小时额度", {
    runId: "r_lim_mock",
    agentId: limCardSeat.id,
    agentName: limCardSeat.name,
    label: "5 小时额度",
    resetsAt: curT + 2 * 3600_000,
    state: "open",
  })
})
curT += 10 * MIN
assert.ok(!cont.sweepContinue(curT).woken.includes(limCardSeat.id), "客户端有未过期撞额度卡片时不该自动叫")

// Guard 3b: Client blocked by quota report (isKindQuotaBlocked)
const quotaSeat = store.inProject(guardProj.id, () =>
  store.join({ name: "额度满席", model: "mock", role: "开发", agentName: "codebuddy", uuid: "u_quota" }).agent,
)
store.inProject(guardProj.id, () =>
  store.createTask({ as: "human", title: "额度用尽的活", owner: quotaSeat.name, steps: ["做事", "请用户验收"] }),
)
quotaReports.report({
  kind: "codebuddy",
  source: "测试",
  windows: [{ span: "5h", label: "5 小时", percent: 100, resetsAt: new Date(curT + 2 * 3600_000).toISOString() }],
})
curT += 10 * MIN
assert.ok(!cont.sweepContinue(curT).woken.includes(quotaSeat.id), "客户端额度 100% 用尽时不该自动叫")
quotaReports.report({ kind: "codebuddy", windows: [] })

// Guard 4: Network retry pending
process.env.BENCH_RETRY_MS = "120000,240000"
const netSeat = store.inProject(guardProj.id, () =>
  store.join({ name: "网断重试席", model: "mock", role: "开发", agentName: "mock_neterr", uuid: "u_net" }).agent,
)
store.inProject(guardProj.id, () => {
  store.createTask({ as: "human", title: "网络重试中的活", owner: netSeat.name, steps: ["做事", "请用户验收"] })
  store.say({ as: "human", text: \`@\${netSeat.name} 试一下网络\` })
})
for (let i = 0; i < 40; i++) {
  const retry = store.inProject(guardProj.id, () => store.snapshot().agents.find((a) => a.id === netSeat.id)?.retry)
  if (retry) break
  await sleep(40)
}
assert.ok(
  store.inProject(guardProj.id, () => Boolean(store.snapshot().agents.find((a) => a.id === netSeat.id)?.retry)),
  "网断重试席应进入网络重试状态",
)
curT += 10 * MIN
assert.ok(!cont.sweepContinue(curT).woken.includes(netSeat.id), "有网络重试在排时不该自动叫")
store.inProject(guardProj.id, () => summon.stopAgent(netSeat.id))

// Guard 5a: Waiting in bench_wait (standby)
const waitJoined = store.inProject(guardProj.id, () =>
  store.join({ name: "守候席", model: "mock", role: "开发", agentName: "mock_worker", uuid: "u_wait" }),
)
const waitSeat = waitJoined.agent
store.inProject(guardProj.id, () =>
  store.createTask({ as: "human", title: "守候中的活", owner: waitSeat.name, steps: ["做事", "请用户验收"] }),
)
const waitAbort = new AbortController()
const waitPromise = store.inProject(guardProj.id, () =>
  store.waitFor({ agentId: waitSeat.id, token: waitJoined.token, after: 0, timeoutMs: 30_000 }, waitAbort.signal),
)
await sleep(50)
curT += 10 * MIN
assert.ok(!cont.sweepContinue(curT).woken.includes(waitSeat.id), "挂在 bench_wait 守候中的席位不该自动叫")
waitAbort.abort()
await Promise.allSettled([waitPromise])

// Guard 5b: Open in web terminal
const termSeat = store.inProject(guardProj.id, () =>
  store.join({ name: "终端席", model: "mock", role: "开发", agentName: "mock_worker", uuid: "u_term" }).agent,
)
store.inProject(guardProj.id, () =>
  store.createTask({ as: "human", title: "开着终端的活", owner: termSeat.name, steps: ["做事", "请用户验收"] }),
)
termState.markTerminal(termSeat.id, true)
curT += 10 * MIN
assert.ok(!cont.sweepContinue(curT).woken.includes(termSeat.id), "开着网页终端的席位不该自动叫")
termState.markTerminal(termSeat.id, false)

// Prepare one seat with count === 1 right before exit to verify persistence across restart in phase2!
const persistJoined = store.inProject(guardProj.id, () =>
  store.join({ name: "重启记账席", model: "mock", role: "开发", agentName: "mock_worker", uuid: "u_persist" }),
)
const persistSeat = persistJoined.agent
store.inProject(guardProj.id, () =>
  store.createTask({ as: "human", title: "跨重启记账的活", owner: persistSeat.name, steps: ["做事", "请用户验收"] }),
)
const T_persist1 = curT + 10 * MIN
const rPersist = cont.sweepContinue(T_persist1)
assert.ok(rPersist.woken.includes(persistSeat.id), "重启记账席在重启前应先叫过 1 次")
const pWakeMsg = store.inProject(guardProj.id, () =>
  store.snapshot().messages.findLast((m) => m.mentions?.includes(persistSeat.id)),
)
await waitCallSettled(guardProj.id, pWakeMsg.id, persistSeat.id)

console.log(
  JSON.stringify({
    bizId,
    frontProjId: frontProj.id,
    demoProjId: demoProj.id,
    guardProjId: guardProj.id,
    mainSeatId: mainSeat.id,
    stopSeatId: stopSeat.id,
    stopSeatName: stopSeat.name,
    stopToken: stopJoined.token,
    persistSeatId: persistSeat.id,
    persistToken: persistJoined.token,
    T_persist1,
  }),
)
process.exit(0)
`,
  "utf8",
)

try {
  const p1Out = execFileSync(process.execPath, ["--no-warnings", phase1Script], {
    cwd: workDir,
    env: {
      ...process.env,
      BENCH_DATA_DIR: dataDir,
      XDG_STATE_HOME: stateDir,
    },
    encoding: "utf8",
  })
  const p1 = JSON.parse(p1Out.trim().split("\n").at(-1))

  const savedAgentsCfg = JSON.parse(readFileSync(path.join(workDir, "agents.json"), "utf8"))
  for (const item of savedAgentsCfg.agents) {
    if (item.name === "mock_slow") item.command = `node '${fakeWorkerScript}' {uuid} {text}`
  }
  writeFileSync(path.join(workDir, "agents.json"), JSON.stringify(savedAgentsCfg, null, 2), "utf8")

  // Phase 2: fresh cold-boot Node process against the SAME SQLite dataDir!
  writeFileSync(
    phase2Script,
    `
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { register } from "node:module"

register(${JSON.stringify(aliasHref)}, import.meta.url)

const root = ${JSON.stringify(repoRootUrl)}
const db = await import(new URL("lib/db.ts", root).href)

const realNow = Date.now()
const MIN = 60_000
// Seed a demo seat (active after boot) and a pre-boot stale seat (stopped 15m BEFORE boot!)
db.dbSaveSeat(${JSON.stringify(p1.demoProjId)}, {
  id: "a_demo0001",
  token: "tok_demo",
  name: "阿证演示",
  model: "demo",
  role: "演示",
  strengths: [],
  status: "idle",
  doing: "",
  color: "#0f6e56",
  demo: true,
  agentName: "mock_worker",
  session: "u_demo",
  createdAt: realNow + 10_000,
  lastSeenAt: realNow + 10_000,
})
db.dbPutTask(${JSON.stringify(p1.demoProjId)}, {
  id: "t_demo0001",
  seq: 1,
  title: "演示席位的待办",
  detail: "",
  status: "doing",
  ownerId: "a_demo0001",
  ownerName: "阿证演示",
  createdById: "human",
  createdByName: "用户",
  updatedAt: realNow + 10_000,
  history: [],
  steps: [{ id: "s_d1", text: "第一步", state: "todo", by: "用户", at: realNow + 10_000, updatedAt: realNow + 10_000 }],
})
db.dbSaveSeat(${JSON.stringify(p1.demoProjId)}, {
  id: "a_preboot",
  token: "tok_pre",
  name: "启动前旧欠活席",
  model: "mock",
  role: "开发",
  strengths: [],
  status: "idle",
  doing: "",
  color: "#1e4d8c",
  demo: false,
  agentName: "mock_worker",
  session: "u_preboot",
  createdAt: realNow - 15 * MIN,
  lastSeenAt: realNow - 15 * MIN,
})
db.dbPutTask(${JSON.stringify(p1.demoProjId)}, {
  id: "t_preboot",
  seq: 2,
  title: "房间启动前就已经停了一天的旧欠活",
  detail: "",
  status: "doing",
  ownerId: "a_preboot",
  ownerName: "启动前旧欠活席",
  createdById: "human",
  createdByName: "用户",
  updatedAt: realNow - 15 * MIN,
  history: [],
  steps: [{ id: "s_pb1", text: "第一步", state: "todo", by: "用户", at: realNow - 15 * MIN, updatedAt: realNow - 15 * MIN }],
})

const store = await import(new URL("lib/store.ts", root).href)
const summon = await import(new URL("lib/summon.ts", root).href)
const cont = await import(new URL("lib/continue.ts", root).href)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const waitCallSettled = async (projId, msgId, seatId, timeoutMs = 8000) => {
  const settled = new Set(["answered", "silent", "failed", "stopped", "cut", "dropped"])
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const snap = store.inProject(projId, () => store.snapshot())
    const msg = snap.messages.find((m) => m.id === msgId)
    const call = msg?.calls?.find((c) => c.id === seatId)
    const seat = snap.agents.find((a) => a.id === seatId)
    if (call && settled.has(call.state) && !seat?.runId) return call
    await sleep(40)
  }
  throw new Error(\`phase2 等待消息 \${msgId} 结算超时\`)
}

summon.ensureSummon()
const boot2 = cont.serverBootAt()
await sleep(5)

// Join a fresh post-boot seat right after boot so owes.since >= boot2
const postBootSeat = store.inProject(${JSON.stringify(p1.demoProjId)}, () => {
  const s = store.join({ name: "新停滞席", model: "mock", role: "开发", agentName: "mock_worker", uuid: "u_postboot" }).agent
  store.createTask({ as: "human", title: "启动之后才停下的待办", owner: s.name, steps: ["做第一件", "请用户验收"] })
  return s
})

// 1) Guard 9 (real 2-minute startup grace!): shorten firstWait to 30s so at boot2 + 60s
//    postBootSeat has already been quiet for ~60s (>=30s), yet boot2 + 60s < 2m boot grace -> MUST NOT wake!
process.env.BENCH_CONTINUE_FIRST_MS = "30000"
const rBootGrace = cont.sweepContinue(boot2 + 60_000)
assert.equal(rBootGrace.woken.length, 0, "服务器启动后 2 分钟内，即使席位已停满首次门槛也绝不该自动叫醒")
delete process.env.BENCH_CONTINUE_FIRST_MS

// 2) Past 2m boot grace AND 5m quiet (boot2 + 6m):
//    - postBootSeat (stopped AFTER boot2) wakes!
//    - a_preboot (stopped BEFORE boot2: owes.since < boot2) MUST NEVER wake!
//    - a_demo0001 (demo: true) MUST NEVER wake!
const rAfterBoot = cont.sweepContinue(boot2 + 6 * MIN)
assert.ok(rAfterBoot.woken.includes(postBootSeat.id), "启动之后停下的席位在满 5 分钟且过 2 分钟保护期后应正常叫醒")
assert.ok(!rAfterBoot.woken.includes("a_preboot"), "房间启动之前就已经停着的旧欠活绝不该自动叫醒")
assert.ok(!rAfterBoot.woken.includes("a_demo0001"), "演示席位（demo: true）绝不该自动叫醒")
const pbMsg = store.inProject(${JSON.stringify(p1.demoProjId)}, () =>
  store.snapshot().messages.findLast((m) => m.mentions?.includes(postBootSeat.id)),
)
await waitCallSettled(${JSON.stringify(p1.demoProjId)}, pbMsg.id, postBootSeat.id)

// 3) Persistence across restart:
//    - mainSeat (count=2, reported=true) still exposes owes.woken.count === 2
const mainAfterRestart = store.inProject(${JSON.stringify(p1.bizId)}, () =>
  store.snapshot().agents.find((a) => a.id === ${JSON.stringify(p1.mainSeatId)}),
)
assert.equal(mainAfterRestart?.owes?.woken?.count, 2, "重启后已叫 2 次的计数不应丢失")

//    - Touch persistSeat & stopSeat with a post-boot keepalive so owes.since >= boot2 without changing task progressSig,
//      proving persisted count=1 and persisted user-stop both survive restart!
store.inProject(${JSON.stringify(p1.guardProjId)}, () => {
  store.pulse({ agentId: ${JSON.stringify(p1.persistSeatId)}, token: ${JSON.stringify(p1.persistToken)}, keepalive: true })
  store.pulse({ agentId: ${JSON.stringify(p1.stopSeatId)}, token: ${JSON.stringify(p1.stopToken)}, keepalive: true })
})

const T_p6m = ${JSON.stringify(p1.T_persist1)} + 6 * MIN
const rP6m = cont.sweepContinue(T_p6m)
assert.ok(!rP6m.woken.includes(${JSON.stringify(p1.persistSeatId)}), "重启后已叫 1 次的席位未满 20 分钟不应重复当第 1 次叫")
assert.ok(!rP6m.woken.includes(${JSON.stringify(p1.mainSeatId)}) && !rP6m.reported.includes(${JSON.stringify(p1.mainSeatId)}), "重启后已叫满 2 次的席位不应再叫或重报")
assert.ok(!rP6m.woken.includes(${JSON.stringify(p1.stopSeatId)}), "重启后用户点过停止的席位依然不该自动叫")

const T_p21m = ${JSON.stringify(p1.T_persist1)} + 21 * MIN
const rP21m = cont.sweepContinue(T_p21m)
assert.ok(rP21m.woken.includes(${JSON.stringify(p1.persistSeatId)}), "重启后满 20 分钟应准确发出第 2 次叫醒")
const p2Msg = store.inProject(${JSON.stringify(p1.guardProjId)}, () =>
  store.snapshot().messages.findLast((m) => m.mentions?.includes(${JSON.stringify(p1.persistSeatId)})),
)
await waitCallSettled(${JSON.stringify(p1.guardProjId)}, p2Msg.id, ${JSON.stringify(p1.persistSeatId)})

//    - User calls stopSeat again -> clears user-stop flag -> 6m later it CAN auto-wake!
const userRecall = store.inProject(${JSON.stringify(p1.guardProjId)}, () =>
  store.say({ as: "human", text: \`@\${${JSON.stringify(p1.stopSeatName)}} 用户重新叫你接着做\` }).message,
)
await waitCallSettled(${JSON.stringify(p1.guardProjId)}, userRecall.id, ${JSON.stringify(p1.stopSeatId)})
const rStopReenabled = cont.sweepContinue(T_p21m + 6 * MIN)
assert.ok(rStopReenabled.woken.includes(${JSON.stringify(p1.stopSeatId)}), "用户重新叫过之后若再停满 5 分钟，应恢复自动叫醒")
const sWakeMsg = store.inProject(${JSON.stringify(p1.guardProjId)}, () =>
  store.snapshot().messages.findLast((m) => m.mentions?.includes(${JSON.stringify(p1.stopSeatId)})),
)
await waitCallSettled(${JSON.stringify(p1.guardProjId)}, sWakeMsg.id, ${JSON.stringify(p1.stopSeatId)})

const workerLogsAll = readFileSync(${JSON.stringify(workerLogFile)}, "utf8")
  .trim()
  .split("\\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l))
assert.equal(
  workerLogsAll.filter((x) => x.uuid === "u_main").length,
  2,
  "跨重启全过程后，续做员总被叫次数仍必须严格为 2",
)
assert.equal(
  workerLogsAll.filter((x) => x.uuid === "u_preboot").length,
  0,
  "启动前旧欠活席全程唤起次数必须为 0",
)
process.exit(0)
`,
    "utf8",
  )

  execFileSync(process.execPath, ["--no-warnings", phase2Script], {
    cwd: workDir,
    env: {
      ...process.env,
      BENCH_DATA_DIR: dataDir,
      XDG_STATE_HOME: stateDir,
    },
    encoding: "utf8",
  })
} finally {
  rmSync(autoRoot, { recursive: true, force: true })
}

console.log("continue ok")
