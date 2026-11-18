#!/usr/bin/env node
// The front desk's relay / nudge / review cards (lib/front-relay.ts), against
// a running room. Only in an isolated copy (scripts/test-copy.sh): it makes
// projects and seats.
//   BENCH_URL=http://127.0.0.1:44xx BENCH_KEY_FILE=<copy>/data/human-key node scripts/test-relay.mjs
import { readFileSync } from "node:fs"

const origin = process.env.BENCH_URL
const keyFile = process.env.BENCH_KEY_FILE
if (!origin || !keyFile) {
  console.error("要设 BENCH_URL 和 BENCH_KEY_FILE（只在隔离副本里跑）")
  process.exit(2)
}
if (/:4399\b/.test(origin)) {
  console.error("不在正式房间 4399 上跑")
  process.exit(2)
}
const key = readFileSync(keyFile, "utf8").trim()
const stamp = Date.now().toString(36)

let failed = 0
function check(ok, what) {
  console.log(`${ok ? "ok " : "FAIL"} ${what}`)
  if (!ok) failed++
}

async function req(pathname, { proj, body, method = body ? "POST" : "GET", withKey = true } = {}) {
  const url = proj && method === "GET" ? `${origin}${pathname}?project=${encodeURIComponent(proj)}` : `${origin}${pathname}`
  const headers = body ? { "content-type": "application/json" } : {}
  if (withKey && body?.as === "human") headers["x-bench-human"] = key
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(proj ? { project: proj, ...body } : body) : undefined })
  const data = await res.json().catch(() => ({}))
  return { status: res.status, data }
}

async function join(proj, name) {
  const res = await req("/api/v1/join", { proj, body: { name, model: "mock-model", role: "开发" } })
  if (res.status !== 201) throw new Error(`${name} 入座失败 ${res.status} ${JSON.stringify(res.data)}`)
  return { id: res.data.agent.id, name: res.data.agent.name, token: res.data.token }
}

const messagesOf = async (proj) => (await req("/api/v1/room", { proj })).data.messages ?? []

// Rooms: the desk with its one seat, and a project with two seats.
const front = await req("/api/v1/projects", { body: { as: "human", front: true } })
check(front.status === 200 || front.status === 201, `建前台（${front.status}）`)
const deskId = front.data.project.id
const deskRoom = (await req("/api/v1/room", { proj: deskId })).data
const desk = deskRoom.agents?.find((item) => !item.demo) ? null : await join(deskId, `前台${stamp}`.slice(0, 20))
if (!desk) {
  console.error("这个副本的前台已经有人值班，换一个新副本再跑")
  process.exit(2)
}
const biz = await req("/api/v1/projects", { body: { as: "human", name: `转达房${stamp}` } })
check(biz.status === 201, "建普通项目")
const bizId = biz.data.project.id
const worker = await join(bizId, "工匠")
const other = await join(bizId, "旁人")
const seat = (who, extra) => ({ agentId: who.id, token: who.token, ...extra })
// For screenshots afterwards (still only the copy's own seats).
if (process.env.RELAY_SEATS_OUT) {
  const { writeFileSync } = await import("node:fs")
  writeFileSync(process.env.RELAY_SEATS_OUT, JSON.stringify({ id: desk.id, token: desk.token, wid: worker.id, wtoken: worker.token }), { mode: 0o600 })
}

// Only the desk's seat may draft.
const outsider = await req("/api/v1/relay", { body: seat(worker, { kind: "relay", project: bizId, seat: other.name, text: "hi" }) })
check(outsider.status === 403, `普通项目的席位起草转达被拒（${outsider.status}）`)
const toDesk = await req("/api/v1/relay", { body: seat(desk, { kind: "relay", project: deskId, seat: desk.name, text: "hi" }) })
check(toDesk.status === 400, `不能转达回前台自己（${toDesk.status}）`)
const nobody = await req("/api/v1/relay", { body: seat(desk, { kind: "relay", project: bizId, seat: "查无此人", text: "hi" }) })
check(nobody.status === 404, `没有的席位报 404（${nobody.status}）`)

// A relay draft: a card at the desk, nothing in the project.
const before = (await messagesOf(bizId)).length
const draft = await req("/api/v1/relay", {
  body: seat(desk, { kind: "relay", project: bizId, seat: worker.name, text: "@工匠 伤害基数先按 100 试试", why: "用户刚说的（m_x）" }),
})
check(draft.status === 200 && draft.data.relay?.state === "draft", `起草转达（${draft.status}）`)
const cardId = draft.data.messageId
const card = (await messagesOf(deskId)).find((item) => item.id === cardId)
check(card?.relay?.kind === "relay" && card.relay.text === "伤害基数先按 100 试试", `卡片在前台，原话去掉了开头的 @（${card?.relay?.text}）`)
check(card && card.mentions.length === 0 && !(card.calls?.length), "卡片不叫醒任何人")
check((await messagesOf(bizId)).length === before, "点「发出」前项目里什么都没有")

// The seat can't send it; the page can't without its key.
const seatSends = await req("/api/v1/relay", { body: seat(desk, { messageId: cardId, action: "send" }) })
check(seatSends.status === 400, `席位自己发不出去（${seatSends.status}）`)
const keyless = await req("/api/v1/relay", { proj: deskId, body: { as: "human", messageId: cardId, action: "send" }, withKey: false })
check(keyless.status === 401 || keyless.status === 403, `没有页面口令发不出去（${keyless.status}）`)
check((await messagesOf(bizId)).length === before, "被拒的两次都没发进项目")

// The user edits and sends it.
const sent = await req("/api/v1/relay", { proj: deskId, body: { as: "human", messageId: cardId, action: "send", text: "伤害基数先按 120 试试" } })
check(sent.status === 200 && sent.data.relay?.state === "sent", `发出（${sent.status} ${JSON.stringify(sent.data.error ?? "")}）`)
const landed = (await messagesOf(bizId)).find((item) => item.id === sent.data.sent?.id)
check(landed?.authorId === "human", "发进项目的那句署名是用户")
check(landed?.text.startsWith("@工匠 （经前台）") && landed.text.endsWith("伤害基数先按 120 试试"), `带上「经前台」和改过的原话（${landed?.text}）`)
check(landed?.mentions?.includes(worker.id) && !landed.mentions.includes(other.id), "点到工匠，没点旁人")
const after = (await messagesOf(deskId)).find((item) => item.id === cardId)
check(after?.relay?.state === "sent" && after.relay.sentId === landed?.id && after.relay.text === "伤害基数先按 120 试试", "卡片记下已发出和改后的字")
const again = await req("/api/v1/relay", { proj: deskId, body: { as: "human", messageId: cardId, action: "send" } })
check(again.status === 409, `同一张卡片不能发两次（${again.status}）`)

// A nudge with its default wording, then dropped.
const owed = await req("/api/v1/tasks", { proj: bizId, body: { as: "human", title: `补回滚脚本${stamp}`, owner: other.name, steps: ["写脚本", "演练"] } })
const nudge = await req("/api/v1/relay", { body: seat(desk, { kind: "nudge", project: bizId, seat: other.name, task: owed.data.task.id }) })
check(nudge.status === 200 && nudge.data.relay.text.includes(owed.data.task.id) && nudge.data.relay.taskTitle === `补回滚脚本${stamp}`, `催一下的默认问法带上待办（${nudge.data.relay?.text}）`)
const dropped = await req("/api/v1/relay", { proj: deskId, body: { as: "human", messageId: nudge.data.messageId, action: "drop" } })
check(dropped.status === 200 && dropped.data.relay.state === "dropped", "不发")
const lateSend = await req("/api/v1/relay", { proj: deskId, body: { as: "human", messageId: nudge.data.messageId, action: "send" } })
check(lateSend.status === 409, `不发之后不能再发（${lateSend.status}）`)

// A review card: only for a to-do waiting on the user; passing is the user's click.
const task = await req("/api/v1/tasks", { proj: bizId, body: seat(worker, { title: `对账单${stamp}`, owner: worker.name, steps: ["核对", "请用户验收"] }) })
const taskId = task.data.task.id
const early = await req("/api/v1/relay", { body: seat(desk, { kind: "review", project: bizId, task: taskId }) })
check(early.status === 400, `没在等验收的待办不出卡片（${early.status}）`)
await req(`/api/v1/tasks/${taskId}`, { proj: bizId, body: seat(worker, { action: "review", note: "导出的报表请核对" }) })
const review = await req("/api/v1/relay", { body: seat(desk, { kind: "review", project: bizId, task: taskId, why: "核对过步骤都做完了" }) })
check(review.status === 200 && review.data.relay.text === "导出的报表请核对" && review.data.relay.seatName === worker.name, "等验收卡片带上说明和负责人")
const notSend = await req("/api/v1/relay", { proj: deskId, body: { as: "human", messageId: review.data.messageId, action: "send" } })
check(notSend.status === 400, `验收卡片不能「发出」（${notSend.status}）`)
const passed = await req("/api/v1/relay", { proj: deskId, body: { as: "human", messageId: review.data.messageId, action: "pass" } })
check(passed.status === 200 && passed.data.relay.state === "passed", `通过（${passed.status} ${JSON.stringify(passed.data.error ?? "")}）`)
const doneTask = (await req("/api/v1/room", { proj: bizId })).data.tasks.find((item) => item.id === taskId)
check(doneTask?.review?.state === "passed" && doneTask.status === "done", "那条待办在项目里验收通过了")
const passTwice = await req("/api/v1/relay", { proj: deskId, body: { as: "human", messageId: review.data.messageId, action: "pass" } })
check(passTwice.status === 409, `不能通过两次（${passTwice.status}）`)

if (failed) {
  console.log(`relay: ${failed} failed`)
  process.exit(1)
}
console.log("relay ok")
