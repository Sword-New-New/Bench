#!/usr/bin/env node
// In-process verification that a check never waits for ever (t_96eb4124, lib/summon.ts sweepChecks /
// repickCheck / noteCheckSettled, lib/review.ts reviewAsked, lib/store.ts runBatchCheck):
//   1) a to-do never asked for review is not queued; one queued then moot becomes skipped with a reason;
//   2) a check queued too long goes to another seat, at most twice, then is an error 「没有空着的 AI 来检查」;
//   3) a checker that hits a usage limit hands the check to another seat at once (a fixed checker too);
//      every seat out of quota: it waits for the soonest reset, once, then is an error;
//   4) verdicts reach the desk in one wake after a quiet stretch.
// Isolated temp directories and fake client scripts only (never touches live data or real clients).

import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

const stamp = Date.now().toString(36)
const root = mkdtempSync(path.join(os.tmpdir(), `bench-check-queue-${stamp}-`))
const workDir = path.join(root, "work")
const dataDir = path.join(workDir, "data")
const stateDir = path.join(root, "state")
mkdirSync(dataDir, { recursive: true })
mkdirSync(stateDir, { recursive: true })

const frontLog = path.join(root, "front.jsonl")
const script = (name, lines) => {
  const file = path.join(root, `${name}.mjs`)
  writeFileSync(file, lines.join("\n"), "utf8")
  return file
}
const passScript = script("pass", [`console.log("复验结论：通过\\n看过了\\n没验到的：无")`])
const slowScript = script("slow", [`setTimeout(() => console.log("【本轮结束】慢慢做完"), 6000)`])
const limitScript = script("limit", [
  `console.log("You've hit your usage limit · resets 3pm (Asia/Shanghai)")`,
  `process.exit(1)`,
])
const frontScript = script("front", [
  `import { appendFileSync } from "node:fs"`,
  `appendFileSync(${JSON.stringify(frontLog)}, JSON.stringify({ prompt: process.argv[3] || "" }) + "\\n", "utf8")`,
  `console.log("【本轮结束】前台收到")`,
])
const kinds = {
  mock_pass: passScript,
  mock_pass2: passScript,
  mock_slow: slowScript,
  mock_limit: limitScript,
  mock_limit2: limitScript,
  mock_front: frontScript,
}
writeFileSync(
  path.join(workDir, "agents.json"),
  JSON.stringify(
    { agents: Object.entries(kinds).map(([name, file]) => ({ name, command: `node '${file}' {uuid} {text}`, reply: "stdout" })) },
    null,
    2,
  ),
  "utf8",
)

const repoRootUrl = pathToFileURL(process.cwd() + "/").href
const aliasHref = pathToFileURL(path.join(process.cwd(), "scripts/ts-alias.mjs")).href
const phase = path.join(root, "phase.mjs")
writeFileSync(
  phase,
  `
import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { register } from "node:module"
register(${JSON.stringify(aliasHref)}, import.meta.url)
const root = ${JSON.stringify(repoRootUrl)}
const store = await import(new URL("lib/store.ts", root).href)
const summon = await import(new URL("lib/summon.ts", root).href)
const review = await import(new URL("lib/review.ts", root).href)
const owes = await import(new URL("lib/owes.ts", root).href)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const MIN = 60_000
summon.ensureSummon()

const desk = store.createProject({ as: "human", front: true }).project
store.inProject(desk.id, () => store.join({ name: "前台", model: "mock", role: "前台", agentName: "mock_front", uuid: "u_front" }))

let n = 0
function room(name, check = "auto") {
  const project = store.createProject({ as: "human", name }).project
  if (check) store.updateProject(project.id, { check })
  return project
}
function seat(project, name, kind) {
  return store.inProject(project.id, () =>
    store.join({ name, model: "mock", role: "开发", agentName: kind, uuid: \`u_\${kind}_\${++n}\` }),
  )
}
// A to-do with its work done and review asked (unless ask is false).
function done(project, owner, title, ask = true) {
  return store.inProject(project.id, () => {
    const as = { agentId: owner.agent.id, token: owner.token }
    const task = store.createTask({ ...as, title, owner: owner.agent.name, steps: ["做完", "请用户验收"] }).task
    store.actOnTask({ ...as, taskId: task.id, action: "step", step: 1, state: "done", note: "完" })
    if (ask) store.actOnTask({ ...as, taskId: task.id, action: "review", note: "打开页面点按钮就能看到" })
    return task.id
  })
}
// The check is handed to a seat right after the request is saved (setImmediate).
async function asked(project, owner, title) {
  const id = done(project, owner, title)
  await until("排到席位上", () => checkOf(project, id)?.by || checkOf(project, id)?.state !== "queued")
  return id
}
const checkOf = (project, id) => store.inProject(project.id, () => store.snapshot().tasks.find((t) => t.id === id)?.check)
async function until(what, fn, ms = 10_000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const got = fn()
    if (got) return got
    await sleep(50)
  }
  throw new Error("等不到：" + what)
}

// ---- 1) never asked for review: not queued; queued then moot: skipped ----
{
  const p = room("没请验收房")
  const owner = seat(p, "负责人甲", "mock_slow")
  seat(p, "检查员甲", "mock_pass")
  const id = done(p, owner, "只剩验收没请", false)
  const t = store.inProject(p.id, () => store.snapshot().tasks.find((x) => x.id === id))
  assert.ok(review.awaitingReview(t) && !review.reviewAsked(t), "只剩验收一步、没请验收的待办应算等验收但没请")
  assert.equal(review.signLane(t).why, "负责人还没请验收", "批量卡片对没请验收的应写「负责人还没请验收」")
  assert.ok(owes.owedTasks(owner.agent.id, store.inProject(p.id, () => store.snapshot().tasks)).some((x) => x.id === id), "没请验收的仍算负责人欠的活，房间会叫它来请验收")
  const batch = store.runBatchCheck(p.name)
  assert.equal(batch.queued, 0, "没请验收的待办不该排去检查")
  assert.ok(batch.skipped.some((s) => s.taskId === id && s.why === "负责人还没请验收"), "批量检查应写明负责人还没请验收：" + JSON.stringify(batch))
  assert.equal(checkOf(p, id), undefined, "没请验收的待办不该带检查")
  assert.throws(() => store.inProject(p.id, () => store.actOnTask({ as: "human", taskId: id, action: "check" })), /还没请验收/, "手动检查也应拒绝")

  // Queued behind a paused checker, then sent back: the sweep marks it skipped.
  const q = room("排着又不用查房", "")
  const owner2 = seat(q, "负责人乙", "mock_slow")
  const hold = seat(q, "检查员乙", "mock_pass")
  store.inProject(q.id, () => store.setChecker(hold.agent.id, true))
  store.inSeat(hold.agent.id, () => summon.pauseQueue(hold.agent.id, true))
  const id2 = await asked(q, owner2, "排着又被打回")
  assert.equal(checkOf(q, id2)?.state, "queued", "请验收后应排上检查")
  store.inProject(q.id, () => store.actOnTask({ as: "human", taskId: id2, action: "reject", note: "先别查，改一下" }))
  summon.sweepChecks()
  const moot = checkOf(q, id2)
  assert.equal(moot?.state, "skipped", "排着但不该查了的检查应落成 skipped，实际 " + JSON.stringify(moot))
  assert.match(moot.note ?? "", /还没请验收/, "skipped 要写原因")
  store.inSeat(hold.agent.id, () => summon.pauseQueue(hold.agent.id, false))
}

// ---- 2) queued too long: another seat, at most twice, then an error ----
{
  const p = room("排久了换人房")
  const owner = seat(p, "负责人丙", "mock_slow")
  const hold = seat(p, "卡住的检查员", "mock_pass")
  const good = seat(p, "空着的检查员", "mock_pass2")
  store.inProject(p.id, () => store.setChecker(hold.agent.id, true))
  store.inSeat(hold.agent.id, () => summon.pauseQueue(hold.agent.id, true))
  const id = await asked(p, owner, "排久了要换人")
  assert.equal(checkOf(p, id)?.by, hold.agent.id, "先排在指定的检查员上")
  summon.sweepChecks(Date.now() + 5 * MIN)
  assert.equal(checkOf(p, id)?.by, hold.agent.id, "没到 15 分钟不该换人")
  summon.sweepChecks(Date.now() + 16 * MIN)
  const passed = await until("换人后查完", () => (checkOf(p, id)?.state === "passed" ? checkOf(p, id) : null))
  assert.equal(passed.by, good.agent.id, "排久了应换到空着的席位上查")
  assert.equal(passed.repicks, 1, "换过一次")
  store.inSeat(hold.agent.id, () => summon.pauseQueue(hold.agent.id, false))

  // Every seat busy for long: two moves, then an error, and off every queue.
  const r = room("一直没人空房")
  const owner2 = seat(r, "负责人丁", "mock_pass")
  const busy = [seat(r, "忙甲", "mock_slow"), seat(r, "忙乙", "mock_slow"), seat(r, "忙丙", "mock_slow")]
  store.inProject(r.id, () => store.say({ as: "human", text: "@忙甲 @忙乙 @忙丙 都去做点事" }))
  await until("三个席位都忙起来", () => busy.every((s) => store.inProject(r.id, () => store.snapshot().agents.find((a) => a.id === s.agent.id)?.runId)))
  const id2 = await asked(r, owner2, "一直没人空")
  const seen = new Set([checkOf(r, id2)?.by])
  for (let i = 0; i < 2; i++) {
    summon.sweepChecks(Date.now() + 16 * MIN)
    assert.equal(checkOf(r, id2)?.state, "queued", "前两次排久了应换人重排")
    seen.add(checkOf(r, id2)?.by)
  }
  assert.equal(seen.size, 3, "每次换的应是没排过的席位：" + [...seen].join(","))
  summon.sweepChecks(Date.now() + 16 * MIN)
  const failed = checkOf(r, id2)
  assert.equal(failed?.state, "error", "换过两次还没人查应落成 error，实际 " + JSON.stringify(failed))
  assert.equal(failed.note, "没有空着的 AI 来检查")
  await sleep(6500)
  assert.equal(checkOf(r, id2)?.state, "error", "落成 error 以后忙完的席位不该再接着查")
}

// ---- 3) the checker hits a usage limit ----
{
  const p = room("撞额度换人房")
  const owner = seat(p, "负责人戊", "mock_slow")
  const lim = seat(p, "撞额度的检查员", "mock_limit")
  const good = seat(p, "有额度的检查员", "mock_pass")
  store.inProject(p.id, () => store.setChecker(lim.agent.id, true))
  const id = done(p, owner, "撞额度要换人")
  const passed = await until("撞额度后换人查完", () => (checkOf(p, id)?.state === "passed" ? checkOf(p, id) : null))
  assert.equal(passed.by, good.agent.id, "检查人撞额度应马上换到有额度的席位，指定的检查人也一样")
  assert.ok(store.inProject(p.id, () => store.snapshot().messages.some((m) => m.limited?.agentId === lim.agent.id)), "撞额度要照常出额度卡")

  // Every seat out of quota: wait for the soonest reset, once.
  const q = room("全撞额度房")
  const owner2 = seat(q, "负责人己", "mock_slow")
  const lim2 = seat(q, "撞额度甲", "mock_limit2")
  seat(q, "撞额度乙", "mock_limit2")
  store.inProject(q.id, () => store.setChecker(lim2.agent.id, true))
  const id2 = done(q, owner2, "全都没额度")
  const waiting = await until("等重置", () => (checkOf(q, id2)?.waitUntil ? checkOf(q, id2) : null))
  assert.equal(waiting.state, "queued", "全都被额度拦着时应排着等重置，不是落成 error")
  assert.equal(waiting.waitUntil, store.earliestLimitReset(), "应等到最早的重置时间")
  summon.sweepChecks(Date.now() + 5 * MIN)
  assert.equal(checkOf(q, id2)?.state, "queued", "没到重置时间不该动")
  summon.sweepChecks(waiting.waitUntil + 1000)
  const gone = checkOf(q, id2)
  assert.equal(gone?.state, "error", "重置后再排一次还是没人，应落成 error：" + JSON.stringify(gone))
  assert.equal(gone.note, "没有空着的 AI 来检查")
}

// ---- 4) verdicts reach the desk in one go ----
{
  const p = room("攒着通知房")
  const owner = seat(p, "负责人庚", "mock_slow")
  seat(p, "检查员庚", "mock_pass")
  const a = done(p, owner, "第一件")
  await until("第一件查完", () => checkOf(p, a)?.state === "passed")
  await sleep(500)
  const b = done(p, owner, "第二件")
  await until("第二件查完", () => checkOf(p, b)?.state === "passed")
  const mine = () =>
    (existsSync(${JSON.stringify(frontLog)}) ? readFileSync(${JSON.stringify(frontLog)}, "utf8").trim().split("\\n") : [])
      .filter(Boolean)
      .map((l) => JSON.parse(l).prompt)
      .filter((t) => t.includes("攒着通知房"))
  await sleep(4000)
  const told = mine()
  assert.equal(told.length, 1, "两件结论应攒成一次叫前台，实际 " + told.length + " 次")
  assert.ok(told[0].includes("通过 2 件"), "一次说全：" + told[0].slice(0, 300))
}

process.exit(0)
`,
  "utf8",
)

try {
  execFileSync(process.execPath, ["--no-warnings", phase], {
    cwd: workDir,
    env: {
      ...process.env,
      BENCH_DATA_DIR: dataDir,
      XDG_STATE_HOME: stateDir,
      BENCH_CHECK_QUIET_MS: "1500",
      BENCH_CHECK_QUIET_MAX_MS: "8000",
      BENCH_CHECK_SWEEP_MS: "3600000",
    },
    stdio: "inherit",
  })
} finally {
  rmSync(root, { recursive: true, force: true })
}
console.log("check queue ok")
