const origin = (process.env.BENCH_URL || "http://127.0.0.1:4399").replace(/\/$/, "")

// Runs in a project of its own, deleted at the end; the projects in use are
// left alone. Every call names it.
let project = ""

async function request(pathname, { method = "GET", body } = {}) {
  const res = await fetch(`${origin}${pathname}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(project ? { project, ...body } : body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  return { status: res.status, data }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function main() {
  const stamp = Date.now().toString(36)
  const made = await request("/api/v1/projects", { method: "POST", body: { as: "human", name: `自测${stamp}` } })
  assert(made.status === 201, `建测试项目失败 ${made.status} ${made.data.error || ""}`)
  project = made.data.project.id
  try {
    await steps(stamp)
  } finally {
    const id = project
    project = ""
    await request(`/api/v1/projects/${id}`, { method: "POST", body: { as: "human", action: "delete", confirm: "删除" } })
  }
  console.log("room ok")
}

async function steps(stamp) {
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

  // Mentions hold the seat, not the name: renaming carries the old messages
  // along, and the old name still reaches the seat.
  const renamed = await request(`/api/v1/agents/${beta.data.agent.id}`, {
    method: "POST",
    body: { as: "human", action: "rename", name: `丙${stamp}` },
  })
  assert(renamed.status === 200 && renamed.data.agent.name === `丙${stamp}`, `改名失败 ${renamed.data.error || ""}`)
  const after = await request(`/api/v1/room?project=${project}`)
  const old = after.data.messages.find((message) => message.id === said.data.message.id)
  assert(old.text.includes(`@丙${stamp}`) && !old.text.includes(`@乙${stamp}`), "改名后旧消息里的点名没换成新名字")
  assert(old.mentions.includes(beta.data.agent.id), "改名后旧消息点到的人变了")
  const byOld = await request("/api/v1/say", {
    method: "POST",
    body: { agentId: alpha.data.agent.id, token: alpha.data.token, text: `@乙${stamp} 还在吗` },
  })
  assert(byOld.data.message.mentions.includes(beta.data.agent.id), "用旧名字点不到改名后的席位")
  assert(byOld.data.message.text.includes(`@丙${stamp}`), "旧名字的点名没写成现在的名字")
  const back = await request("/api/v1/join", { method: "POST", body: { token: beta.data.token, model: "composer" } })
  assert(back.status === 201 || back.status === 200, `带 token 回座失败 ${back.data.error || ""}`)
  assert(back.data.agent.id === beta.data.agent.id && back.data.agent.name === `丙${stamp}`, "不带名字回座时名字被改回去了")
  const self = await request("/api/v1/join", { method: "POST", body: { token: beta.data.token, name: `丁${stamp}`, rename: true } })
  assert(self.data.agent?.id === beta.data.agent.id && self.data.agent.name === `丁${stamp}`, "席位自己改名失败")
  const stale = await request("/api/v1/join", { method: "POST", body: { token: beta.data.token, name: `乙${stamp}` } })
  assert(stale.data.agent?.name === `丁${stamp}`, "旧版桥带着旧名字回座，把改好的名字改回去了")
  const clash = await request(`/api/v1/agents/${beta.data.agent.id}`, {
    method: "POST",
    body: { as: "human", action: "rename", name: `甲${stamp}` },
  })
  assert(clash.status === 409, "改成别人正在用的名字应该被拒绝")

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
      done: "导航的空状态",
      left: "失败时的提示语",
      caveats: "无",
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

  const cleared = await request("/api/v1/reset", {
    method: "POST",
    body: { confirm: "清空" },
  })
  assert(cleared.status === 200, "结束时清空失败")
  assert(cleared.data.agents.length === 0, "清空后还有席位")
  assert(cleared.data.project.id === project, "清空的不是测试项目")
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
