#!/usr/bin/env node
// 「你不在的这段时间」 (lib/away-shared.ts, lib/away.ts): each line of the
// card from made-up history, nothing drawn when nothing happened, what came
// before `since` left out, and the read changing nothing. Runs the room's code
// in this process on a throwaway data folder, no server:
//   node scripts/test-away.mjs
// BENCH_ROOT=<a copy of the repo> runs that copy's code instead.
import { mkdtempSync, rmSync } from "node:fs"
import { register } from "node:module"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = process.env.BENCH_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
register(pathToFileURL(path.join(root, "scripts/ts-alias.mjs")).href, import.meta.url)
const data = mkdtempSync(path.join(os.tmpdir(), "bench-away-"))
process.env.BENCH_DATA_DIR = data
process.on("exit", () => {
  try { globalThis.__benchSqlite?.db?.close() } catch {}
  try { rmSync(data, { recursive: true, force: true }) } catch {}
})

const lib = (name) => import(pathToFileURL(path.join(root, "lib", `${name}.ts`)).href)
const store = await lib("store")
const shared = await lib("away-shared")
const { awayOverview } = await lib("away")

let failed = 0
function check(ok, what) {
  console.log(`${ok ? "ok " : "FAIL"} ${what}`)
  if (!ok) failed++
}

const MIN = 60_000
const now = Date.now()
const since = now - 3 * 60 * MIN
const when = (at) => `@${new Date(at).getHours()}`

// --- the pure lines, one case each ------------------------------------------------
const msg = (extra) => ({ id: `m_${Math.random()}`, seq: 1, kind: "system", authorId: "room", authorName: "并坐", text: "x", mentions: [], createdAt: since + MIN, ...extra })
const task = (extra) => ({ id: `t_${Math.random()}`, title: "一件事", status: "doing", history: [], updatedAt: since + MIN, steps: [], ...extra })
const base = { messages: [], tasks: [], agents: [], permits: [], since, now, when }
const lineOf = (input, key) => shared.awayLines({ ...base, ...input }).find((line) => line.key === key)
const AGENTS = [{ name: "席甲", status: "working", doing: "写页面" }]

check(lineOf({ messages: [msg({ kind: "chat", authorId: "a1", ask: { state: "open" }, text: "问你一个" })] }, "asks")?.text === "新问了你 1 个问题", "行：新问了你几个问题")
check(lineOf({ permits: [{ id: "p1", at: since + MIN }, { id: "p2", at: since + 2 * MIN }] }, "permits")?.text === "2 个权限等你批", "行：几个权限等你批")
const waiting = (id, title, at) => task({ id, title, status: "doing", review: { state: "waiting", at, by: "席甲" } })
const reviewLine = lineOf({ tasks: [waiting("t_1", "甲", since + MIN), waiting("t_2", "乙", since + MIN), waiting("t_3", "丙", since + MIN), waiting("t_4", "丁", since + MIN)] }, "review")
check(reviewLine?.text === "4 件做完了，等你验收：「甲」、「乙」、「丙」 等" && reviewLine.target.id === "t_1", `行：做完等你验收，列前 3 件标题（得到 ${reviewLine?.text}）`)
const hitAt = (name, resetsAt, extra = {}) => msg({ limited: { runId: `r_${name}`, agentId: `a_${name}`, agentName: name, label: "5 小时额度", resetsAt, state: "open" }, ...extra })
const limitedLines = (messages) => shared.awayLines({ ...base, messages }).filter((line) => line.key.startsWith("limited"))
check(limitedLines([hitAt("席甲", now + 60 * MIN)])[0]?.text === `席甲 撞到额度，${when(now + 60 * MIN)} 恢复`, "行：谁撞额度、几点恢复")
check(
  (() => {
    // Inside one clock minute whatever time the test runs at (a +5 s that crossed a minute made this flaky).
    const sameMinute = Math.floor((now + 60 * MIN) / MIN) * MIN + 10_000
    const lines = limitedLines([hitAt("席甲", sameMinute), hitAt("席乙", sameMinute + 5000), hitAt("席丙", sameMinute)])
    return lines.length === 1 && lines[0].text === `席甲、席乙、席丙 撞到额度，${when(sameMinute)} 恢复`
  })(),
  "同一个恢复时间的合成一行",
)
check(
  (() => {
    const lines = limitedLines(["甲", "乙", "丙", "丁", "戊"].map((name) => hitAt(name, now + 60 * MIN)))
    return lines.length === 1 && lines[0].text === `甲、乙、丙 等 5 个 撞到额度，${when(now + 60 * MIN)} 恢复`
  })(),
  "名字多于 3 个写「等 N 个」",
)
check(
  limitedLines([hitAt("席甲", now - 20 * MIN), hitAt("席乙", now - 20 * MIN)])[0]?.text === `席甲、席乙 撞到过额度，${when(now - 20 * MIN)} 已恢复`,
  "恢复时间已经过了写「撞到过额度…已恢复」",
)
check(limitedLines([hitAt("席甲", now + 60 * MIN), hitAt("席乙", now - 20 * MIN)]).length === 2, "恢复时间不同的各一行")
check(lineOf({ tasks: [task({ status: "blocked", history: [{ at: since + 5 * MIN, actor: "席甲", action: "卡住", note: "等人" }] })] }, "blocked")?.text === "1 件卡住了：「一件事」", "行：卡住几件")
check(lineOf({ tasks: [task({ status: "done", review: { state: "passed", at: since + 9 * MIN, by: "前台", deputy: { seatId: "f", seatName: "前台", why: "查过" } } })] }, "accepted")?.text === "房间替你收下了 1 件", "行：房间替你收下几件")
const wake = (state) => msg({ wakeText: "接着做", calls: [{ id: "a1", name: "席甲", state, at: since + MIN }] })
check(lineOf({ messages: [wake("answered"), wake("failed")] }, "woken")?.text === "房间自己叫 AI 接着做了 2 次，席甲 没叫动", "行：房间叫 AI 接着做几次、叫不动的是谁")
check(lineOf({ messages: [wake("answered")] }, "woken")?.text === "房间自己叫 AI 接着做了 1 次", "叫动了就不写「没叫动」")
check(lineOf({ messages: [wake("answered")], agents: AGENTS }, "working")?.text === "现在还在做：席甲（写页面）", "行：现在谁在做什么")

// nothing happened → nothing; still-working alone is not a reason to draw it
check(shared.awayLines({ ...base }).length === 0, "全是 0 不出卡")
check(shared.awayLines({ ...base, agents: AGENTS }).length === 0, "只有「还在做」也不出卡")
// before since does not count
const early = since - MIN
check(
  shared.awayLines({
    ...base,
    messages: [msg({ createdAt: early, kind: "chat", authorId: "a1", ask: { state: "open" } }), msg({ createdAt: early, wakeText: "x" }), msg({ createdAt: early, limited: { runId: "r", agentId: "a1", agentName: "席甲", label: "x", state: "open" } })],
    tasks: [waiting("t_9", "旧", early), task({ status: "blocked", updatedAt: early, history: [{ at: early, actor: "席甲", action: "卡住" }] })],
    permits: [{ id: "p", at: early }],
    agents: AGENTS,
  }).length === 0,
  "since 之前的事不算",
)

// time words
check(/^上午 10:17 到现在（3 小时 12 分）$/.test(shared.awayStretch(new Date(2026, 10, 18, 10, 17).getTime(), new Date(2026, 10, 18, 13, 29).getTime())), "时间写「上午 10:17 到现在（3 小时 12 分）」")
check(/^下午 2:05 到现在（45 分）$/.test(shared.awayStretch(new Date(2026, 10, 18, 14, 5).getTime(), new Date(2026, 10, 18, 14, 50).getTime())), "不到一小时写分钟")

// --- in the room: the read ---------------------------------------------------------
const A = store.createProject({ as: "human", name: "甲房" }).project
const B = store.createProject({ as: "human", name: "乙房" }).project
const seat = (p, name) => store.inProject(p.id, () => store.join({ name, model: "mock", role: "开发" }))
const sa = seat(A, "席甲")
const sb = seat(B, "席乙")
const t0 = Date.now() - 1000
store.inProject(A.id, () => {
  const t = store.createTask({ agentId: sa.agent.id, token: sa.token, title: "做完的活", owner: sa.agent.name, steps: ["做"] }).task
  store.actOnTask({ agentId: sa.agent.id, token: sa.token, taskId: t.id, action: "step", step: 1, state: "done" })
  store.actOnTask({ agentId: sa.agent.id, token: sa.token, taskId: t.id, action: "review", note: "刷新页面就能看到" })
  const k = store.createTask({ agentId: sa.agent.id, token: sa.token, title: "卡住的活", owner: sa.agent.name, steps: ["做"] }).task
  store.actOnTask({ agentId: sa.agent.id, token: sa.token, taskId: k.id, action: "block", note: "等人" })
  store.postLimited("席甲 撞上5 小时额度", { runId: "run_away_1", agentId: sa.agent.id, agentName: "席甲", label: "5 小时额度", resetsAt: Date.now() + 3600_000, state: "open" })
  store.askUser({ agentId: sa.agent.id, token: sa.token, text: "还按这个吗？", options: [{ label: "按" }] })
  store.pulseAgent(sa.agent.id, "working", "写页面")
})
store.inProject(B.id, () => {
  store.postRoomWake(sb.agent.id, "席乙 停了，叫它接着做", "接着做")
  store.pulseAgent(sb.agent.id, "working", "改接口")
})

const one = awayOverview(t0, A.id)
check(one.scope === "project" && ["asks", "review", "limited", "blocked", "working"].every((key) => one.lines.some((line) => line.key.split(":")[0] === key)), `单个项目：每一行都在（${one.lines.map((l) => l.key).join()}）`)
check(!one.lines.some((line) => line.key === "woken"), "别的项目的事不混进来")
const front = awayOverview(t0)
check(front.scope === "front" && front.projects.length === 2 && front.projects.every((p) => p.lines.length <= 2), `前台：按项目分行，每个项目最多两句（${front.projects.map((p) => p.projectName + p.lines.length).join()}）`)
check(front.projects[0].projectName === "甲房" && front.projects[0].lines[0].key === "asks", "前台：最要紧的项目和句子排前")
check(awayOverview(Date.now() + 60_000, A.id).lines.length === 0, "since 之后没发生事：不出卡")
let bad = null
try {
  awayOverview("abc")
} catch (error) {
  bad = error.status
}
check(bad === 400, "since 不对返回 400")

// reading changes nothing
const dump = () =>
  JSON.stringify([A, B].map((p) => store.inProject(p.id, () => { const s = store.snapshot(); return [s.rev, s.seq, s.tasks, s.messages, s.agents, s.permits] })))
const before = dump()
awayOverview(t0, A.id)
awayOverview(t0)
awayOverview(t0, B.id)
check(dump() === before, "读这个接口不改任何数据（房间版本、消息、待办、席位都不变）")

if (failed) {
  console.error(`${failed} 项没过`)
  process.exit(1)
}
console.log("away ok")
