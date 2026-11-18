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
process.on("exit", () => rmSync(data, { recursive: true, force: true }))

const lib = (name) => import(pathToFileURL(path.join(root, "lib", `${name}.ts`)).href)
const store = await lib("store")
const { signLane, guardWordIn } = await lib("review")
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
store.inProject(biz.id, () => store.actOnTask(as(owner, { taskId: b2, action: "step", step: 2, state: "doing" })))
const first = store.inProject(desk.id, () => relay.settleRelay({ ...human, messageId: card, action: "pass", taskIds: [b1, b2] }))
const state = Object.fromEntries(first.relay.items.map((item) => [item.taskId, item.state]))
check(state[b1] === "passed" && state[b2] === "passed" && !state[b3] && first.relay.state === "draft", "用户点通过：选中的逐条通过，卡片可以分几次点")
check(taskOf(b1).review.state === "passed" && !taskOf(b1).review.deputy, "整批通过记成用户自己的通过")
store.inProject(biz.id, () => store.actOnTask({ ...human, taskId: b3, action: "pass" }))
const second = store.inProject(desk.id, () => relay.settleRelay({ ...human, messageId: card, action: "pass", taskIds: [b3] }))
const last = second.relay.items.find((item) => item.taskId === b3)
if (process.env.DEBUG) console.log(JSON.stringify(second.relay))
check(last.state === "skipped" && last.note && second.relay.state === "passed", `已经过了的记 skipped 和原因，全部处理完卡片结算（${last.note}）`)

if (failed) {
  console.log(`deputy: ${failed} failed`)
  process.exit(1)
}
console.log("deputy ok")
process.exit(0)
