const origin = (process.env.BENCH_URL || "http://127.0.0.1:4399").replace(/\/$/, "")

async function request(pathname, { method = "GET", body } = {}) {
  const res = await fetch(`${origin}${pathname}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  return { status: res.status, data }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function main() {
  const reset = await request("/api/v1/reset", {
    method: "POST",
    body: { confirm: "清空" },
  })
  assert(reset.status === 200, `清空失败 ${reset.status} ${reset.data.error || ""}`)

  const stamp = Date.now().toString(36)
  const alpha = await request("/api/v1/join", {
    method: "POST",
    body: { name: `甲${stamp}`, model: "grok-4.7", role: "协调", strengths: ["拆任务"] },
  })
  assert(alpha.status === 201, `甲入座失败 ${alpha.data.error || alpha.status}`)
  const beta = await request("/api/v1/join", {
    method: "POST",
    body: { name: `乙${stamp}`, model: "composer", role: "实现", strengths: ["界面"] },
  })
  assert(beta.status === 201, `乙入座失败 ${beta.data.error || beta.status}`)

  const taken = await request("/api/v1/join", {
    method: "POST",
    body: { name: `甲${stamp}`, model: "other", role: "占用" },
  })
  assert(taken.status === 409, "重名应该被拒绝")

  const bad = await request("/api/v1/pulse", {
    method: "POST",
    body: { agentId: alpha.data.agent.id, token: "nope", status: "working", doing: "不该成功" },
  })
  assert(bad.status === 401, "错误 token 应该被拒绝")

  const pulse = await request("/api/v1/pulse", {
    method: "POST",
    body: {
      agentId: alpha.data.agent.id,
      token: alpha.data.token,
      status: "working",
      doing: "在把活交给乙",
    },
  })
  assert(pulse.status === 200, "报进度失败")
  assert(pulse.data.agent.doing === "在把活交给乙", "进度没有写上")

  const said = await request("/api/v1/say", {
    method: "POST",
    body: {
      agentId: alpha.data.agent.id,
      token: alpha.data.token,
      text: `乙来接导航 @乙${stamp}`,
    },
  })
  assert(said.status === 200, "发言失败")
  assert(said.data.message.mentions.includes(beta.data.agent.id), "没有点到乙")

  const inbox = await request("/api/v1/inbox", {
    method: "POST",
    body: { agentId: beta.data.agent.id, token: beta.data.token, after: 0 },
  })
  assert(inbox.status === 200, "收件箱失败")
  assert(inbox.data.forYou.some((message) => message.id === said.data.message.id), "乙没有看见点名")
  assert(inbox.data.peers.some((agent) => agent.doing === "在把活交给乙"), "乙看不见甲正在做什么")

  const task = await request("/api/v1/tasks", {
    method: "POST",
    body: {
      agentId: alpha.data.agent.id,
      token: alpha.data.token,
      title: `导航空状态 ${stamp}`,
      owner: beta.data.agent.id,
    },
  })
  assert(task.status === 201, `建任务失败 ${task.data.error || ""}`)
  assert(task.data.task.ownerId === beta.data.agent.id, "负责人不是乙")

  const blocked = await request(`/api/v1/tasks/${task.data.task.id}`, {
    method: "POST",
    body: {
      agentId: alpha.data.agent.id,
      token: alpha.data.token,
      action: "claim",
    },
  })
  assert(blocked.status === 409, "已经有负责人时不应该再被认领")

  const handed = await request(`/api/v1/tasks/${task.data.task.id}`, {
    method: "POST",
    body: {
      agentId: beta.data.agent.id,
      token: beta.data.token,
      action: "handoff",
      to: alpha.data.agent.name,
      note: "空状态好了，请看失败时谁负责说",
    },
  })
  assert(handed.status === 200, `交接失败 ${handed.data.error || ""}`)
  assert(handed.data.task.ownerId === alpha.data.agent.id, "交接后负责人没变")
  assert(handed.data.message.kind === "handoff", "交接没有写进群聊")

  const done = await request(`/api/v1/tasks/${task.data.task.id}`, {
    method: "POST",
    body: { as: "human", action: "done", note: "这阶段可以收了" },
  })
  assert(done.status === 200 && done.data.task.status === "done", "完成任务失败")

  await request("/api/v1/leave", {
    method: "POST",
    body: { agentId: alpha.data.agent.id, token: alpha.data.token },
  })
  await request("/api/v1/leave", {
    method: "POST",
    body: { agentId: beta.data.agent.id, token: beta.data.token },
  })

  const seated = await request("/api/v1/demo", { method: "POST", body: { action: "seat" } })
  assert(seated.status === 200, "演示入座失败")
  assert(seated.data.agents.some((agent) => agent.name === "阿衡"), "没有阿衡")

  const human = await request("/api/v1/say", {
    method: "POST",
    body: { as: "human", text: "做一版定价页，手机上要能扫，做完看一遍边界" },
  })
  assert(human.status === 200, "人说话失败")

  let room = null
  const started = Date.now()
  while (Date.now() - started < 15000) {
    const current = await request("/api/v1/room")
    room = current.data
    const reviewed = room.messages?.some((message) => message.authorName === "阿证")
    const finished = room.tasks?.some((task) => task.title.startsWith("复核：") && task.status === "done")
    if (reviewed && finished) break
    await sleep(400)
  }

  assert(room.messages.some((message) => message.authorName === "阿衡"), "阿衡没有接话")
  assert(room.messages.some((message) => message.kind === "handoff"), "没有交接卡片")
  assert(room.messages.some((message) => message.authorName === "阿构"), "阿构没有接活")
  assert(room.messages.some((message) => message.authorName === "阿证"), "阿证没有复核")
  assert(
    room.tasks.some((task) => task.title.startsWith("复核：") && task.status === "done"),
    "复核任务没有完成",
  )
  const builder = room.agents.find((agent) => agent.name === "阿构")
  assert(builder && builder.doing.length > 0, "阿构没有写下正在做的事")

  const cleared = await request("/api/v1/reset", {
    method: "POST",
    body: { confirm: "清空" },
  })
  assert(cleared.status === 200, "结束时清空失败")
  assert(cleared.data.agents.length === 0, "清空后还有席位")
  console.log("room ok")
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
