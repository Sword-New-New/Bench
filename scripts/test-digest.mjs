// Cases for digestOf (lib/digest.ts, the 「进展」 view): node scripts/test-digest.mjs
// With a room's snapshot instead: node scripts/test-digest.mjs --live <url> <project>
import { register } from "node:module"
register("./ts-alias.mjs", import.meta.url)
const { digestOf } = await import("../lib/digest.ts")

// --live: read one project's snapshot (GET only, no key) and print its digest.
if (process.argv[2] === "--live") {
  const [, , , url = "http://127.0.0.1:4399", project] = process.argv
  const projects = (await (await fetch(`${url}/api/v1/projects`)).json()).projects
  const id = project ?? projects.find((item) => !item.front)?.id
  const room = await (await fetch(`${url}/api/v1/room?project=${encodeURIComponent(id)}`)).json()
  const d = digestOf({ messages: room.messages, tasks: room.tasks, agents: room.agents, permits: room.permits, userName: room.userName, now: Date.now() })
  const show = (row) => `  ${row.id} ${row.title.slice(0, 30)}｜${row.owner?.name ?? "—"}｜${row.need ?? ""} ${row.line.slice(0, 50)}｜${row.messageIds.length} 条`
  console.log(`「${room.project.name}」 counts ${JSON.stringify(d.counts)}，talk ${d.talk.length}`)
  for (const group of ["you", "stuck", "doing", "done"]) {
    console.log(`${group}:`)
    for (const row of d[group]) console.log(show(row))
  }
  console.log(`talk（前 5）:`)
  for (const row of d.talk.slice(0, 5)) console.log(show(row))
  process.exit(0)
}

const now = new Date(2026, 10, 14, 23, 0).getTime()
const min = 60_000
let seq = 0
const msg = (over) => ({ id: `m_${(++seq).toString(16).padStart(8, "0")}`, seq, kind: "chat", authorId: "human", authorName: "用户", authorColor: "#000", authorDemo: false, text: "", mentions: [], createdAt: now - 60 * min + seq * min, ...over })
const step = (text, state) => ({ id: `s_${text}`, text, state, by: "x", at: 0, updatedAt: 0 })
const task = (id, over) => ({ id, seq: 1, title: `待办${id}`, detail: "", status: "doing", ownerId: null, ownerName: null, createdById: "a_fable", createdByName: "Fable", updatedAt: now - 30 * min, history: [], steps: [step("做事", "doing"), step("用户验收", "todo")], ...over })
const seat = (id, over) => ({ id, name: `席${id.slice(2)}`, model: "m", role: "", status: "idle", doing: "", lastSeenAt: now, createdAt: now, ...over })

const T = (n) => `t_${String(n).padStart(8, "0")}`
const seats = ["a_1", "a_2", "a_3", "a_4", "a_5", "a_6", "a_7", "a_8"].map((id) => seat(id))
seats[2] = seat("a_3", { runId: "r_3" })
seats[4] = seat("a_5", { owes: { since: now - 40 * min, tasks: [{ id: T(5), title: "x" }], calls: [] } })
seats[6] = seat("a_7", { runId: "r_7", status: "working", doing: "在跑测试" })

const tasks = [
  task(T(1), { ownerId: "a_1", ownerName: "席1", steps: [step("做事", "done"), step("用户验收", "todo")], review: { state: "waiting", at: now - 50 * min, by: "席1", note: "做好了，刷新看。细节在后面。" } }),
  task(T(2), { ownerId: "a_2", ownerName: "席2" }),
  task(T(3), { ownerId: "a_3", ownerName: "席3" }),
  task(T(4), { ownerId: "a_4", ownerName: "席4", status: "blocked", history: [{ at: now, actor: "席4", action: "卡住", note: "等别人的接口。之后再做" }] }),
  task(T(5), { ownerId: "a_5", ownerName: "席5" }),
  task(T(6), { ownerId: "a_6", ownerName: "席6" }),
  task(T(7), { ownerId: "a_7", ownerName: "席7" }),
  task(T(8), { ownerId: "a_1", ownerName: "席1", status: "done", updatedAt: now - 60 * min }),
  task(T(9), { ownerId: "a_1", ownerName: "席1", status: "done", updatedAt: now - 30 * 60 * min }),
  task(T(10), {}),
  task(T(11), { ownerId: "a_8", ownerName: "席8", steps: [step("第一步", "todo"), step("用户验收", "todo")] }),
]

const dispatch = msg({ authorId: "a_fable", authorName: "Fable", text: `@席1 请接 ${T(1)}，@席2 请接 ${T(2)}` })
const reply1 = msg({ authorId: "a_1", authorName: "席1", replyTo: dispatch.id, text: "我这边做完了，等验收。" })
const ask2 = msg({ authorId: "a_2", authorName: "席2", text: "要用哪种格式？", ask: { state: "open", options: [{ label: "A" }] } })
const both = msg({ authorId: "a_fable", authorName: "Fable", text: `${T(3)} 和 ${T(4)} 一起看`, attachments: [{ kind: "image", name: "a.png", path: "/a.png" }] })
const failed = msg({ text: `@席6 接着做 ${T(6)}`, calls: [{ id: "a_6", name: "席6", state: "failed", at: now - 20 * min, note: "ECONNRESET" }] })
const talkRoot = msg({ text: "@席8 问个事：这里为什么慢" })
const talkReply = msg({ authorId: "a_8", authorName: "席8", replyTo: talkRoot.id, text: "因为开发模式慢。正式构建会快几倍。" })
const lonely = msg({ text: "自言自语，没人回" })
const sys = msg({ kind: "system", authorId: "room", authorName: "并坐", text: `唤起 席6 没成功 ${T(6)}` })
const messages = [dispatch, reply1, ask2, both, failed, talkRoot, talkReply, lonely, sys]
const permits = [{ id: "p_1", agentId: "a_3", agentName: "席3", kind: "tool", tool: "Bash", input: "rm -rf build", at: now - 10 * min }]

const d = digestOf({ messages, tasks, agents: seats, permits, userName: "用户", now })
const row = (id) => [...d.you, ...d.stuck, ...d.doing, ...d.done, ...d.talk].find((item) => item.id === id)
let failedCount = 0
const check = (ok, what, got) => {
  if (ok) return
  failedCount++
  console.error(`✗ ${what}\n  got ${JSON.stringify(got)}`)
}

check(row(T(1))?.state === "you" && row(T(1)).need === "review" && row(T(1)).line === "做好了，刷新看。", "等验收：you/review，line 取说明第一句", row(T(1)))
check(row(T(1))?.messageIds.join() === [dispatch.id, reply1.id].join(), "派活那条和同链里负责人没点 id 的回复都归它", row(T(1))?.messageIds)
check(!row(T(2))?.messageIds.includes(reply1.id), "同一条链里别人负责的回复不归它", row(T(2))?.messageIds)
check(row(T(2))?.state === "you" && row(T(2)).need === "answer" && row(T(2)).askId === ask2.id && row(T(2)).line === "要用哪种格式？", "负责人有没回答的提问：you/answer", row(T(2)))
check(row(T(3))?.state === "you" && row(T(3)).need === "permit" && row(T(3)).permitId === "p_1", "负责人这次唤起有权限卡片在等：you/permit", row(T(3)))
check(row(T(3))?.messageIds.includes(both.id) && row(T(4))?.messageIds.includes(both.id), "一条消息点了两条待办，两条都有它", [row(T(3))?.messageIds, row(T(4))?.messageIds])
check(row(T(3))?.attachments === 1, "附件数", row(T(3))?.attachments)
check(row(T(4))?.state === "stuck" && row(T(4)).line === "卡住：等别人的接口。", "标了卡住：stuck，line 是原因", row(T(4)))
check(row(T(5))?.state === "stuck" && row(T(5)).since === now - 40 * min && row(T(5)).line.startsWith("停着，还欠这件"), "负责人停着欠着：stuck，since 取 owes", row(T(5)))
check(row(T(6))?.state === "stuck" && row(T(6)).line === "没叫成：ECONNRESET", "最近一次点名没成功：stuck", row(T(6)))
check(!row(T(6))?.messageIds.includes(sys.id), "系统消息不归进去", row(T(6))?.messageIds)
check(row(T(7))?.state === "doing" && row(T(7)).line === "在跑测试", "负责人在跑：doing，line 是在做什么", row(T(7)))
check(row(T(8))?.state === "done" && row(T(8)).line === "已验收", "今天做完：done", row(T(8)))
check(!row(T(9)), "昨天做完的不在今天做完里", row(T(9)))
check(row(T(10))?.state === "stuck" && row(T(10)).line === "没人负责", "没人负责：stuck", row(T(10)))
check(row(T(11))?.state === "stuck" && row(T(11)).line === "还没开始" && row(T(11)).steps?.current === "第一步", "其余：stuck 并写明还没开始", row(T(11)))
check(row(talkRoot.id)?.kind === "talk" && row(talkRoot.id).line === "因为开发模式慢。正式构建会快几倍。" && row(talkRoot.id).owner?.id === "a_8", "没挂待办的对话：talk，line 是最新回复的摘要", row(talkRoot.id))
check(!row(lonely.id), "没有 agent 回复的不算 talk", row(lonely.id))
check(d.you.map((item) => item.id).join() === [T(2), T(1), T(3)].join(), "you 按等了多久排，久的在前（提问 57 分钟前、验收 50 分钟前、权限 10 分钟前）", d.you.map((item) => item.id))
check(d.stuck[0]?.id === T(5), "stuck 按停了多久排", d.stuck.map((item) => item.id))
check(JSON.stringify(d.counts) === JSON.stringify({ you: 3, stuck: 5, doing: 1, done: 1 }), "counts", d.counts)

// Tied by taskId, its id never written: the owner's replies under it, with
// their attachments, still belong to the to-do (GPT2's check, 2026-11-17).
{
  const tied = msg({ text: "@席1 照这个改一下", taskId: T(20) })
  const answer = msg({ authorId: "a_1", authorName: "席1", replyTo: tied.id, text: "改好了。截图在附件。", attachments: [{ kind: "image", name: "b.png", path: "/b.png" }] })
  const own = [task(T(20), { ownerId: "a_1", ownerName: "席1", updatedAt: now - 59 * min })]
  const r = digestOf({ messages: [tied, answer], tasks: own, agents: seats, permits: [], userName: "用户", now }).doing.concat(
    digestOf({ messages: [tied, answer], tasks: own, agents: seats, permits: [], userName: "用户", now }).stuck,
  ).find((item) => item.id === T(20))
  check(r?.messageIds.join() === [tied.id, answer.id].join() && r.attachments === 1 && r.at === answer.createdAt, "用 taskId 挂上的起头消息，下面没写编号的回复和附件也归这条待办", r)
}
// The owner's open question came before the to-do's last message: the
// messages still go oldest first.
{
  const asked = msg({ authorId: "a_2", authorName: "席2", text: "先问一句：要哪种？", ask: { state: "open", options: [{ label: "A" }] } })
  const later = msg({ authorId: "a_fable", authorName: "Fable", text: `${T(21)} 先放着` })
  const own = [task(T(21), { ownerId: "a_2", ownerName: "席2" })]
  const r = digestOf({ messages: [asked, later], tasks: own, agents: seats, permits: [], userName: "用户", now }).you.find((item) => item.id === T(21))
  check(r?.messageIds.join() === [asked.id, later.id].join(), "提问比待办的消息早时，消息仍从早到晚", r?.messageIds)
}

if (failedCount) {
  console.error(`digest: ${failedCount} failed`)
  process.exit(1)
}
console.log("digest ok")
