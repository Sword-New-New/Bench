#!/usr/bin/env node
// The room summary writes itself (t_df9c0fc7, lib/summary-auto.ts): in-process,
// in a temp data dir, with fake clients only (never the live room or a real model).

import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

const root = mkdtempSync(path.join(os.tmpdir(), "bench-summary-auto-"))
const workDir = path.join(root, "work")
const dataDir = path.join(workDir, "data")
const stateDir = path.join(root, "state")
mkdirSync(dataDir, { recursive: true })
mkdirSync(stateDir, { recursive: true })

const writer = path.join(root, "writer.mjs")
const failer = path.join(root, "failer.mjs")
const slow = path.join(root, "slow.mjs")
writeFileSync(writer, `console.log("## 结论\\n- 假摘要：大家在做测试\\n\\n## 进行中\\n- 无\\n\\n## 待定\\n- 无")\n`)
writeFileSync(failer, `process.stderr.write("something broke\\n"); process.exit(1)\n`)
writeFileSync(slow, `setTimeout(() => console.log("【本轮结束】慢活干完了"), 2500)\n`)
writeFileSync(
  path.join(workDir, "agents.json"),
  JSON.stringify({
    agents: [
      { name: "mock_writer", command: `node '${writer}' {uuid} {text}`, reply: "stdout" },
      { name: "mock_failer", command: `node '${failer}' {uuid} {text}`, reply: "stdout" },
      { name: "mock_slow", command: `node '${slow}' {uuid} {text}`, reply: "stdout" },
    ],
  }),
)

const repo = pathToFileURL(process.cwd() + "/").href
const alias = pathToFileURL(path.join(process.cwd(), "scripts/ts-alias.mjs")).href
const phase = path.join(root, "phase.mjs")

writeFileSync(
  phase,
  `
import assert from "node:assert/strict"
import { register } from "node:module"
register(${JSON.stringify(alias)}, import.meta.url)
const root = ${JSON.stringify(repo)}
const store = await import(new URL("lib/store.ts", root).href)
const summon = await import(new URL("lib/summon.ts", root).href)
const cont = await import(new URL("lib/continue.ts", root).href)
const auto = await import(new URL("lib/summary-auto.ts", root).href)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const MIN = 60_000
const ok = (cond, label) => { assert.ok(cond, label); console.log("ok  " + label) }
const snap = (id) => store.inProject(id, () => store.snapshot())
const fill = (id) => store.inProject(id, () => { for (let i = 0; i < 6; i += 1) store.say({ as: "human", text: "聊点东西 " + "字".repeat(1900) }) })
let uuids = 0
const seat = (id, name, agentName, role = "开发") =>
  store.inProject(id, () => store.join({ name, model: "mock", role, agentName, uuid: "u_" + (uuids += 1) }).agent)
const idle = async (id, seatId) => {
  for (let i = 0; i < 200; i += 1) {
    const s = snap(id)
    const a = s.agents.find((x) => x.id === seatId)
    if (!s.summaryWriter && !a?.runId) return
    await sleep(50)
  }
  throw new Error("等席位空下来超时")
}
const roomLines = (id, part) => snap(id).messages.filter((m) => m.authorId === "room" && m.text.includes(part))

summon.ensureSummon()
const bootAt = auto.summaryAutoBootAt()
let T = bootAt

// --- 1. One project: picks the 「摘要」 seat, writes, one short line ---
const p1 = store.createProject({ as: "human", name: "摘要一" }).project.id
const a1 = seat(p1, "甲", "mock_writer")
const b1 = seat(p1, "乙", "mock_writer", "写房间摘要")
const lastWriter = seat(p1, "丙", "mock_writer")
fill(p1)
ok(snap(p1).summaryDue, "聊满一万字摘要到期")
ok(!snap(p1).summaryHeld, "房间还没接手时卡片照常出现")

T = bootAt + 60_000
let r = auto.sweepSummaryAuto(T)
ok(r.started.length === 0, "房间启动后 2 分钟内不自动叫")

T = bootAt + 3 * MIN
r = auto.sweepSummaryAuto(T)
ok(r.started.includes(p1), "到期后房间自己找人写")
ok(snap(p1).summaryWriter === b1.id, "名字或职责里带「摘要」的优先")
ok(snap(p1).summaryHeld, "房间在办时不出「找谁写」的卡")
await idle(p1, b1.id)
T += 30_000
r = auto.sweepSummaryAuto(T)
ok(r.written.includes(p1), "写好了记成写成")
const done1 = roomLines(p1, "房间摘要更新了")
ok(done1.length === 1 && done1[0].text.length <= 30 && done1[0].text.includes("乙"), "群里只多一行 30 字内的小字，写明谁写的：" + (done1[0]?.text ?? ""))
ok(!snap(p1).summaryDue && !snap(p1).summaryHeld, "写好后不再到期")
ok(snap(p1).summary?.by === "乙", "摘要记在写的人名下")

// --- 2. Never cut short a seat at work; later, the last writer goes first ---
const p2 = store.createProject({ as: "human", name: "摘要二" }).project.id
const busy = seat(p2, "忙人", "mock_slow")
store.inProject(p2, () => store.say({ as: "human", text: "@忙人 先干活" }))
await sleep(300)
ok(snap(p2).agents.find((a) => a.id === busy.id)?.runId, "忙人正在干活")
fill(p2)
T += 4 * MIN
r = auto.sweepSummaryAuto(T)
ok(!r.started.includes(p2), "唯一的席位在干活：不打断，等它")
ok(snap(p2).summaryHeld && !snap(p2).summaryWriter, "等的时候卡片先不出")
await idle(p2, busy.id)
T += 1 * MIN
r = auto.sweepSummaryAuto(T)
ok(r.started.includes(p2), "空下来以后再叫它写")
await idle(p2, busy.id)
T += 30_000
auto.sweepSummaryAuto(T)

// --- 3. A failed try goes to someone else once; then the card, and no more ---
const p3 = store.createProject({ as: "human", name: "摘要三" }).project.id
const f1 = seat(p3, "摘要甲", "mock_failer")
const f2 = seat(p3, "摘要乙", "mock_failer")
const f3 = seat(p3, "摘要丙", "mock_writer")
fill(p3)
T += 4 * MIN
r = auto.sweepSummaryAuto(T)
ok(r.started.includes(p3), "第一次叫")
const first = auto.summaryAutoEntry(p3).tries[0].agentId
await idle(p3, first)
T += 4 * MIN
r = auto.sweepSummaryAuto(T)
ok(r.failed.includes(p3) && r.started.includes(p3), "没写成换一个人再试一次")
const second = auto.summaryAutoEntry(p3).tries[1].agentId
ok(second !== first, "第二次换了人")
await idle(p3, second)
const third = [f1, f2, f3].find((s) => s.id !== first && s.id !== second)
for (let i = 0; i < 4; i += 1) {
  T += 4 * MIN
  r = auto.sweepSummaryAuto(T)
  ok(!r.started.includes(p3), "同一次到期最多叫两个人（第 " + (i + 1) + " 轮）")
}
ok(auto.summaryAutoEntry(p3).tries.length === 2, "叫过的人记下来，一共两次")
const s3 = snap(p3)
ok(s3.summaryDue && !s3.summaryHeld, "两次都没成：卡片回来了")
ok(!s3.agents.find((a) => a.id === third.id)?.runId, "第三个人没被叫")

// --- 4. Restart: what was tried is remembered ---
globalThis.__benchSummaryAuto.cache = undefined
T += 4 * MIN
r = auto.sweepSummaryAuto(T)
ok(!r.started.includes(p3), "重启后不重复叫同一次到期")

// --- 5. Skip: the user's 「跳过」 ends this due ---
store.inProject(p3, () => store.summaryAction({ as: "human", action: "skip" }))
T += 4 * MIN
r = auto.sweepSummaryAuto(T)
ok(!r.started.includes(p3) && !snap(p3).summaryDue, "用户点了跳过，这一次不叫")

// --- 6. Nobody the room can ask: no hold, the card as before ---
const p4 = store.createProject({ as: "human", name: "摘要四" }).project.id
store.inProject(p4, () => store.join({ name: "没会话", model: "mock", role: "开发" }))
const stopped = seat(p4, "被停的", "mock_writer")
cont.markSeatUserStopped(stopped.id)
fill(p4)
T += 4 * MIN
r = auto.sweepSummaryAuto(T)
ok(!r.started.includes(p4), "没有叫得醒的席位：不叫")
ok(!snap(p4).summaryHeld, "这时卡片照常出现")
ok(!snap(p4).agents.find((a) => a.id === stopped.id)?.runId, "用户点过停止的席位不挑")

// --- 7. Due before this start and nobody spoke since: left alone ---
const p5 = store.createProject({ as: "human", name: "摘要五" }).project.id
seat(p5, "老席位", "mock_writer")
fill(p5)
const p6 = store.createProject({ as: "human", name: "摘要六" }).project.id
seat(p6, "老席位二", "mock_writer")
fill(p6)
const p7 = store.createProject({ as: "human", name: "摘要七" }).project.id
seat(p7, "老席位三", "mock_writer")
fill(p7)
await sleep(5)
globalThis.__benchSummaryAuto.bootAt = Date.now()
const boot2 = globalThis.__benchSummaryAuto.bootAt
T = Math.max(T, boot2) + 4 * MIN
r = auto.sweepSummaryAuto(T)
ok(![p5, p6, p7].some((id) => r.started.includes(id)), "启动前就到期、启动后没人说过话的不叫")
ok(!snap(p5).summaryHeld, "这种照旧出卡")

// --- 8. Several due at once: one project at a time, minutes apart ---
for (const id of [p5, p6, p7]) store.inProject(id, () => store.say({ as: "human", text: "回来了" }))
T += 4 * MIN
r = auto.sweepSummaryAuto(T)
ok(r.started.length === 1, "一次只叫一个项目：" + r.started.length)
T += 30_000
r = auto.sweepSummaryAuto(T)
ok(r.started.length === 0, "隔开几分钟才叫下一个")
for (const id of [p5, p6, p7]) {
  const s = snap(id)
  if (s.summaryWriter) await idle(id, s.summaryWriter)
}
T += 4 * MIN
r = auto.sweepSummaryAuto(T)
ok(r.started.length === 1, "过了间隔再叫下一个")
for (const id of [p5, p6, p7]) {
  const s = snap(id)
  if (s.summaryWriter) await idle(id, s.summaryWriter)
}

// --- 9. Nobody free for half an hour: the card comes back ---
const p8 = store.createProject({ as: "human", name: "摘要八" }).project.id
const busy8 = seat(p8, "一直忙", "mock_slow")
fill(p8)
store.inProject(p8, () => store.say({ as: "human", text: "@一直忙 干活" }))
await sleep(300)
T += 4 * MIN
r = auto.sweepSummaryAuto(T)
ok(!r.started.includes(p8) && snap(p8).summaryHeld, "人在忙：先等")
T += 31 * MIN
r = auto.sweepSummaryAuto(T)
ok(r.gaveUp.includes(p8) && !snap(p8).summaryHeld, "半小时没找到人：才出原来那张卡")
await idle(p8, busy8.id)
T += 4 * MIN
r = auto.sweepSummaryAuto(T)
ok(!r.started.includes(p8), "出卡以后这一次不再自动叫")

// --- 10. Asking by hand still works ---
store.inProject(p8, () => summon.requestSummary(busy8.id))
ok(snap(p8).summaryWriter === busy8.id, "手动找人写照旧能用")
await idle(p8, busy8.id)

// --- 11. The last writer before a seat that just spoke ---
const p9 = store.createProject({ as: "human", name: "摘要九" }).project.id
seat(p9, "常客", "mock_writer")
seat(p9, "上回写的", "mock_writer")
store.inProject(p9, () => store.saveSummary("## 结论\\n- 旧的", "上回写的"))
ok(store.inProject(p9, () => auto.summaryCandidates(store.snapshot()))[0]?.name === "上回写的", "没有带「摘要」的席位时，上次写摘要的优先")

void a1
void lastWriter
console.log("summary-auto ok")
process.exit(0)
`,
)

try {
  const out = execFileSync(process.execPath, ["--no-warnings", phase], {
    cwd: workDir,
    env: { ...process.env, BENCH_DATA_DIR: dataDir, XDG_STATE_HOME: stateDir, BENCH_URL: "" },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  })
  process.stdout.write(out)
} catch (error) {
  process.stdout.write(String(error.stdout ?? ""))
  console.error("summary-auto FAILED")
  process.exitCode = 1
} finally {
  rmSync(root, { recursive: true, force: true })
}
