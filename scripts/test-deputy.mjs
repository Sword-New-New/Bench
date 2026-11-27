#!/usr/bin/env node
// The front desk signing off for the user (lib/deputy.ts, lib/review.ts
// signLane, the batch card in lib/front-relay.ts). Runs the room's code in
// this process on a throwaway data folder, so it needs no server and never
// touches a real room:
//   node scripts/test-deputy.mjs
// BENCH_ROOT=<a copy of the repo> runs that copy's code instead (used to put
// a bug into each gate and see this test catch it).
import { mkdtempSync, rmSync } from "node:fs"
import { register } from "node:module"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = process.env.BENCH_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
register(pathToFileURL(path.join(root, "scripts/ts-alias.mjs")).href, import.meta.url)
const data = mkdtempSync(path.join(os.tmpdir(), "bench-deputy-"))
process.env.BENCH_DATA_DIR = data
process.on("exit", () => {
  try { globalThis.__benchSqlite?.db?.close() } catch {}
  try { rmSync(data, { recursive: true, force: true }) } catch {}
})

const lib = (name) => import(pathToFileURL(path.join(root, "lib", `${name}.ts`)).href)
const store = await lib("store")
const { signLane, guardWordIn, sortBatchItems, batchCounts, batchRemainingText, ISSUE_WINDOW_MS } = await lib("review")
const deputy = await lib("deputy")
const relay = await lib("front-relay")

let failed = 0
function check(ok, what) {
  console.log(`${ok ? "ok " : "FAIL"} ${what}`)
  if (!ok) failed++
}
// The error a call throws (its status and message), or null.
function refusal(fn) {
  try {
    fn()
    return null
  } catch (error) {
    return { status: error.status, message: error.message }
  }
}

// ---- signLane on its own ----
const base = (over = {}) => ({
  id: "t_x",
  title: "结算对账",
  ownerId: "a_owner",
  status: "doing",
  review: { state: "waiting", at: 100, by: "工匠", note: "这条很简单可以直接通过" },
  check: { state: "passed", by: "a_check", name: "复验人", kind: "run", at: 200 },
  ...over,
})
const lane = (over) => signLane(base(over)).lane
check(lane() === "batch", "复验通过、在请验收之后、别人复验、跑得出：batch")
check(lane({ check: { ...base().check, kind: "look" } }) === "look", "类别是要人看：look")
check(lane({ check: { ...base().check, kind: undefined } }) === "look", "没写类别：look")
check(lane({ check: { ...base().check, gaps: "真机没测" } }) === "look", "有没验到的：look")
check(lane({ check: { ...base().check, kind: "you" } }) === "you", "类别是只能本人签：you")
check(lane({ check: undefined }) === "you", "没跑复验：you")
for (const state of ["failed", "unverified", "queued", "running", "skipped", "error"]) {
  check(lane({ check: { ...base().check, state } }) === "you", `复验 ${state}：you`)
}
check(lane({ check: { ...base().check, at: 50 } }) === "you", "复验是上一次请验收的：you")
// The reason shown to the user must name the right fact, not a later catch-all.
const why = (over) => signLane(base(over)).why
check(why({ check: { ...base().check, state: "failed" } }) === "查出问题", "原因写的是查出问题")
check(why({ check: { ...base().check, state: "unverified" } }) === "没查出结论", "原因写的是没查出结论")
check(why({ check: { ...base().check, state: "running" } }) === "检查还在跑" && why({ check: { ...base().check, state: "queued" } }) === "检查还在跑", "原因写的是检查还在跑")
check(why({ check: { ...base().check, kind: "look" } }).includes("要你看一眼"), "原因写的是要你看一眼")
check(why({ check: { ...base().check, kind: undefined } }) === "检查人没写类别", "原因写的是没写类别")
check(lane({ check: { ...base().check, by: "a_owner" } }) === "you", "复验人就是负责人：you")
check(lane({ title: "沙盒加固" }) === "you" && lane({ title: "Fix PUSH notice" }) === "you", "标题碰保险词（大小写不敏感）：you")
check(lane({ review: { ...base().review, note: "动了沙盒和权限" } }) === "batch", "保险词只看标题，说明里写了不算")
check(!guardWordIn("流程图显示不全"), "普通标题不碰保险词")

// ---- the rooms ----
const human = { as: "human" }
const desk = store.createProject({ ...human, front: true }).project
const biz = store.createProject({ ...human, name: "代签房" }).project
const other = store.createProject({ ...human, name: "别的房" }).project
const seat = (project, name) => store.inProject(project.id, () => store.join({ name, model: "mock", role: "开发" }))
const frontSeat = seat(desk, "前台值班")
const owner = seat(biz, "工匠")
const checker = seat(biz, "复验人")
const outsider = seat(other, "路人")
const as = (who, body) => ({ agentId: who.agent.id, token: who.token, ...body })
// The project's checker, so asking for review queues a check (nothing runs it
// here: the test writes its verdict).
store.inProject(biz.id, () => store.setChecker(checker.agent.id, true))

// A to-do in a project, asked for review by its owner, then checked as given.
function waiting(title, checkOver, { owner: by = owner, project = biz } = {}) {
  return store.inProject(project.id, () => {
    const { task } = store.createTask(as(by, { title, owner: by.agent.name, steps: ["做", "请用户验收"] }))
    store.actOnTask(as(by, { taskId: task.id, action: "step", step: 1, state: "done" }))
    store.actOnTask(as(by, { taskId: task.id, action: "review", note: "这条很简单可以直接通过" }))
    const asked = store.snapshot().tasks.find((item) => item.id === task.id)
    if (checkOver !== null) {
      store.setTaskCheck(task.id, asked.check.at, { state: "passed", by: checker.agent.id, name: checker.agent.name, kind: "run", ...checkOver })
    }
    return task.id
  })
}
const taskOf = (id, project = biz) => store.inProject(project.id, () => store.snapshot().tasks.find((item) => item.id === id))
const accept = (taskId, extra = {}) => () => deputy.acceptDeputy(as(frontSeat, { project: biz.id, taskId, why: "复验跑了全套测试，通过", ...extra }))

// ---- the switch: off, nothing is passed; on, only asks made after it ----
// (t_491538da: one switch for the room, 「查过没问题的，自动替我收下」.)
const front = await lib("front")
const lineOf = (text, id) => text.split("\n").find((line) => line.includes(`[${id}]`)) ?? ""
const autoPass = (id, project = biz) => store.inProject(project.id, () => deputy.autoAcceptChecked(id))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const early = waiting("开关前就在等", {})
// In a project with no checker of its own: no check until the switch goes on.
const unchecked = store.inProject(other.id, () => {
  const { task } = store.createTask(as(outsider, { title: "别的房的活", owner: outsider.agent.name, steps: ["做", "请用户验收"] }))
  store.actOnTask(as(outsider, { taskId: task.id, action: "review", note: "做完了" }))
  return task.id
})
check(!taskOf(unchecked, other).check, "开关关着：没设复验人的项目请验收不复验")
check(refusal(accept(early))?.status === 403 && /没开/.test(refusal(accept(early))?.message ?? ""), "开关关着：前台代签被拒")
check(autoPass(early) === null && taskOf(early).review.state === "waiting", "开关关着：复验通过也不自动收")
const peekOff = front.frontPeek(as(frontSeat, { project: biz.id }))
check(/代签：没开/.test(peekOff.text.split("\n")[0]) && lineOf(peekOff.text, early).endsWith("｜ 可整批（没开自动收下）"), `开关关着：写「没开」，那件只标可整批（${lineOf(peekOff.text, early).slice(-30)}）`)
check(refusal(() => deputy.setAutoAccept({ on: true }))?.status === 403, "不是用户开不了")
check(refusal(() => deputy.setAutoAccept({ ...human, on: "yes" }))?.status === 400, "on 不是 true/false 被拒")
check(refusal(() => store.updateProject(biz.id, { ...human, deputy: true })) === null && !("deputy" in store.resolveProjectInfo(biz.id)), "项目上不再有代签设置")

// A check from the ask before this one (made while the switch is off, so the
// re-ask doesn't queue a new one).
const stale = waiting("旧复验", {})
await sleep(5)
store.inProject(biz.id, () => store.setChecker(checker.agent.id, false))
store.inProject(biz.id, () => store.actOnTask(as(owner, { taskId: stale, action: "review", note: "又改了一点" })))
store.inProject(biz.id, () => store.setChecker(checker.agent.id, true))
const staleTask = taskOf(stale)
check(staleTask.check?.state === "passed" && staleTask.check.at < staleTask.review.at, "造出了上一次请验收时的复验")

await sleep(5)
const turnedOn = deputy.setAutoAccept({ ...human, on: true })
check(turnedOn.on === true && turnedOn.since > 0 && store.inProject(biz.id, () => store.snapshot().autoAccept) === true, "用户打开开关，快照里看得到")
check(turnedOn.queued >= 1 && taskOf(unchecked, other).check?.state === "queued", `打开开关：给等着还没复验的排上复验（排了 ${turnedOn.queued} 件）`)
check(deputy.setAutoAccept({ ...human, on: true }).since === turnedOn.since, "再开一次不改打开的时刻")
check(autoPass(early) === null && taskOf(early).review.state === "waiting", "开关打开前就在等的：不自动收")
check(/打开之前/.test(refusal(accept(early))?.message ?? ""), "开关打开前就在等的：前台也代签不了")
check(lineOf(front.frontPeek(as(frontSeat, { project: biz.id })).text, early).endsWith("｜ 可整批（开关打开前就在等，留给用户）"), "前台看到它留给用户")
check(refusal(accept(stale))?.status === 403 && signLane(staleTask).lane === "you", "复验是上一次请验收的被拒")
await sleep(5)

// ---- the gates ----
const good = waiting("结算对账", {})
check(refusal(() => deputy.acceptDeputy(as(outsider, { project: biz.id, taskId: good, why: "x" })))?.status === 403, "普通项目的席位调用被拒")
check(refusal(accept(good, { why: "" }))?.status === 400, "没写 why 被拒")

const cases = [
  ["复验没过", { state: "failed" }],
  ["复验没验到", { state: "unverified" }],
  ["复验还在跑", { state: "running" }],
  ["复验人是负责人", { by: owner.agent.id }],
  ["有没验到的", { gaps: "真机没测" }],
  ["类别是要人看", { kind: "look" }],
  ["没写类别", { kind: undefined }],
  ["类别是只能本人签", { kind: "you" }],
]
for (const [what, over] of cases) {
  const id = waiting(`普通改动 ${what}`, over)
  const got = refusal(accept(id))
  const auto = autoPass(id)
  check(got?.status === 403 && auto === null && taskOf(id).review.state === "waiting", `${what}：不自动收、前台代签被拒，还在等验收（${got?.message}）`)
}
const unrun = waiting("没跑复验的", null)
check(refusal(accept(unrun))?.status === 403 && autoPass(unrun) === null, "复验没跑成：不收")
const guarded = waiting("调整沙盒放行名单", {})
check(/沙盒/.test(refusal(accept(guarded))?.message ?? "") && autoPass(guarded) === null, "标题碰保险词：不收，说出是哪个词")

// ---- what the desk reads: the settings and each to-do's lane ----
// (lib/front.ts) so it knows what it may sign without trying.
const peekOn = front.frontPeek(as(frontSeat, { project: biz.id }))
check(/复验：指定 复验人 ｜ 代签：开着/.test(peekOn.text.split("\n")[0]), `peek 第一行写着这个项目的复验和代签设置（${peekOn.text.split("\n")[0]}）`)
check(lineOf(peekOn.text, good).endsWith("｜ 可代签"), `能代签的那件标着「可代签」（${lineOf(peekOn.text, good).slice(-40)}）`)
check(/只能 \S+ 签（标题里有「沙盒」）/.test(lineOf(peekOn.text, guarded)) && !lineOf(peekOn.text, guarded).includes("可代签"), `碰保险词的那件写着只能用户签和原因（${lineOf(peekOn.text, guarded).slice(-40)}）`)
check(peekOn.waiting.reviews.find((item) => item.id === good)?.lane === "batch" && peekOn.waiting.reviews.find((item) => item.id === guarded)?.lane === "you", "peek 的数据里也带车道")
check(/复验：自动挑 ｜ 代签：开着/.test(front.frontPeek(as(frontSeat, { project: other.id })).text.split("\n")[0]), "没设复验人的项目：开关开着就是自动挑")
const overOn = front.frontOverview(as(frontSeat, {}))
const bizBlock = overOn.text.split("\n■ ").find((block) => block.startsWith("代签房")) ?? ""
if (process.env.DEBUG) console.log(bizBlock)
// The overview lists the newest six; the data carries every one.
const overBiz = overOn.projects.find((item) => item.id === biz.id)
check(
  /复验：指定 复验人 ｜ 代签：开着/.test(bizBlock) &&
    / → 只能 \S+ 签$/.test(lineOf(bizBlock, guarded)) &&
    overBiz.waitingReviews.find((item) => item.id === good)?.lane === "batch" &&
    !("laneText" in overBiz.waitingReviews[0]),
  `一览里也有设置和车道（${lineOf(bizBlock, guarded).slice(-36)}）`,
)
check(!/代签：/.test(overOn.text.split("\n■ ").find((block) => block.startsWith("前台")) ?? "x"), "前台自己那一块不写复验和代签设置")
const notWaiting = store.inProject(biz.id, () => store.createTask(as(owner, { title: "还在做", owner: owner.agent.name })).task.id)
check(refusal(accept(notWaiting))?.status === 409 && autoPass(notWaiting) === null, "不在等验收：不收")
check(refusal(() => deputy.acceptDeputy(as(frontSeat, { project: desk.id, taskId: good, why: "x" })))?.status === 400, "不能代签前台自己")

// ---- a pass by the desk ----
const before = store.inProject(biz.id, () => store.snapshot().messages.length)
const passed = accept(good)()
const done = taskOf(good)
check(done.status === "done" && done.review.state === "passed" && done.review.by === "前台", "代签通过：待办完成，记成前台")
check(done.review.deputy?.seatId === frontSeat.agent.id && done.review.deputy.checkName === "复验人" && done.review.deputy.why.includes("全套测试"), "代签记录带上前台席位、复验人和依据")
check(done.steps.at(-1).state === "done" && done.history.at(-1).action === "代签通过", "验收那一步标完成，历史记「代签通过」")
const said = store.inProject(biz.id, () => store.snapshot().messages.slice(before))
const line = said.find((item) => item.id === passed.messageId)
check(line?.kind === "system" && line.authorId === "room" && line.verdict?.deputy === true && line.text.startsWith("前台代 "), `项目里房间说了一句代签（${line?.text}）`)
check(said.every((item) => !item.mentions?.length), "代签没叫醒任何人")
check(refusal(accept(good))?.status === 409 && autoPass(good) === null && taskOf(good).history.filter((item) => item.action === "代签通过").length === 1, "已通过的不能再代签，房间也不再收一次")

// ---- a pass by the room itself, the moment the check passes ----
const auto = waiting("自动收的", {})
const autoDone = autoPass(auto)
const autoTask = taskOf(auto)
check(autoDone && autoTask.status === "done" && autoTask.review.state === "passed" && autoTask.review.deputy?.seatId === "room", "开关开着、开关后请验收、跑得出：房间自己收下")
check(autoTask.review.deputy.why === "复验人 查过，没问题，跑得出结果，没有没验到的" && autoTask.review.deputy.checkName === "复验人", `依据由房间按事实写（${autoTask.review.deputy.why}）`)
check(store.inProject(biz.id, () => store.snapshot().messages.find((item) => item.id === autoDone.message.id))?.text.startsWith("前台代 "), "项目里照样说一句前台代签")

// ---- the list and reopening ----
const list = deputy.deputyPasses()
if (process.env.DEBUG) console.log(JSON.stringify(list))
check(list.length === 2 && list.some((item) => item.taskId === good) && list.every((item) => item.projectName === "代签房"), "代签清单对得上")
check(refusal(() => deputy.reopenDeputy({ project: biz.id, taskId: good }))?.status === 403, "不是用户重开不了")
const humanPass = waiting("用户自己通过的", {})
store.inProject(biz.id, () => store.actOnTask({ ...human, taskId: humanPass, action: "pass" }))
check(refusal(() => deputy.reopenDeputy({ ...human, project: biz.id, taskId: humanPass }))?.status === 400, "用户自己通过的不能用代签的重开")
deputy.reopenDeputy({ ...human, project: biz.id, taskId: good })
const back = taskOf(good)
check(back.status === "doing" && back.review.state === "waiting" && back.steps.at(-1).state === "doing", "重开回到等验收")
check(back.history.at(-1).action === "重开" && deputy.deputyPasses().length === 1, "历史记重开，清单里不再列")
check(refusal(accept(good))?.status === 403 && autoPass(good) === null && !back.check, "重开后旧复验去掉，不会马上再收")
// A check that comes back while it still waits on the user's reopening must
// not pass it again: the owner has changed nothing (the desk's bench_check
// queues one for anything waiting without a verdict).
store.runBatchCheck(biz.id)
const rechecked = taskOf(good)
check(rechecked.check?.state === "queued", "重开后补跑复验：排得上")
store.inProject(biz.id, () => store.setTaskCheck(good, rechecked.check.at, { state: "passed", by: checker.agent.id, name: checker.agent.name, kind: "run" }))
check(signLane(taskOf(good)).lane === "you" && signLane(taskOf(good)).why.includes("重开"), "重开后、负责人还没再请验收：只能你签")
check(autoPass(good) === null && refusal(accept(good))?.status === 403 && taskOf(good).review.state === "waiting", "重开后补跑的复验过了：房间和前台都不再收")
// Asked again and checked again: then it may go.
await sleep(5)
store.inProject(biz.id, () => store.actOnTask(as(owner, { taskId: good, action: "review", note: "按你说的改了" })))
const reasked = taskOf(good)
check(reasked.check?.state === "queued" && reasked.check.at === reasked.review.at, "重开后再请验收：排上新的复验")
store.inProject(biz.id, () => store.setTaskCheck(good, reasked.check.at, { state: "passed", by: checker.agent.id, name: checker.agent.name, kind: "run" }))
check(autoPass(good) && taskOf(good).review.state === "passed", "重开后再请验收、新复验通过：才再收")

// ---- checked again after a failed check (t_a58c8546): never passed for the user ----
const fixed = waiting("没过后改好的", { state: "failed", kind: undefined, note: "按钮没反应" })
await sleep(5)
store.inProject(biz.id, () => store.actOnTask(as(owner, { taskId: fixed, action: "review", note: "按钮修好了" })))
const refixed = taskOf(fixed)
check(refixed.check?.state === "queued" && refixed.check.round === 1 && refixed.check.prev?.state === "failed", "没过后再请验收：重查排上，留着上一次的结论")
store.inProject(biz.id, () => store.setTaskCheck(fixed, refixed.check.at, { state: "passed", by: checker.agent.id, name: checker.agent.name, kind: "run" }))
check(signLane(taskOf(fixed)).lane === "look" && /改过以后再查/.test(signLane(taskOf(fixed)).why), "重查通过：归到要你看的一栏")
check(autoPass(fixed) === null && refusal(accept(fixed))?.status === 403 && taskOf(fixed).review.state === "waiting", "重查通过：房间和前台都不自动收下")

// The recheck did not run; the front desk runs it again: still a recheck.
const redo = waiting("重查没跑成的", { state: "failed", kind: undefined, note: "按钮没反应" })
await sleep(5)
store.inProject(biz.id, () => store.actOnTask(as(owner, { taskId: redo, action: "review", note: "按钮修好了" })))
store.inProject(biz.id, () => store.setTaskCheck(redo, taskOf(redo).check.at, { state: "error", note: "复验没跑成：被停下了" }))
await sleep(5)
const rerun = store.inProject(biz.id, () => store.runBatchCheck(biz.id))
const redone = taskOf(redo)
check(rerun.queued >= 1 && redone.check?.state === "queued" && redone.check.round === 1 && redone.check.prev?.state === "failed", "重查没跑成、前台补跑：还带着上一次的结论和次数")
store.inProject(biz.id, () => store.setTaskCheck(redo, redone.check.at, { state: "passed", by: checker.agent.id, name: checker.agent.name, kind: "run" }))
check(signLane(taskOf(redo)).lane === "look" && autoPass(redo) === null && taskOf(redo).review.state === "waiting", "补跑后的重查通过：照样不自动收下")

// ---- the daily cap ----
const capBefore = deputy.deputyPasses().length
let capHit = null
for (let i = 0; i < deputy.DAILY_CAP + 1 && !capHit; i++) {
  const id = waiting(`批量 ${i}`, {})
  const got = refusal(accept(id))
  if (got) capHit = { i, ...got }
}
check(capHit?.status === 429 && capHit.i === deputy.DAILY_CAP - capBefore, `一天最多 ${deputy.DAILY_CAP} 件（第 ${capHit?.i} 件被拦）`)
const overCap = waiting("超了上限的", {})
check(autoPass(overCap) === null && taskOf(overCap).review.state === "waiting", "到了上限，房间也不再自己收")

// Turned off: nothing more is passed, the moment is forgotten.
deputy.setAutoAccept({ ...human, on: false })
check(store.inProject(biz.id, () => store.snapshot().autoAccept) === false && /没开/.test(refusal(accept(overCap))?.message ?? ""), "关掉之后不再收")
deputy.setAutoAccept({ ...human, on: true })

// ---- the batch card ----
const b1 = waiting("批里能过的", {})
const b2 = waiting("批里要看的", { kind: "look" })
const b3 = waiting("批里的沙盒", {})
const draft = relay.draftRelay(
  as(frontSeat, {
    kind: "batch",
    items: [
      { project: biz.id, taskId: b1, lane: "batch", line: "跑了测试" },
      { project: biz.id, taskId: b2, lane: "batch", line: "前台想放松" },
      { project: biz.id, taskId: b3, lane: "batch", line: "前台想放松" },
      { project: biz.id, taskId: humanPass, lane: "batch", line: "已经过了" },
      { project: biz.id, taskId: notWaiting, lane: "batch", line: "不在等" },
    ],
  }),
)
const lanes = Object.fromEntries(draft.relay.items.map((item) => [item.taskId, item.lane]))
check(lanes[b1] === "batch" && lanes[b2] === "look" && lanes[b3] === "you", "整批卡片：前台往松里改不生效")
check(draft.relay.items.length === 3 && !(humanPass in lanes) && draft.left.length === 2, "不在等验收的丢掉并告诉前台")
// A newer list takes over what still waits on the older one, which closes.
const strict = relay.draftRelay(as(frontSeat, { kind: "batch", items: [{ project: biz.id, taskId: b1, lane: "you", line: "改严" }] }))
check(strict.relay.items[0].lane === "you", "往严里改生效")
const cardOf = (id) => store.inProject(desk.id, () => store.relayCard(id).relay)
const moved = Object.fromEntries(strict.relay.items.map((item) => [item.taskId, item.lane]))
check(strict.relay.items.length === 3 && moved[b2] === "look" && moved[b3] === "you" && strict.replaced === 1 && strict.carried === 2, `新清单把旧清单上还在等的并进来（${JSON.stringify(moved)}）`)
check(cardOf(draft.messageId).state === "dropped" && cardOf(draft.messageId).replacedBy === strict.messageId, "旧清单收起，记着换成了哪一张")
const onOld = refusal(() => store.inProject(desk.id, () => relay.settleRelay({ ...human, messageId: draft.messageId, action: "pass", taskIds: [b2] })))
check(onOld?.status === 409 && /新/.test(onOld.message) && taskOf(b2).review.state === "waiting", `旧清单点不了，告诉他看新的（${onOld?.message}）`)
// Drafted again with nothing tightened: the lane the desk tightened stays, the rest are worked out afresh.
const again = relay.draftRelay(as(frontSeat, { kind: "batch", items: [{ project: biz.id, taskId: b2, lane: "look", line: "再出一次" }] }))
const kept = again.relay.items.find((item) => item.taskId === b1)
check(again.relay.items.length === 3 && kept.lane === "you" && kept.why.startsWith("前台改严了") && cardOf(strict.messageId).state === "dropped", "前台改严过的并过来还是严的")
check(store.inProject(desk.id, () => store.snapshot().messages.filter((item) => item.relay?.kind === "batch" && item.relay.state === "draft")).length === 1, "前台聊天里只剩一张开着的清单")
const card = again.messageId
check(refusal(() => store.inProject(desk.id, () => relay.settleRelay({ messageId: card, action: "pass", taskIds: [b1] })))?.status === 403, "没有用户口令点不了")
// The user passes b1 and b2 (their own click: no lane or switch applies), then b3 later.
// In `again`, b1 was tightened to `you`, b2 is `look`, and b3 is `you`: passing
// b1+b2 leaves only `you`, so the card settles (not blocking new lists) while b3 stays passable.
store.inProject(biz.id, () => store.actOnTask(as(owner, { taskId: b2, action: "step", step: 2, state: "doing" })))
const first = store.inProject(desk.id, () => relay.settleRelay({ ...human, messageId: card, action: "pass", taskIds: [b1, b2] }))
const state = Object.fromEntries(first.relay.items.map((item) => [item.taskId, item.state]))
check(state[b1] === "passed" && state[b2] === "passed" && !state[b3] && first.relay.state === "passed", "用户点通过：只剩「只能你签」时卡片不再算开着（状态已了结，仍可继续点）")
check(taskOf(b1).review.state === "passed" && !taskOf(b1).review.deputy, "整批通过记成用户自己的通过")
store.inProject(biz.id, () => store.actOnTask({ ...human, taskId: b3, action: "pass" }))
const second = store.inProject(desk.id, () => relay.settleRelay({ ...human, messageId: card, action: "pass", taskIds: [b3] }))
const last = second.relay.items.find((item) => item.taskId === b3)
if (process.env.DEBUG) console.log(JSON.stringify(second.relay))
check(last.state === "skipped" && last.note && second.relay.state === "passed", `已经过了的记 skipped 和原因，全部处理完卡片结算（${last.note}）`)

// ---- batch ordering, remaining summary, non-blocking you-lane, and issue passes ----
// Pure helpers for sorting and remaining text.
const sampleBatch = [
  { project: biz.id, projectName: "代签房", taskId: "t_s1", title: "settled-batch", lane: "batch", line: "a", state: "passed" },
  { project: biz.id, projectName: "代签房", taskId: "t_s2", title: "open-batch", lane: "batch", line: "b" },
  { project: biz.id, projectName: "代签房", taskId: "t_s3", title: "open-look", lane: "look", line: "c" },
  { project: biz.id, projectName: "代签房", taskId: "t_s4", title: "open-you", lane: "you", line: "d" },
]
check(
  sortBatchItems(sampleBatch).map((i) => i.taskId).join(",") === "t_s2,t_s3,t_s4,t_s1",
  "未点到的行排在最上面，已点过的沉到下面",
)
check(
  batchRemainingText([
    { project: biz.id, projectName: "代签房", taskId: "t_1", title: "1", lane: "batch", line: "", state: "passed" },
    { project: biz.id, projectName: "代签房", taskId: "t_2", title: "2", lane: "look", line: "" },
    { project: biz.id, projectName: "代签房", taskId: "t_3", title: "3", lane: "you", line: "" },
  ]) === "还剩 2 件要你自己看（要你看 1 件、只能你签 1 件）",
  "点完批里项目后明确写出还剩几件要自己看，分开写要你看和只能你签",
)
check(
  batchRemainingText([
    { project: biz.id, projectName: "代签房", taskId: "t_1", title: "1", lane: "batch", line: "", state: "passed" },
    { project: biz.id, projectName: "代签房", taskId: "t_2", title: "2", lane: "look", line: "", state: "skipped" },
    { project: biz.id, projectName: "代签房", taskId: "t_3", title: "3", lane: "you", line: "", state: "passed" },
  ]) === "这批都处理完了",
  "全部处理完才写「这批都处理完了」",
)
check(batchCounts(sampleBatch).remBatch === 1 && batchCounts(sampleBatch).remManual === 2, "剩余件数按可整批/要你看/只能你签统计准确")

// 3-lane batch flow: batch -> look -> only you left -> new card doesn't drop old -> pass remaining you -> 409 when all done.
const mixBatch = waiting("混合卡能批", { note: "单测通过" })
const mixLook = waiting("混合卡要看", { kind: "look", gaps: "真机样式", note: "PC 端测试过" })
const mixYou = waiting("混合卡失败你签", { state: "failed", note: "结算精度少 1 分钱" })
const extraWait = waiting("下一批待办", {})
const mixCard = relay.draftRelay(
  as(frontSeat, {
    kind: "batch",
    items: [
      { project: biz.id, taskId: mixBatch, lane: "batch", line: "批里" },
      { project: biz.id, taskId: mixLook, lane: "look", line: "看一眼" },
      { project: biz.id, taskId: mixYou, lane: "you", line: "查出问题" },
    ],
  }),
)
check(refusal(accept(mixYou))?.status === 403 && autoPass(mixYou) === null, "只能你签的条目：前台与房间仍不能代签或自动收下")
check(
  refusal(() => store.inProject(desk.id, () => relay.settleRelay({ ...as(frontSeat, {}), messageId: mixCard.messageId, action: "pass", taskIds: [mixYou] })))?.status === 403,
  "前台席位冒充点整批卡只能你签的行被 403 拒绝",
)
const afterBatch = store.inProject(desk.id, () => relay.settleRelay({ ...human, messageId: mixCard.messageId, action: "pass", taskIds: [mixBatch] }))
check(afterBatch.relay.state === "draft" && batchRemainingText(afterBatch.relay.items) === "还剩 2 件要你自己看（要你看 1 件、只能你签 1 件）", "点完可整批但还有「你看一眼」：卡片仍开着，写明剩余数")
const afterLook = store.inProject(desk.id, () => relay.settleRelay({ ...human, messageId: mixCard.messageId, action: "pass", taskIds: [mixLook] }))
check(afterLook.relay.state === "passed" && batchRemainingText(afterLook.relay.items) === "还剩 1 件要你自己看（要你看 0 件、只能你签 1 件）", "点完要看只剩「只能你签」：卡片了结不再算开着")

// New batch card arrives: the settled mixCard is NOT dropped or replaced, only newer is draft.
const newerCard = relay.draftRelay(as(frontSeat, { kind: "batch", items: [{ project: biz.id, taskId: extraWait, lane: "batch", line: "新批" }] }))
check(cardOf(mixCard.messageId).state === "passed" && !cardOf(mixCard.messageId).replacedBy && newerCard.replaced === 0, "只剩「只能你签」的旧卡不挡新卡，也不会被新卡吞掉收起")
check(store.inProject(desk.id, () => store.snapshot().messages.filter((m) => m.relay?.kind === "batch" && m.relay.state === "draft")).length === 1, "聊天里依然只有新卡一张是 draft")

// Clicking remaining 「只能你签」 row on the already-settled mixCard still succeeds as human pass!
const afterYou = store.inProject(desk.id, () => relay.settleRelay({ ...human, messageId: mixCard.messageId, action: "pass", taskIds: [mixYou] }))
const passedYou = taskOf(mixYou)
check(
  afterYou.relay.items.find((i) => i.taskId === mixYou)?.state === "passed" &&
    batchRemainingText(afterYou.relay.items) === "这批都处理完了" &&
    passedYou.review.state === "passed" &&
    !passedYou.review.deputy,
  "已了结卡片上剩下的「只能你签」还能逐件点通过，算用户自己通过，全部点完写这批都处理完了",
)
check(
  refusal(() => store.inProject(desk.id, () => relay.settleRelay({ ...human, messageId: mixCard.messageId, action: "pass", taskIds: [mixYou] })))?.status === 409,
  "全部行都处理完后再点整批卡片才报 409 已通过",
)

// Passing check-failed / unverified / error / unchecked tasks records review.issue & history; clean passes don't.
check(
  passedYou.review.issue?.state === "failed" &&
    passedYou.review.issue.checkBy === checker.agent.id &&
    passedYou.review.issue.checkName === "复验人" &&
    passedYou.review.issue.summary.includes("结算精度少 1 分钱"),
  "通过检查没过的待办：review.issue 记下检查状态、检查人和结论摘要",
)
check(
  passedYou.history.at(-1)?.action === "验收通过" && passedYou.history.at(-1)?.note?.startsWith("带着问题收下："),
  `历史里记一句「带着问题收下：…」（${passedYou.history.at(-1)?.note}）`,
)

const unverifiedPass = waiting("没查出结论也收", { state: "unverified", note: "环境缺字体没能比对" })
const queuedPass = waiting("检查还在排队也收", null)
const noCheckPass = waiting("完全没检查也收", null)
store.inProject(biz.id, () => {
  delete store.snapshot().tasks.find((item) => item.id === noCheckPass).check
})
const guardCleanPass = waiting("调整凭证过期策略", { kind: "you", note: "逻辑和单测都过了" })
for (const tid of [unverifiedPass, queuedPass, noCheckPass, guardCleanPass]) {
  store.inProject(biz.id, () => store.actOnTask({ ...human, taskId: tid, action: "pass" }))
}
check(
  taskOf(unverifiedPass).review.issue?.state === "unverified" &&
    taskOf(unverifiedPass).history.at(-1)?.note?.startsWith("带着问题收下："),
  "没查出结论点通过：也记在带着问题收下",
)
check(
  taskOf(queuedPass).review.issue?.state === "queued" &&
    taskOf(queuedPass).review.issue.summary.includes("排队"),
  "检查还在排队时提前点通过：记为未完成检查",
)
check(
  taskOf(noCheckPass).review.issue?.state === "none" &&
    taskOf(noCheckPass).review.issue.summary === "没检查",
  "完全没检查点通过：记「没检查」",
)
check(
  !taskOf(mixBatch).review.issue &&
    !taskOf(mixLook).review.issue &&
    !taskOf(guardCleanPass).review.issue &&
    !taskOf(mixLook).history.at(-1)?.note?.includes("带着问题收下"),
  "检查通过的待办（含要你看、有gaps、标题含保险词但检查通过）照旧不记带着问题收下",
)

// Issue list (14-day window), frontOverview count, and reopening.
const issuesBeforeOld = deputy.deputyIssues()
check(
  issuesBeforeOld.length === 4 &&
    issuesBeforeOld.some((item) => item.taskId === mixYou && item.ownerName === "工匠" && item.why.includes("结算精度")) &&
    issuesBeforeOld.some((item) => item.taskId === unverifiedPass) &&
    issuesBeforeOld.some((item) => item.taskId === queuedPass) &&
    issuesBeforeOld.some((item) => item.taskId === noCheckPass) &&
    !issuesBeforeOld.some((item) => item.taskId === guardCleanPass || item.taskId === mixBatch || item.taskId === mixLook),
  `带着问题收下清单只收 4 条问题件，带谁做的和结论，不混入检查通过的（实际 ${issuesBeforeOld.length} 条）`,
)
check(
  !deputy.deputyPasses().some((item) => item.taskId === mixYou || item.taskId === noCheckPass),
  "带着问题收下的不混入「今天替你收下」代签清单",
)
const overIssue = front.frontOverview(as(frontSeat, {}))
const overBizIssue = overIssue.projects.find((p) => p.id === biz.id)
check(
  overIssue.issuePasses === 4 &&
    overBizIssue?.issuePasses === 4 &&
    overIssue.text.includes("近 14 天带着问题收下：4 件") &&
    overIssue.text.includes("带着问题收下 4 件"),
  "前台一览的数据和文字都带上近 14 天带着问题收下的件数",
)

// 3-day and 10-day issue passes (even with updatedAt beyond snapshot()'s 48h done
// cutoff) stay queryable & reopenable; 16-day entries drop out.
const DAY_MS = 24 * 60 * 60 * 1000
const nowMs = Date.now()
const issue3d = waiting("三天前带病收下的", { state: "failed", note: "三天前的警告" })
const issue10d = waiting("十天前带病收下的", null)
const staleCutoff = nowMs - (ISSUE_WINDOW_MS + 2 * DAY_MS)
const staleIssue = waiting("十六天前带病收下的", null)
store.inProject(biz.id, () => {
  delete store.snapshot().tasks.find((item) => item.id === issue10d).check
  for (const [tid, ts] of [
    [issue3d, nowMs - 3 * DAY_MS],
    [issue10d, nowMs - 10 * DAY_MS],
    [staleIssue, staleCutoff],
  ]) {
    store.actOnTask({ ...human, taskId: tid, action: "pass" })
    const t = store.snapshot().tasks.find((item) => item.id === tid)
    t.review.at = ts
    t.updatedAt = ts
  }
})
check(
  !store.inProject(biz.id, () => store.snapshot().tasks.some((item) => item.id === issue3d || item.id === issue10d)),
  "确认 3 天前和 10 天前收下的任务已被 snapshot 48h 窗口裁掉",
)
const listWithAged = deputy.deputyIssues()
check(
  listWithAged.some((item) => item.taskId === issue3d) &&
    listWithAged.some((item) => item.taskId === issue10d) &&
    !listWithAged.some((item) => item.taskId === staleIssue) &&
    front.frontOverview(as(frontSeat, {})).issuePasses === 6,
  "超过 48h 的 3 天前、10 天前带着问题收下仍查得到且进一览计数，超过 14 天（16 天前）的不出现",
)
deputy.reopenDeputy({ ...human, project: biz.id, taskId: issue3d })
deputy.reopenDeputy({ ...human, project: biz.id, taskId: issue10d })
check(
  taskOf(issue3d).status === "doing" &&
    taskOf(issue3d).review.state === "waiting" &&
    taskOf(issue10d).status === "doing" &&
    taskOf(issue10d).review.state === "waiting" &&
    !deputy.deputyIssues().some((item) => item.taskId === issue3d || item.taskId === issue10d) &&
    front.frontOverview(as(frontSeat, {})).issuePasses === 4,
  "3 天前、10 天前带着问题收下的待办也能正常重开并从清单和一览里消失",
)

// Reopen an issue-passed item; clean human pass still gets 400.
check(refusal(() => deputy.reopenDeputy({ ...human, project: biz.id, taskId: guardCleanPass }))?.status === 400, "检查正常通过、用户自己点的依然不能重开")
check(refusal(() => deputy.reopenDeputy({ project: biz.id, taskId: mixYou }))?.status === 403, "不是用户重开不了带着问题收下的待办")
deputy.reopenDeputy({ ...human, project: biz.id, taskId: mixYou })
const reopenedYou = taskOf(mixYou)
check(
  reopenedYou.status === "doing" &&
    reopenedYou.review.state === "waiting" &&
    reopenedYou.review.reopened === true &&
    !reopenedYou.check &&
    reopenedYou.history.at(-1)?.action === "重开",
  "带着问题收下的待办可以点重开，回到等验收并清掉旧检查",
)
check(
  !deputy.deputyIssues().some((item) => item.taskId === mixYou) &&
    front.frontOverview(as(frontSeat, {})).issuePasses === 3,
  "重开后立刻从带着问题收下清单与一览计数里消失",
)
store.runBatchCheck(biz.id)
const recheckIssue = taskOf(mixYou)
store.inProject(biz.id, () => store.setTaskCheck(mixYou, recheckIssue.check.at, { state: "passed", by: checker.agent.id, name: checker.agent.name, kind: "run" }))
check(autoPass(mixYou) === null && taskOf(mixYou).review.state === "waiting", "带问题重开后没再请验收前，房间不会自动收下")

if (failed) {
  console.log(`deputy: ${failed} failed`)
  process.exit(1)
}
console.log("deputy ok")
process.exit(0)
