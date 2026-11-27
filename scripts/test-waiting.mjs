#!/usr/bin/env node
// 「等你定」: one card per thing, the weightiest first, folded when there are
// many, and an old question asked twice before it is answered
// (lib/waiting-shared.ts, lib/waiting.ts, answerAsk in lib/store.ts). Runs the
// room's code in this process on a throwaway data folder, no server:
//   node scripts/test-waiting.mjs
// BENCH_ROOT=<a copy of the repo> runs that copy's code instead.
import { mkdtempSync, rmSync } from "node:fs"
import { register } from "node:module"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = process.env.BENCH_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
register(pathToFileURL(path.join(root, "scripts/ts-alias.mjs")).href, import.meta.url)
const data = mkdtempSync(path.join(os.tmpdir(), "bench-waiting-"))
process.env.BENCH_DATA_DIR = data
process.on("exit", () => {
  try { globalThis.__benchSqlite?.db?.close() } catch {}
  try { rmSync(data, { recursive: true, force: true }) } catch {}
})

const lib = (name) => import(pathToFileURL(path.join(root, "lib", `${name}.ts`)).href)
const store = await lib("store")
const shared = await lib("waiting-shared")
const { waitingOverview } = await lib("waiting")

let failed = 0
function check(ok, what) {
  console.log(`${ok ? "ok " : "FAIL"} ${what}`)
  if (!ok) failed++
}

const DAY = 24 * 3600_000

// --- pure helpers ---------------------------------------------------------
check(shared.staleAskDays(Date.now() - 2 * DAY - 3600_000) === 0, "2 天多的提问不算旧")
check(shared.staleAskDays(Date.now() - 3 * DAY - 1000) === 3, "3 天的提问算旧，写 3 天")
check(shared.staleAskDays(Date.now() - 4.5 * DAY) === 4, "4 天半写 4 天")

const row = (id, since, check) => ({ id, kind: "task", state: "you", title: id, line: "", at: since, since, messageIds: [], attachments: 0, need: "review", check })
const sorted = shared.sortReviews([row("old", 1), row("new", 5), row("bad-new", 9, { state: "failed" }), row("bad-old", 3, { state: "failed" })]).map((r) => r.id)
check(sorted.join() === "bad-old,bad-new,old,new", `验收：查出问题的排前，其余等得久的排前（得到 ${sorted.join()}）`)

// --- in the room ------------------------------------------------------------
const A = store.createProject({ as: "human", name: "甲房" }).project
const B = store.createProject({ as: "human", name: "乙房" }).project
const seatsOf = {}
for (const [project, name] of [[A, "席甲"], [B, "席乙"]]) {
  seatsOf[project.id] = store.inProject(project.id, () => store.join({ name, model: "mock", role: "开发" }))
}

function limitedFor(project, seat, n, base = Date.now() - 600_000) {
  return store.inProject(project.id, () => {
    for (let i = 0; i < n; i++) {
      const msg = store.postLimited(`${seat.agent.name} 撞上5 小时额度（${i}）`, { runId: `run_${project.id}_${seat.agent.id}_${i}`, agentId: seat.agent.id, agentName: seat.agent.name, label: "5 小时额度", state: "open" })
      msg.createdAt = base + i * 1000
    }
  })
}
const seatA = seatsOf[A.id]
limitedFor(A, seatA, 5)

// five cards of one seat → one, saying 5 times
let overview = waitingOverview()
const limA = overview.limited.filter((item) => item.projectId === A.id)
check(limA.length === 1 && limA[0].count === 5, `同一个席位 5 张额度卡合成一张，写 5 次（得到 ${limA.length} 张，count ${limA[0]?.count}）`)
check(limA[0]?.message.limited.runId.endsWith("_4"), "留下的是最新一张")

// another seat in the same room is its own card
const other = store.inProject(A.id, () => store.join({ name: "席丙", model: "mock", role: "开发" }))
limitedFor(A, other, 1)
overview = waitingOverview()
check(overview.limited.filter((item) => item.projectId === A.id).length === 2, "别的席位撞额度，另出一张")

// dealing with the newest settles the older ones of that seat
const newest = limA[0].message.limited.runId
store.inProject(A.id, () => store.markLimited(newest, { state: "dismissed", at: undefined }))
const settled = store.inProject(A.id, () => store.snapshot().messages.filter((m) => m.limited?.agentId === seatA.agent.id && m.limited.runId !== newest && m.limited.state === "dismissed").length)
check(settled === 4, `处理最新一张，同席位旧的 4 张一起算处理了（得到 ${settled}）`)
const afterSettle = store.inProject(A.id, () => store.snapshot().messages.filter((m) => m.limited?.agentId === seatA.agent.id))
check(afterSettle.filter((m) => m.limited.state === "dismissed").length === 5 && afterSettle.filter((m) => m.limited.state === "open").length === 0, "旧的 4 张标成已忽略，最新的一张也已按用户点的处理")
check(store.inProject(A.id, () => store.snapshot().messages.filter((m) => m.limited?.agentId === other.agent.id && m.limited.state === "open").length) === 1, "别的席位的额度卡不受影响")

// the other ways a card is dealt with settle the older ones too: switching the
// seat to another client (rebound), waking it (resumed, also what the timer does)
for (const state of ["rebound", "resumed"]) {
  const who = store.inProject(A.id, () => store.join({ name: `席${state}`, model: "mock", role: "开发" }))
  limitedFor(A, who, 3)
  store.inProject(A.id, () => store.markLimited(`run_${A.id}_${who.agent.id}_2`, { state, at: Date.now() }))
  const states = store.inProject(A.id, () => store.snapshot().messages.filter((m) => m.limited?.agentId === who.agent.id).sort((a, b) => a.createdAt - b.createdAt).map((m) => m.limited.state))
  check(states.join() === `dismissed,dismissed,${state}`, `「${state}」之后同席位旧的两张也一起结算（得到 ${states.join()}）`)
}

// the newest one handled by itself (e.g. woken at the reset): older open ones do not come back
const seatB = seatsOf[B.id]
limitedFor(B, seatB, 3)
store.inProject(B.id, () => store.markLimited(`run_${B.id}_${seatB.agent.id}_2`, { state: "resumed", at: Date.now() }))
overview = waitingOverview()
check(overview.limited.filter((item) => item.projectId === B.id).length === 0, "最新一张已经处理了，旧的没处理的也不再出")
check(store.inProject(B.id, () => store.snapshot().messages.filter((m) => m.limited?.agentId === seatB.agent.id && m.limited.state === "open").length) === 0, "到点叫醒那样处理完的，旧的几张也一并标成已忽略")

// 「共撞了 N 次」 counts the stretch since the last card dealt with, not the
// whole window: five hits in the morning that ended in a wake, one in the evening
{
  const card = (n, state) => ({ id: `m_${n}`, kind: "system", authorId: "room", authorName: "并坐", text: "x", mentions: [], seq: n, createdAt: 1000 + n, limited: { runId: `r${n}`, agentId: "a1", agentName: "席甲", label: "x", state } })
  const morning = [1, 2, 3, 4, 5].map((n) => card(n, "open"))
  const groups = shared.groupLimited([...morning, card(6, "resumed"), card(7, "open")])
  check(groups.length === 1 && groups[0].count === 1 && groups[0].message.id === "m_7", `上一轮的旧账不算：早上连撞 5 次翻了篇，晚上新撞 1 次写 1 次（得到 ${groups[0]?.count}）`)
  const still = shared.groupLimited([card(1, "resumed"), card(2, "open"), card(3, "failed"), card(4, "open")])
  check(still[0].count === 3, `翻篇之后又连撞 3 次，写 3 次（得到 ${still[0]?.count}）`)
}

// asks: weight of sections, and a stale question
const asked = store.inProject(B.id, () => store.askUser({ agentId: seatB.agent.id, token: seatB.token, text: "还按这个方案吗？", options: [{ label: "按这个" }, { label: "换一个" }] }))
const askMsg = store.inProject(B.id, () => store.snapshot().messages.find((m) => m.id === asked.message.id))
askMsg.createdAt = Date.now() - 4 * DAY
const sections = shared.sectionsOf(waitingOverview())
check(sections[0].projectId === B.id, "有 AI 卡在提问上的项目排最前")
check(sections.map((s) => s.projectId).join() === `${B.id},${A.id}`, `分段按要紧程度排（得到 ${sections.map((s) => s.projectName).join()}）`)
check(sections.every((s) => s.count === s.permits.length + s.asks.length + s.limited.length + s.interrupted.length + s.reviews.length), "段头的件数就是这一段所有卡的数")

const reply = store.inProject(B.id, () => store.say({ as: "human", text: "按这个", replyTo: asked.message.id }))
check(/^（这是 4 天前的提问，先核实现在还作不作数）按这个$/.test(reply.message.text), `4 天前的提问：送给席位的回答前面加了一句（得到 ${reply.message.text}）`)
check(store.inProject(B.id, () => store.snapshot().messages.find((m) => m.id === asked.message.id)).ask.state === "answered", "服务端不拦，照样记成已答")

const fresh = store.inProject(B.id, () => store.askUser({ agentId: seatB.agent.id, token: seatB.token, text: "新问题？", options: [{ label: "好" }] }))
const freshReply = store.inProject(B.id, () => store.say({ as: "human", text: "好", replyTo: fresh.message.id }))
check(freshReply.message.text === "好", "3 天内的提问，回答一个字不加")

if (failed) {
  console.error(`${failed} 项没过`)
  process.exit(1)
}
console.log("waiting ok")
