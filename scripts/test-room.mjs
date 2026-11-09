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

  // Attachments travel as paths: a pasted image is saved by the room first.
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
  const up = await request("/api/v1/files", { method: "POST", body: { as: "human", name: `自测${stamp}.png`, type: "image/png", data: png } })
  assert(up.status === 201 && up.data.attachment.kind === "image", `传图失败 ${up.data.error || up.status}`)
  const withFiles = await request("/api/v1/say", {
    method: "POST",
    body: { as: "human", text: `@乙${stamp} 看图`, attachments: [up.data.attachment, { path: process.cwd() }] },
  })
  assert(withFiles.status === 200, `带附件发言失败 ${withFiles.data.error || ""}`)
  const sent = withFiles.data.message.attachments
  assert(sent.length === 2 && sent[1].kind === "dir", "附件没带上，或文件夹没认出来")
  const seen = await request("/api/v1/inbox", {
    method: "POST",
    body: { agentId: beta.data.agent.id, token: beta.data.token, after: 0 },
  })
  assert(
    seen.data.forYou.some((message) => message.attachments?.some((item) => item.path === up.data.attachment.path)),
    "乙看不到附件路径",
  )
  const image = await fetch(`${origin}/api/v1/files?path=${encodeURIComponent(up.data.attachment.path)}&project=${project}`)
  assert(image.status === 200 && image.headers.get("content-type") === "image/png", "取不回传上的图片")
  const outside = await fetch(`${origin}/api/v1/files?path=${encodeURIComponent("/etc/hostname")}&project=${project}`)
  assert(outside.status === 404, "房间外的文件不该能取")
  const missing = await request("/api/v1/say", {
    method: "POST",
    body: { as: "human", text: "不存在的附件", attachments: [{ path: "/no/such/file" }] },
  })
  assert(missing.status === 400, "不存在的附件应该被拒绝")

  // A feature's to-do list: steps go on with the task, are moved along one
  // at a time with who and when, and show up in the room.
  const todo = await request("/api/v1/tasks", {
    method: "POST",
    body: { agentId: alpha.data.agent.id, token: alpha.data.token, title: "待办自测", owner: `甲${stamp}`, steps: ["写接口", "画界面"] },
  })
  assert(todo.status === 201 && todo.data.task.steps?.length === 2, `建待办失败 ${todo.data.error || todo.status}`)
  const started = await request(`/api/v1/tasks/${todo.data.task.id}`, {
    method: "POST",
    body: { agentId: alpha.data.agent.id, token: alpha.data.token, action: "step", step: 1, state: "done", note: "自测过了", add: ["验收"] },
  })
  const steps = started.data.task?.steps ?? []
  assert(started.status === 200 && steps.length === 3, `推进步骤失败 ${started.data.error || started.status}`)
  assert(steps[0].state === "done" && steps[0].doneAt && steps[0].note === "自测过了" && steps[2].state === "todo", "步骤状态没记对")
  assert(started.data.task.history.some((event) => event.action === "做完第 1 步"), "步骤推进没写进历史")
  const wrong = await request(`/api/v1/tasks/${todo.data.task.id}`, {
    method: "POST",
    body: { as: "human", action: "step", step: 9, state: "done" },
  })
  assert(wrong.status === 404, "不存在的步骤应该 404")

  // Replies are data an agent can read: the inbox says what each line
  // answers, and /messages hands back a whole chain, structured.
  const question = await request("/api/v1/say", { method: "POST", body: { as: "human", text: "回复链的起点" } })
  const answer = await request("/api/v1/say", {
    method: "POST",
    body: { agentId: beta.data.agent.id, token: beta.data.token, text: "我来回", replyTo: question.data.message.id },
  })
  await request("/api/v1/say", {
    method: "POST",
    body: { agentId: alpha.data.agent.id, token: alpha.data.token, text: "接着回", replyTo: answer.data.message.id },
  })
  const box = await request("/api/v1/inbox", {
    method: "POST",
    body: { agentId: alpha.data.agent.id, token: alpha.data.token, after: question.data.message.seq - 1 },
  })
  const hinted = box.data.messages.find((message) => message.id === answer.data.message.id)
  assert(hinted?.reply?.id === question.data.message.id && hinted.reply.gist === "回复链的起点", "收件箱没说这条回复的是哪条")
  const chain = await request("/api/v1/messages", {
    method: "POST",
    body: { agentId: alpha.data.agent.id, token: alpha.data.token, chain: answer.data.message.id },
  })
  assert(chain.status === 200, `取回复链失败 ${chain.data.error || chain.status}`)
  assert(
    chain.data.messages.map((message) => message.text).join("|") === "回复链的起点|我来回|接着回",
    "回复链不完整或顺序不对",
  )
  assert(chain.data.messages[0].author.type === "human" && chain.data.messages[1].author.type === "agent", "作者类型不对")
  const recent = await request("/api/v1/messages", {
    method: "POST",
    body: { agentId: alpha.data.agent.id, token: alpha.data.token, limit: 2 },
  })
  assert(recent.data.messages.length === 2 && recent.data.hasMore === true, "limit 或 hasMore 不对")
  const theirs = await request("/api/v1/messages", {
    method: "POST",
    body: { agentId: alpha.data.agent.id, token: alpha.data.token, about: beta.data.agent.name },
  })
  assert(theirs.data.messages.every((message) => message.author.id === beta.data.agent.id || message.mentions.includes(beta.data.agent.name) || message.handoff), "about 混进了无关的消息")

  // Replying to an agent calls it like an @ would, when the user does it; an
  // agent's reply alone calls nobody. A seat without a session can't be
  // woken, so the room says it was called with a system note.
  const wu = await request("/api/v1/join", { method: "POST", body: { name: `戊${stamp}`, model: "x", role: "被回复" } })
  const wuSaid = await request("/api/v1/say", {
    method: "POST",
    body: { agentId: wu.data.agent.id, token: wu.data.token, text: "戊说的一句" },
  })
  const calledBy = async (body) => {
    const sent = await request("/api/v1/say", { method: "POST", body: { ...body, replyTo: wuSaid.data.message.id } })
    await new Promise((resolve) => setTimeout(resolve, 300))
    const room = await request(`/api/v1/room?project=${project}`)
    return room.data.messages.some(
      (message) => message.kind === "system" && message.seq > sent.data.message.seq && message.text.includes(`戊${stamp}`),
    )
  }
  assert(!(await calledBy({ agentId: alpha.data.agent.id, token: alpha.data.token, text: "agent 回一句" })), "agent 只回复不该叫醒人")
  assert(await calledBy({ as: "human", text: "人回一句，没有 @" }), "人回复 agent 的消息应该叫醒它")

  // An agent ends the round: it calls nobody, and agents stop waking each
  // other until the user speaks again.
  const ended = await request("/api/v1/say", {
    method: "POST",
    body: { agentId: alpha.data.agent.id, token: alpha.data.token, text: `导航交完了 @乙${stamp}`, end: true },
  })
  assert(ended.status === 200 && ended.data.message.end === true, `结束本轮失败 ${ended.data.error || ""}`)
  assert(ended.data.message.mentions.length === 0, "结束本轮的消息不该点到谁")
  assert(ended.data.message.text.startsWith("【本轮结束】"), "结束本轮的消息没带标记")
  let closed = await request(`/api/v1/room?project=${project}`)
  assert(closed.data.relayClosed === true, "结束本轮后接力没停")
  const marked = await request("/api/v1/say", {
    method: "POST",
    body: { agentId: beta.data.agent.id, token: beta.data.token, text: "【本轮结束】我这边也好了" },
  })
  assert(marked.data.message.end === true, "以标记开头的回答没认成结束本轮")
  const mimic = await request("/api/v1/say", { method: "POST", body: { as: "human", text: "【本轮结束】人说的不算" } })
  assert(!mimic.data.message.end, "人说的话不该当成结束本轮")
  closed = await request(`/api/v1/room?project=${project}`)
  assert(closed.data.relayClosed === false, "人发话后接力没恢复")

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
