const origin = (process.env.BENCH_URL || "http://127.0.0.1:4399").replace(/\/$/, "")

// Runs in a project of its own, deleted at the end; the projects in use are
// left alone. Every call names it.
let project = ""

// as:"human" needs the user's key (lib/human.ts). It is only in
// data/human-key, never on the page: run this from the room's folder, or point
// BENCH_KEY_FILE at the file.
let humanKey = ""
async function pageKey() {
  const { readFileSync } = await import("node:fs")
  const file = process.env.BENCH_KEY_FILE || `${process.cwd()}/data/human-key`
  return readFileSync(file, "utf8").trim()
}

async function request(pathname, { method = "GET", body, key = true } = {}) {
  const res = await fetch(`${origin}${pathname}`, {
    method,
    headers: body
      ? { "content-type": "application/json", ...(key && body.as === "human" ? { "x-bench-human": humanKey } : {}) }
      : undefined,
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
  humanKey = await pageKey()
  assert(/^[0-9a-f]{64}$/.test(humanKey), "data/human-key 里没有口令")
  const page = await (await fetch(`${origin}/`)).text()
  assert(!page.includes(humanKey), "首页里不该出现口令")
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
  // Speaking for the user takes the page's key: without it, or with a wrong
  // one, an agent's curl can't post, approve permits or rename the user.
  for (const [path, body] of [
    ["/api/v1/say", { as: "human", text: "冒充用户" }],
    ["/api/v1/permit", { as: "human", action: "elevate", agentId: alpha.data.agent.id, allow: true }],
    ["/api/v1/user", { as: "human", name: "冒名" }],
  ]) {
    const bare = await request(path, { method: "POST", body, key: false })
    assert(bare.status === 403, `不带口令的 as:human 应该被拒：${path} 得到 ${bare.status}`)
  }
  const forged = await fetch(`${origin}/api/v1/say`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-bench-human": "0".repeat(64) },
    body: JSON.stringify({ project, as: "human", text: "冒充用户" }),
  })
  assert(forged.status === 403, `口令不对的 as:human 应该被拒，得到 ${forged.status}`)

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

  // A sound in a report: told by its extension, and served in byte ranges so
  // the player can seek. A tenth of a second of silence as a WAV.
  const samples = 800
  const wav = Buffer.alloc(44 + samples * 2)
  wav.write("RIFF", 0); wav.writeUInt32LE(36 + samples * 2, 4); wav.write("WAVEfmt ", 8)
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34)
  wav.write("data", 36); wav.writeUInt32LE(samples * 2, 40)
  const sound = await request("/api/v1/files", {
    method: "POST",
    body: { as: "human", name: `自测${stamp}.wav`, type: "audio/wav", data: wav.toString("base64") },
  })
  assert(sound.status === 201 && sound.data.attachment.kind === "audio", `音频没认出来 ${sound.data.error || sound.status}`)
  const report = await request("/api/v1/say", {
    method: "POST",
    body: { agentId: alpha.data.agent.id, token: alpha.data.token, text: "带音频的汇报", attachments: [{ path: sound.data.attachment.path }] },
  })
  assert(report.data.message?.attachments?.[0]?.kind === "audio", "席位发的音频附件没记成 audio")
  const part = await fetch(`${origin}/api/v1/files?path=${encodeURIComponent(sound.data.attachment.path)}&project=${project}`, {
    headers: { range: "bytes=40-43" },
  })
  const bytes = Buffer.from(await part.arrayBuffer())
  assert(
    part.status === 206 && part.headers.get("content-type") === "audio/wav" &&
      part.headers.get("content-range") === `bytes 40-43/${wav.length}` && bytes.readUInt32LE(0) === samples * 2,
    `音频不能按段取 ${part.status} ${part.headers.get("content-range")}`,
  )

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

  // The sign-off is the user's: an agent asks for it, and only the user
  // passes it or sends it back with a reason that calls the owner.
  const taskPath = `/api/v1/tasks/${todo.data.task.id}`
  const asAlpha = { agentId: alpha.data.agent.id, token: alpha.data.token }
  const selfTick = await request(taskPath, { method: "POST", body: { ...asAlpha, action: "step", step: 3, state: "done" } })
  assert(selfTick.status === 403, "agent 不该能自己勾验收那一步")
  const selfDone = await request(taskPath, { method: "POST", body: { ...asAlpha, action: "done" } })
  assert(selfDone.status === 403, "还没验收，agent 不该能把待办标完成")
  const asked = await request(taskPath, { method: "POST", body: { ...asAlpha, action: "review", note: "右栏看效果" } })
  assert(asked.status === 200 && asked.data.task.review?.state === "waiting" && asked.data.task.steps[2].state === "doing", `请验收失败 ${asked.data.error || asked.status}`)
  const agentPass = await request(taskPath, { method: "POST", body: { ...asAlpha, action: "pass" } })
  assert(agentPass.status === 403, "agent 不该能点验收通过")
  const bare = await request(taskPath, { method: "POST", body: { as: "human", action: "reject" } })
  assert(bare.status === 400, "打回不写原因应该被拒绝")
  const sentBack = await request(taskPath, { method: "POST", body: { as: "human", action: "reject", note: "按钮太挤" } })
  assert(sentBack.status === 200 && sentBack.data.task.review?.state === "rejected" && sentBack.data.task.status === "doing", `打回失败 ${sentBack.data.error || sentBack.status}`)
  assert(sentBack.data.task.steps[2].state === "todo", "打回后验收那一步应该退回待做")
  assert(sentBack.data.message?.mentions?.includes(alpha.data.agent.id) && sentBack.data.message.text.includes("按钮太挤"), "打回要带着原因叫负责人")
  await request(taskPath, { method: "POST", body: { ...asAlpha, action: "review" } })
  const passed = await request(taskPath, { method: "POST", body: { as: "human", action: "pass" } })
  assert(passed.status === 200 && passed.data.task.status === "done" && passed.data.task.steps[2].state === "done", `验收通过失败 ${passed.data.error || passed.status}`)
  assert(passed.data.message?.mentions?.length === 0 && passed.data.message.text.startsWith("验收通过") && passed.data.message.verdict?.ownerId === alpha.data.agent.id, "验收通过要在群里说一声、不叫人")
  const verdicts = await request("/api/v1/messages", { method: "POST", body: { ...asAlpha, limit: 5 } })
  const verdictLine = verdicts.data.messages?.find((item) => item.id === passed.data.message.id)
  assert(verdictLine?.verdict?.owner?.id === alpha.data.agent.id && verdictLine.verdict.state === "passed", "bench_messages 里的验收消息要带负责人的席位 id")

  // A finished task is a record: nothing on it changes, from the agent or the
  // user. Going on means copying it (fork), which leaves the original alone.
  const taskBefore = JSON.stringify((await request(`/api/v1/room?project=${project}`)).data.tasks.find((item) => item.id === passed.data.task.id))
  const attempts = [
    { ...asAlpha, action: "step", add: ["偷偷加一步"] },
    { ...asAlpha, action: "step", step: 1, state: "todo", note: "想改回去" },
    { ...asAlpha, action: "review" },
    { ...asAlpha, action: "block" },
    { as: "human", action: "step", step: 1, state: "todo" },
    { as: "human", action: "done" },
    { as: "human", action: "reject", note: "再打回" },
  ]
  for (const body of attempts) {
    const refused = await request(taskPath, { method: "POST", body })
    assert(refused.status === 409, `已完成的待办不该能改：${body.action} 得到 ${refused.status}`)
  }
  const taskAfter = JSON.stringify((await request(`/api/v1/room?project=${project}`)).data.tasks.find((item) => item.id === passed.data.task.id))
  assert(taskBefore === taskAfter, "拒绝之后，已完成的待办一点都不该变")
  const forked = await request(taskPath, { method: "POST", body: { as: "human", action: "fork" } })
  assert(forked.status === 200 && forked.data.task.id !== passed.data.task.id, `复制失败 ${forked.data.error || forked.status}`)
  assert(forked.data.task.title === passed.data.task.title && forked.data.task.forkedFrom?.id === passed.data.task.id, "复制出来的待办要写明从哪条来")
  assert(
    forked.data.task.steps?.length === passed.data.task.steps.length && forked.data.task.steps.every((step) => step.state === "todo"),
    "复制出来的步骤要一样多，并且全部重新开始",
  )
  assert(forked.data.task.status !== "done", "复制出来的待办不该是已完成")
  const originalAfterFork = JSON.stringify((await request(`/api/v1/room?project=${project}`)).data.tasks.find((item) => item.id === passed.data.task.id))
  assert(originalAfterFork === taskBefore, "复制之后原来那条不该变")

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
  // Ending a round stops only that message's line: another agent's @ right
  // after it still calls (it used to be dropped silently until the user spoke).
  const ji = await request("/api/v1/join", { method: "POST", body: { name: `己${stamp}`, model: "x", role: "被点名" } })
  const afterEnd = await request("/api/v1/say", {
    method: "POST",
    body: { agentId: beta.data.agent.id, token: beta.data.token, text: `@己${stamp} 接着做` },
  })
  assert(afterEnd.data.message.mentions.includes(ji.data.agent.id), "结束本轮后 @ 没点到人")
  await new Promise((resolve) => setTimeout(resolve, 300))
  const afterRoom = await request(`/api/v1/room?project=${project}`)
  assert(
    afterRoom.data.messages.some((message) => message.kind === "system" && message.seq > afterEnd.data.message.seq && message.text.includes(`己${stamp} 被点到了`)),
    "别的席位结束本轮后，agent 之间的 @ 被悄悄挡掉了",
  )
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

  // Recall: the user takes a message back; the line stays, its words are gone
  // and no agent sees it.
  const secret = await request("/api/v1/say", { method: "POST", body: { as: "human", text: "撤回测试：口令 4399" } })
  const secretId = secret.data.message.id
  const notHuman = await request("/api/v1/recall", {
    method: "POST",
    body: { agentId: alpha.data.agent.id, token: alpha.data.token, id: secretId },
  })
  assert(notHuman.status === 403, "agent 不能撤回")
  const agentSaid = await request("/api/v1/say", {
    method: "POST",
    body: { agentId: alpha.data.agent.id, token: alpha.data.token, text: "agent 的话" },
  })
  const notMineRecall = await request("/api/v1/recall", { method: "POST", body: { as: "human", id: agentSaid.data.message.id } })
  assert(notMineRecall.status === 403, "不能撤回 agent 的消息")
  const recalled = await request("/api/v1/recall", { method: "POST", body: { as: "human", id: secretId } })
  assert(recalled.status === 200 && recalled.data.original.text === "撤回测试：口令 4399", "撤回失败或没带回原文")
  assert(recalled.data.message.recalled && recalled.data.message.text === "", "撤回后不该还留着原文")
  const recallAgain = await request("/api/v1/recall", { method: "POST", body: { as: "human", id: secretId } })
  assert(recallAgain.status === 409, "撤回过的不能再撤回")
  const recallRoom = await request(`/api/v1/room?project=${project}`)
  assert(!JSON.stringify(recallRoom.data).includes("口令 4399"), "房间快照里还能看到撤回的内容")
  const betaInbox = await request("/api/v1/inbox", {
    method: "POST",
    body: { agentId: beta.data.agent.id, token: beta.data.token, after: 0 },
  })
  assert(!betaInbox.data.messages.some((message) => message.id === secretId), "收件箱里不该有撤回的消息")
  const asData = await request("/api/v1/messages", {
    method: "POST",
    body: { agentId: beta.data.agent.id, token: beta.data.token, limit: 200 },
  })
  const recalledData = asData.data.messages.find((message) => message.id === secretId)
  assert(recalledData?.recalled === true && recalledData.text === "", "bench_messages 里应该只标已撤回")

  // Permission prompts: a seat's request waits on the page until the user
  // allows or denies it; full permission lets the rest through at once.
  const seatA = { agentId: alpha.data.agent.id, token: alpha.data.token }
  const pendingPermit = request("/api/v1/permit", { method: "POST", body: { ...seatA, action: "tool", tool: "Bash", input: { command: "ls /opt" } } })
  let permitRoom
  for (let tries = 0; tries < 20; tries++) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    permitRoom = await request(`/api/v1/room?project=${project}`)
    if (permitRoom.data.permits?.length) break
  }
  const shown = permitRoom.data.permits?.[0]
  assert(shown?.tool === "Bash" && shown.input === "ls /opt" && shown.agentId === seatA.agentId, "权限请求没出现在快照里")
  const deny = await request("/api/v1/permit", { method: "POST", body: { as: "human", id: shown.id, decision: "deny", note: "先别动" } })
  assert(deny.status === 200, "拒绝失败")
  const denied = await pendingPermit
  assert(denied.data.allow === false && denied.data.note === "先别动", "拒绝没传回给席位")
  const twice = await request("/api/v1/permit", { method: "POST", body: { as: "human", id: shown.id, decision: "once" } })
  assert(twice.status === 404, "处理过的请求不该再处理")
  const elevate = request("/api/v1/permit", { method: "POST", body: { ...seatA, action: "full", reason: "要装软件" } })
  for (let tries = 0; tries < 20; tries++) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    permitRoom = await request(`/api/v1/room?project=${project}`)
    if (permitRoom.data.permits?.length) break
  }
  const asksFull = permitRoom.data.permits?.[0]
  assert(asksFull?.kind === "full" && asksFull.reason === "要装软件", "完整权限请求没出现")
  await request("/api/v1/permit", { method: "POST", body: { as: "human", id: asksFull.id, decision: "once" } })
  assert((await elevate).data.allow === true, "允许完整权限没传回")
  permitRoom = await request(`/api/v1/room?project=${project}`)
  assert(permitRoom.data.agents.find((agent) => agent.id === seatA.agentId)?.fullAccess === true, "允许后席位应该有完整权限")
  const free = await request("/api/v1/permit", { method: "POST", body: { ...seatA, action: "tool", tool: "Bash", input: { command: "rm -rf x" } } })
  assert(free.data.allow === true, "有完整权限时应该直接放行")
  await request("/api/v1/permit", { method: "POST", body: { as: "human", agentId: seatA.agentId, full: false } })
  permitRoom = await request(`/api/v1/room?project=${project}`)
  assert(!permitRoom.data.agents.find((agent) => agent.id === seatA.agentId)?.fullAccess, "收回后不该还有完整权限")
  // Auto-full permission and single-turn take-back (heldWake): turning auto_full
  // on grants fullAccess by default; revoking it for the current wake pauses it.
  const autoOn = await request(`/api/v1/agents/${seatA.agentId}`, { method: "POST", body: { as: "human", action: "auto_full", on: true } })
  assert(autoOn.status === 200 && autoOn.data.autoFull === true && autoOn.data.fullAccess === true, "开启默认全部权限后席位应有 fullAccess")
  await request("/api/v1/permit", { method: "POST", body: { as: "human", agentId: seatA.agentId, full: false } })
  permitRoom = await request(`/api/v1/room?project=${project}`)
  assert(!permitRoom.data.agents.find((agent) => agent.id === seatA.agentId)?.fullAccess, "本轮临时收回后默认全部权限应暂停")
  await request(`/api/v1/agents/${seatA.agentId}`, { method: "POST", body: { as: "human", action: "auto_full", on: false } })

  // bench_ask: a question shows as a card; the user's reply is the answer,
  // handed straight back to an asker still waiting for it.
  const alphaSeat = { agentId: alpha.data.agent.id, token: alpha.data.token }
  const tooMany = await request("/api/v1/ask", {
    method: "POST",
    body: { ...alphaSeat, text: "选哪个？", options: ["1", "2", "3", "4", "5", "6", "7"] },
  })
  assert(tooMany.status === 400, "超过 6 个选项应该被拒绝")
  const humanAsk = await request("/api/v1/ask", { method: "POST", body: { as: "human", text: "人不该用这个" } })
  assert(humanAsk.status === 400, "人不该能用 bench_ask")
  const question2 = await request("/api/v1/ask", {
    method: "POST",
    body: { ...alphaSeat, text: "按钮放左边还是右边？", options: [{ label: "左边", detail: "和标题对齐" }, "右边"] },
  })
  assert(question2.status === 200 && question2.data.message.ask?.state === "open", `提问失败 ${question2.data.error || question2.status}`)
  assert(question2.data.message.ask.options.length === 2 && question2.data.message.ask.options[0].detail === "和标题对齐", "选项没存对")
  const askId = question2.data.message.id
  let askRoom = await request(`/api/v1/room?project=${project}`)
  const asker = askRoom.data.agents.find((agent) => agent.id === alphaSeat.agentId)
  assert(asker.status === "blocked" && /^等 .+ 回答：/.test(asker.doing), "提问后席位应该显示在等回答")
  const notMine = await request("/api/v1/ask", {
    method: "POST",
    body: { agentId: beta.data.agent.id, token: beta.data.token, action: "wait", id: askId, timeoutMs: 1000 },
  })
  assert(notMine.status === 403, "不能等别人的问题")
  const waiting = request("/api/v1/ask", { method: "POST", body: { ...alphaSeat, action: "wait", id: askId, timeoutMs: 8000 } })
  await new Promise((resolve) => setTimeout(resolve, 300))
  const picked = await request("/api/v1/say", { method: "POST", body: { as: "human", text: "左边", replyTo: askId } })
  assert(picked.status === 200, "回答问题失败")
  const got = await waiting
  assert(got.status === 200 && got.data.state === "answered" && got.data.answer === "左边" && !got.data.timedOut, "等着的提问者没拿到回答")
  assert(got.data.answerId === picked.data.message.id, "回答的消息 id 不对")
  askRoom = await request(`/api/v1/room?project=${project}`)
  const card = askRoom.data.messages.find((message) => message.id === askId)
  assert(card.ask.state === "answered" && card.ask.handed === true, "等着时回答应该记成已直接交给提问者")
  const again = await request("/api/v1/ask", { method: "POST", body: { ...alphaSeat, action: "wait", id: askId, timeoutMs: 1000 } })
  assert(again.data.state === "answered" && again.data.answer === "左边", "已回答的问题再等应该立刻拿到答案")
  // Nobody waiting: the answer is a plain reply, which wakes the asker as usual.
  const later = await request("/api/v1/ask", { method: "POST", body: { ...alphaSeat, text: "要不要加动画？" } })
  const timeout = await request("/api/v1/ask", {
    method: "POST",
    body: { ...alphaSeat, action: "wait", id: later.data.message.id, timeoutMs: 1000 },
  })
  assert(timeout.data.timedOut === true && timeout.data.state === "open", "没人回答时应该超时返回")
  await request("/api/v1/say", { method: "POST", body: { as: "human", text: "要", replyTo: later.data.message.id } })
  askRoom = await request(`/api/v1/room?project=${project}`)
  const laterCard = askRoom.data.messages.find((message) => message.id === later.data.message.id)
  assert(laterCard.ask.state === "answered" && !laterCard.ask.handed, "没人在等时回答不该记成已直接交给提问者")

  await request("/api/v1/leave", {
    method: "POST",
    body: { agentId: alpha.data.agent.id, token: alpha.data.token },
  })
  await request("/api/v1/leave", {
    method: "POST",
    body: { agentId: beta.data.agent.id, token: beta.data.token },
  })

  // The user's name: anyone may read it, only the user sets it, and it has to
  // be a name that can be @'d and is not a seat's. Setting it for real would
  // rename the user in every project, so only the refusals are tried here.
  const user = await request("/api/v1/user")
  assert(user.status === 200 && typeof user.data.name === "string" && user.data.name, "读不到用户的名字")
  const byAgent = await request("/api/v1/user", {
    method: "POST",
    body: { agentId: alpha.data.agent.id, token: alpha.data.token, name: "冒名" },
  })
  assert(byAgent.status === 403, "agent 不该能改用户的名字")
  const spaced = await request("/api/v1/user", { method: "POST", body: { as: "human", name: "有 空格" } })
  assert(spaced.status === 400, "带空格的名字应该被拒")
  const withName = await request(`/api/v1/room?project=${project}`)
  const seated = withName.data.agents[0]?.name
  assert(seated, "测试项目里应该还有席位")
  const sameAsSeat = await request("/api/v1/user", { method: "POST", body: { as: "human", name: seated } })
  assert(sameAsSeat.status === 409, `和席位重名应该被拒，得到 ${sameAsSeat.status} ${sameAsSeat.data.error || ""}`)
  assert(withName.data.userName === user.data.name, "快照里应该带着用户的名字")

  // SQLite full-history persistence (> 400 hot window), pagination, FTS/CJK search,
  // and openAsks preserved outside the 400-message hot window.
  const gamma = await request("/api/v1/join", {
    method: "POST",
    body: { name: `丙${stamp}`, model: "sqlite-tester", role: "存储校验" },
  })
  assert(gamma.status === 201, "丙入座失败")
  const gammaSeat = { agentId: gamma.data.agent.id, token: gamma.data.token }
  const earlyPhrase = await request("/api/v1/say", {
    method: "POST",
    body: { ...gammaSeat, text: `早期架构暗语：琥珀星云-${stamp}` },
  })
  assert(earlyPhrase.status === 200, "发早期暗号消息失败")
  const earlyPhraseId = earlyPhrase.data.message.id

  const earlyAsk = await request("/api/v1/ask", {
    method: "POST",
    body: { ...gammaSeat, text: "超过四百条之前的早期提问：选 WAL 还是 DELETE？", options: ["WAL", "DELETE"] },
  })
  assert(earlyAsk.status === 200 && earlyAsk.data.message.ask?.state === "open", "发早期提问卡失败")
  const earlyAskId = earlyAsk.data.message.id

  // Push > 410 messages in parallel chunks so earlyPhrase and earlyAsk scroll out of the 400-msg hot window.
  for (let batch = 0; batch < 21; batch++) {
    await Promise.all(
      Array.from({ length: 20 }, (_, idx) =>
        request("/api/v1/say", {
          method: "POST",
          body: { ...gammaSeat, text: `填充历史消息 #${batch * 20 + idx + 1}` },
        }),
      ),
    )
  }

  const deepRoom = await request(`/api/v1/room?project=${project}`)
  assert(deepRoom.data.messages.length === 400, `热窗口应保持 400 条，实际 ${deepRoom.data.messages.length}`)
  assert(deepRoom.data.totalMessages >= 430, `totalMessages 应反映全量 SQLite 行数，实际 ${deepRoom.data.totalMessages}`)
  assert(!deepRoom.data.messages.some((m) => m.id === earlyAskId), "早期提问卡应当已滑出 400 条热窗口")
  assert(deepRoom.data.openAsks?.some((m) => m.id === earlyAskId), "滑出 400 条热窗口的未答提问卡仍应出现在 openAsks")

  // Trigram FTS search (>= 3 chars) and short 2-char Chinese search across SQLite messages outside hot window.
  const ftsHit = await request("/api/v1/messages", {
    method: "POST",
    body: { ...gammaSeat, q: `琥珀星云-${stamp}`, limit: 20 },
  })
  assert(ftsHit.status === 200 && ftsHit.data.messages.some((m) => m.id === earlyPhraseId), "FTS 长词搜索没搜到滑出窗口的早期消息")
  const shortCjkHit = await request("/api/v1/messages", {
    method: "POST",
    body: { as: "human", q: "暗语", limit: 20, raw: true },
  })
  assert(shortCjkHit.status === 200 && shortCjkHit.data.raw?.some((m) => m.id === earlyPhraseId), "2 字中文短词搜索没搜到滑出窗口的早期消息")

  // Pagination back into SQLite beyond the 400-message hot window.
  const oldestHotSeq = deepRoom.data.messages[0].seq
  const olderPage = await request("/api/v1/messages", {
    method: "POST",
    body: { as: "human", before: oldestHotSeq, limit: 100, raw: true },
  })
  assert(
    olderPage.status === 200 && olderPage.data.raw?.some((m) => m.id === earlyPhraseId),
    "before 分页没能从 SQLite 翻出滑出窗口的早期消息",
  )

  // Answering an openAsk older than 400 messages updates SQLite and clears openAsks.
  const answerEarlyAsk = await request("/api/v1/say", {
    method: "POST",
    body: { as: "human", text: "WAL", replyTo: earlyAskId },
  })
  assert(answerEarlyAsk.status === 200, "回答滑出窗口的早期提问卡失败")
  const afterEarlyAnswer = await request(`/api/v1/room?project=${project}`)
  assert(!afterEarlyAnswer.data.openAsks?.some((m) => m.id === earlyAskId), "回答后早期提问卡不应再留在 openAsks")
  const verifyEarlyAsk = await request("/api/v1/ask", {
    method: "POST",
    body: { ...gammaSeat, action: "wait", id: earlyAskId, timeoutMs: 500 },
  })
  assert(verifyEarlyAsk.data.state === "answered" && verifyEarlyAsk.data.answer === "WAL", "SQLite 里的早期提问卡状态没更新成 answered")

  // SeatProfile, bench_memory (/api/v1/memory), and bidirectional Markdown sync on disk.
  const { existsSync, readFileSync, writeFileSync } = await import("node:fs")
  const setProf = await request(`/api/v1/agents/${gammaSeat.agentId}`, {
    method: "POST",
    body: { as: "human", action: "profile", persona: "负责存储引擎，改动必须跑回归测试", memory: "- 初始备忘：WAL 已开启" },
  })
  assert(setProf.status === 200 && setProf.data.agent.hasProfile === true, "设置席位档案失败")
  const mdPath = setProf.data.markdownPath
  assert(mdPath && existsSync(mdPath), "席位档案未同步生成 data/seats/<id>.md")

  const appendMem = await request("/api/v1/memory", {
    method: "POST",
    body: { ...gammaSeat, action: "append", note: "端口固定 4399" },
  })
  assert(appendMem.status === 200 && appendMem.data.profile.memory.includes("端口固定 4399"), "bench_memory append 失败")
  assert(readFileSync(mdPath, "utf8").includes("端口固定 4399"), "bench_memory append 未同步写回 Markdown 文件")

  // Another seat may read a teammate's profile, but cannot overwrite it.
  const otherSeat = { agentId: wu.data.agent.id, token: wu.data.token }
  const readPeer = await request("/api/v1/memory", {
    method: "POST",
    body: { ...otherSeat, action: "read", seat: `丙${stamp}` },
  })
  assert(readPeer.status === 200 && readPeer.data.profile.persona.includes("负责存储引擎"), "队友读取席位档案失败")
  const writePeer = await request("/api/v1/memory", {
    method: "POST",
    body: { ...otherSeat, action: "append", seat: `丙${stamp}`, note: "越权写入" },
  })
  assert(writePeer.status === 403, "不该允许修改别的席位的长期记忆")

  // Direct disk edit to data/seats/<id>.md must NOT be read back into the room
  // (one-way export only, preventing other agents from injecting persona via disk).
  await new Promise((resolve) => setTimeout(resolve, 25))
  const tamperedMd = readFileSync(mdPath, "utf8")
    .replace("负责存储引擎，改动必须跑回归测试", "被磁盘直接篡改的职责")
    .replace("端口固定 4399", "被磁盘直接篡改的记忆")
  writeFileSync(mdPath, tamperedMd, "utf8")
  const profView = await fetch(`${origin}/api/v1/agents/${gammaSeat.agentId}?view=profile&project=${project}`)
  const profJson = await profView.json()
  assert(
    profJson.profile?.persona === "负责存储引擎，改动必须跑回归测试" &&
      profJson.profile?.memory?.includes("端口固定 4399") &&
      !profJson.profile?.memory?.includes("被磁盘直接篡改"),
    `直接改 data/seats/<id>.md 不应被读回房间，实际：${JSON.stringify(profJson.profile)}`,
  )

  // Verify FTS5 index leaves zero orphan rows and zero recalled plaintext after message updates & recall.
  const ftsProbe = await request("/api/v1/say", {
    method: "POST",
    body: { as: "human", text: `撤回索引探针：紫藤花架-${stamp}` },
  })
  assert(ftsProbe.status === 200, "发送撤回索引探针失败")
  const ftsRecalled = await request("/api/v1/recall", {
    method: "POST",
    body: { as: "human", id: ftsProbe.data.message.id },
  })
  assert(ftsRecalled.status === 200, "撤回索引探针失败")
  const ftsSearchAfterRecall = await request("/api/v1/messages", {
    method: "POST",
    body: { as: "human", q: `紫藤花架-${stamp}`, limit: 10 },
  })
  assert(ftsSearchAfterRecall.status === 200 && ftsSearchAfterRecall.data.messages.length === 0, "撤回后的消息不应还能被搜出")
  {
    const pathMod = await import("node:path")
    const keyFile = process.env.BENCH_KEY_FILE || `${process.cwd()}/data/human-key`
    const dbCandidate = pathMod.resolve(pathMod.dirname(keyFile), "bench.db")
    if (existsSync(dbCandidate)) {
      const { DatabaseSync } = await import("node:sqlite")
      const ro = new DatabaseSync(dbCandidate, { readOnly: true })
      try {
        const orphanCnt = ro.prepare("SELECT COUNT(*) AS n FROM messages_fts WHERE rowid NOT IN (SELECT rowid FROM messages)").get().n
        const leakedCnt = ro.prepare("SELECT COUNT(*) AS n FROM messages_fts WHERE text LIKE ?").get(`%紫藤花架-${stamp}%`).n
        assert(orphanCnt === 0, `messages_fts 不应有残留孤儿行，实际 ${orphanCnt}`)
        assert(leakedCnt === 0, `messages_fts 不应保留已撤回消息原文，实际 ${leakedCnt}`)
      } finally {
        ro.close()
      }
    }
  }

  // Controllable wake queue (pause / single-item drop / resume) + Cross-vendor rebind,
  // busy-rebind rejection, token rotation against old-session hijack, & restore_binding.
  const { readdirSync, rmSync } = await import("node:fs")
  const osMod = await import("node:os")
  const pathMod = await import("node:path")
  const agentsFile = `${process.cwd()}/agents.json`
  const hadAgentsFile = existsSync(agentsFile)
  const originalAgentsFile = hadAgentsFile ? readFileSync(agentsFile, "utf8") : null
  const mockLimitName = `mocklim_${stamp}`
  const mockReliefName = `mockrel_${stamp}`
  const mockSlowName = `mockslow_${stamp}`
  const mockMuteName = `mockmute_${stamp}`
  const mockBadName = `mockbad_${stamp}`
  // Network failures (lib/netfail.ts): fails twice then answers, always fails,
  // and one that says back the to-dos its prompt told it it still owes.
  const mockFlakyName = `mockflaky_${stamp}`
  const mockNetName = `mocknet_${stamp}`
  const mockOwesName = `mockowes_${stamp}`
  // The checker before the user's sign-off (lib/summon.ts checkTask): its
  // verdict goes by a mark in the task's title.
  const mockCheckName = `mockcheck_${stamp}`
  // A woken Codex turn (scripts/codex-app.mjs) against a fake app-server: it
  // says what sandbox and approvals it was given, asks for a command and a
  // file change, and answers with what the room decided.
  const mockCodexName = `mockcodex_${stamp}`
  const fakeCodex = pathMod.join(osMod.tmpdir(), `bench-fake-codex-${stamp}.mjs`)
  ;(await import("node:fs")).writeFileSync(
    fakeCodex,
    `#!/usr/bin/env node
import { createInterface } from "node:readline"
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n")
const waiting = new Map()
let next = 1000
const ask = (method, params) => new Promise((resolve) => { const id = next++; waiting.set(id, resolve); send({ id, method, params }) })
let resume = {}
createInterface({ input: process.stdin }).on("line", async (line) => {
  const m = JSON.parse(line)
  if (waiting.has(m.id) && !m.method) { waiting.get(m.id)(m.result); waiting.delete(m.id); return }
  if (m.method === "initialize") return send({ id: m.id, result: {} })
  if (m.method === "thread/resume") { resume = m.params; return send({ id: m.id, result: {} }) }
  if (m.method !== "turn/start") return m.id !== undefined && send({ id: m.id, result: {} })
  send({ id: m.id, result: { turn: { id: "turn1" } } })
  const p = m.params
  const said = ["沙箱=" + resume.sandbox, "审批=" + resume.approvalPolicy, "本轮=" + p.sandboxPolicy?.type + "/" + p.approvalPolicy]
  if (p.approvalPolicy === "on-request") {
    const cmd = await ask("item/commandExecution/requestApproval", { threadId: "x", turnId: "turn1", itemId: "c1", startedAtMs: 0, command: "rm -rf build-${stamp}", reason: "清理旧产物" })
    said.push("命令=" + cmd.decision)
    send({ method: "item/started", params: { item: { id: "f1", type: "fileChange", changes: [{ path: "/elsewhere/a-${stamp}.ts", kind: "update" }] } } })
    const file = await ask("item/fileChange/requestApproval", { threadId: "x", turnId: "turn1", itemId: "f1", startedAtMs: 0 })
    said.push("文件=" + file.decision)
  }
  send({ method: "item/completed", params: { item: { id: "a1", type: "agentMessage", text: said.join(" ") } } })
  send({ method: "turn/completed", params: { turn: { id: "turn1", status: "completed" } } })
})
`,
    { mode: 0o755 },
  )
  let baseList = null
  try {
    const curAdapters = await request("/api/v1/adapters")
    assert(curAdapters.status === 200, "读取 adapters 失败")
    baseList = curAdapters.data.agents.map(({ name, command, reply }) => ({ name, command, reply }))
    const saveAdapters = await request("/api/v1/adapters", {
      method: "POST",
      body: {
        as: "human",
        agents: [
          ...baseList,
          {
            name: mockLimitName,
            command: `node -e "console.log('You\\'ve hit your 5-hour limit · resets 5pm'); process.exit(1)" {uuid} {text}`,
            reply: "stdout",
          },
          {
            name: mockReliefName,
            command: `node -e "const t = process.argv[2] || ''; console.log('[接力成功]' + (t.includes('改动必须跑回归测试') ? '|含职责' : '') + (t.includes('端口固定 4399') ? '|含记忆' : '') + (t.includes('跨厂商接力压测') ? '|含待办' : '') + (t.includes('跨客户端接力说明') ? '|含换脑说明' : '') + (t.includes('保留指令') ? '|含保留指令' : '') + (t.includes('误发指令') ? '|含误发指令' : ''))" {uuid} {text}`,
            reply: "stdout",
          },
          {
            name: mockSlowName,
            command: `node -e "setTimeout(() => console.log('[慢轮完成]'), 1200)" {uuid} {text}`,
            reply: "stdout",
          },
          // Ends well without a word, and ends in an error.
          { name: mockMuteName, command: `node -e "setTimeout(() => {}, 200)" {uuid} {text}`, reply: "stdout" },
          { name: mockBadName, command: `node -e "process.stderr.write('mock 故意出错'); process.exit(3)" {uuid} {text}`, reply: "stdout" },
          {
            name: mockFlakyName,
            command: `node -e "const fs = require('fs'); const f = require('os').tmpdir() + '/bench-flaky-' + process.argv[1]; const n = fs.existsSync(f) ? Number(fs.readFileSync(f, 'utf8')) : 0; fs.writeFileSync(f, String(n + 1)); if (n < 2) { process.stderr.write('read ECONNRESET'); process.exit(1) } fs.rmSync(f); console.log('[重试后答了]' + ((process.argv[2] || '').includes('刚才被打断') ? '|带着原来的消息' : ''))" {uuid} {text}`,
            reply: "stdout",
          },
          { name: mockNetName, command: `node -e "process.stderr.write('TRANSPORT: Connection error.'); process.exit(1)" {uuid} {text}`, reply: "stdout" },
          {
            name: mockCheckName,
            command: `node -e "const t = process.argv[2] || ''; console.log(t.includes('【没过】') ? '想了想\\n复验结论：没过\\n按钮没反应\\n没验到的：无' : t.includes('【没验到】') ? '复验结论：没验到\\n要真机\\n没验到的：全部' : t.includes('【乱答】') ? '挺好的' : '复验结论：通过\\n看过了\\n没验到的：无')" {uuid} {text}`,
            reply: "stdout",
          },
          // "--json": read as a streaming client, like codex-wake.sh.
          { name: mockCodexName, command: `CODEX_BIN=${fakeCodex} node ./scripts/codex-app.mjs {uuid} {text} # --json`, reply: "stdout" },
          {
            name: mockOwesName,
            command: `node -e "const t = process.argv[2] || ''; const head = '【你名下还没做完的待办】'; console.log(t.includes(head) ? '[欠]' + t.split(head)[1].split('接着做')[0].replace(/\\s+/g, ' ') : '[不欠]')" {uuid} {text}`,
            reply: "stdout",
          },
        ],
      },
    })
    assert(saveAdapters.status === 200, `注册测试 adapter 失败 ${saveAdapters.data.error || saveAdapters.status}`)

    // 1) Controllable queue: pause -> enqueue 2 mentions -> drop 1 -> resume -> wakes with only the kept message.
    const delta = await request("/api/v1/join", {
      method: "POST",
      body: { name: `丁${stamp}`, model: "mock-1", role: "队列受控测试", agentName: mockReliefName, uuid: `sess-delta-${stamp}` },
    })
    assert(delta.status === 201, "丁入座失败")
    const deltaId = delta.data.agent.id

    const paused = await request(`/api/v1/agents/${deltaId}`, {
      method: "POST",
      body: { as: "human", action: "queue_pause" },
    })
    assert(paused.status === 200 && paused.data.paused === true, "暂停队列失败")

    const mKeep = await request("/api/v1/say", { method: "POST", body: { as: "human", text: `@丁${stamp} 第一条保留指令` } })
    const mDrop = await request("/api/v1/say", { method: "POST", body: { as: "human", text: `@丁${stamp} 第二条误发指令` } })
    assert(mKeep.status === 200 && mDrop.status === 200, "暂停期间发点名消息失败")

    const queuedSnap = await request(`/api/v1/room?project=${project}`)
    const deltaAgent = queuedSnap.data.agents.find((a) => a.id === deltaId)
    assert(
      deltaAgent?.queuePaused === true && deltaAgent.queuedCount === 2 && deltaAgent.queuedItems?.length === 2,
      `暂停后消息应排在可控队列里，实际 count=${deltaAgent?.queuedCount}`,
    )

    const dropped = await request(`/api/v1/agents/${deltaId}`, {
      method: "POST",
      body: { as: "human", action: "queue_drop", messageId: mDrop.data.message.id },
    })
    assert(dropped.status === 200 && dropped.data.queuedCount === 1, "剔除单条排队消息失败")

    const resumed = await request(`/api/v1/agents/${deltaId}`, {
      method: "POST",
      body: { as: "human", action: "queue_resume" },
    })
    assert(resumed.status === 200 && resumed.data.paused === false, "恢复队列失败")

    let deltaReply = null
    for (let tries = 0; tries < 30; tries++) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      const snap = await request(`/api/v1/room?project=${project}`)
      deltaReply = snap.data.messages.find((m) => m.authorId === deltaId && m.text.includes("[接力成功]"))
      if (deltaReply) break
    }
    assert(
      deltaReply && deltaReply.text.includes("|含保留指令") && !deltaReply.text.includes("|含误发指令"),
      `恢复队列后应只带着保留指令唤起，实际回复：${deltaReply?.text}`,
    )

    // 1b) Rebind while seat is busy must be rejected (409), and once idle, rebinding preserves handoff briefing.
    const busySeat = await request("/api/v1/join", {
      method: "POST",
      body: { name: `忙${stamp}`, model: "slow-1", role: "忙时换脑测试", agentName: mockSlowName, uuid: `sess-slow-${stamp}` },
    })
    assert(busySeat.status === 201, "忙席位入座失败")
    const busyId = busySeat.data.agent.id
    await request(`/api/v1/agents/${busyId}`, {
      method: "POST",
      body: { as: "human", action: "profile", persona: "改动必须跑回归测试", memory: "" },
    })
    await request("/api/v1/say", { method: "POST", body: { as: "human", text: `@忙${stamp} 跑个慢任务` } })
    await new Promise((resolve) => setTimeout(resolve, 250))
    const busyRebind = await request(`/api/v1/agents/${busyId}`, {
      method: "POST",
      body: { as: "human", action: "rebind", kind: mockReliefName, session: `sess-busy-rel-${stamp}` },
    })
    assert(busyRebind.status === 409, `席位正忙时换脑应返回 409，实际 ${busyRebind.status}`)
    for (let tries = 0; tries < 30; tries++) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      const snap = await request(`/api/v1/room?project=${project}`)
      if (snap.data.messages.some((m) => m.authorId === busyId && m.text.includes("[慢轮完成]"))) break
    }
    const idleRebind = await request(`/api/v1/agents/${busyId}`, {
      method: "POST",
      body: { as: "human", action: "rebind", kind: mockReliefName, session: `sess-busy-rel-${stamp}` },
    })
    assert(idleRebind.status === 200, `闲下来后换脑应成功，实际 ${idleRebind.status} ${idleRebind.data.error || ""}`)
    await request("/api/v1/say", { method: "POST", body: { as: "human", text: `@忙${stamp} 保留指令` } })
    let busyAfterReply = null
    for (let tries = 0; tries < 30; tries++) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      const snap = await request(`/api/v1/room?project=${project}`)
      busyAfterReply = snap.data.messages.find((m) => m.authorId === busyId && m.text.includes("[接力成功]"))
      if (busyAfterReply) break
    }
    assert(
      busyAfterReply?.text.includes("|含职责") && busyAfterReply?.text.includes("|含换脑说明"),
      `忙后换脑新客户端首轮应拿到职责和接力说明，实际：${busyAfterReply?.text}`,
    )

    // 2) Cross-vendor rebind on usage limit, old-token rejection, & restore_binding.
    // Bind gamma (which already has persona + memory) onto mockLimitName and assign an active task.
    await request("/api/v1/join", {
      method: "POST",
      body: {
        agentId: gammaSeat.agentId,
        token: gammaSeat.token,
        name: `丙${stamp}`,
        model: "claude-opus",
        role: "存储校验",
        agentName: mockLimitName,
        uuid: `sess-lim-${stamp}`,
      },
    })
    const relayTask = await request("/api/v1/tasks", {
      method: "POST",
      body: { ...gammaSeat, title: "跨厂商接力压测", owner: `丙${stamp}`, status: "doing" },
    })
    assert(relayTask.status === 201, "创建接力待办失败")

    await request("/api/v1/say", { method: "POST", body: { as: "human", text: `@丙${stamp} 请开始执行压测` } })
    let limitMsg = null
    for (let tries = 0; tries < 30; tries++) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      const snap = await request(`/api/v1/room?project=${project}`)
      limitMsg = snap.data.messages.find((m) => m.limited?.agentId === gammaSeat.agentId)
      if (limitMsg) break
    }
    assert(limitMsg?.limited?.state === "open", "撞到额度后未生成 open 状态的 LimitedCard")

    const rebindRes = await request(`/api/v1/runs/${limitMsg.limited.runId}`, {
      method: "POST",
      body: { as: "human", action: "rebind", kind: mockReliefName, session: `sess-rel-${stamp}` },
    })
    assert(rebindRes.status === 200 && rebindRes.data.resumed === true, `撞额度后跨厂商顶替失败 ${rebindRes.data.error || rebindRes.status}`)
    assert(rebindRes.data.agent.id === gammaSeat.agentId, "跨厂商切换后席位 id 必须保持不变")
    assert(rebindRes.data.agent.previousBindings?.some((b) => b.agentName === mockLimitName), "原客户端会话未记入 previousBindings")

    // Old session with old token must NOT be able to hijack the seat back or speak as the seat.
    const hijackJoin = await request("/api/v1/join", {
      method: "POST",
      body: {
        token: gammaSeat.token,
        name: `丙${stamp}`,
        model: "claude-opus",
        role: "存储校验",
        agentName: mockLimitName,
        uuid: `sess-lim-${stamp}`,
      },
    })
    assert(hijackJoin.status === 409, `换脑后旧会话带旧 token 入座应被 409 拒绝，实际 ${hijackJoin.status}`)
    const hijackSay = await request("/api/v1/say", {
      method: "POST",
      body: { agentId: gammaSeat.agentId, token: gammaSeat.token, text: "旧会话冒充发言" },
    })
    assert(hijackSay.status === 401, `换脑后旧会话带旧 token 发言应被 401 拒绝，实际 ${hijackSay.status}`)

    let reliefReply = null
    let reboundSnap = null
    for (let tries = 0; tries < 30; tries++) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      reboundSnap = await request(`/api/v1/room?project=${project}`)
      reliefReply = reboundSnap.data.messages.find((m) => m.authorId === gammaSeat.agentId && m.text.includes("[接力成功]"))
      if (reliefReply) break
    }
    assert(reliefReply, "跨厂商顶替后新客户端未发出接力回复")
    assert(
      reliefReply.text.includes("|含职责") &&
        reliefReply.text.includes("|含记忆") &&
        reliefReply.text.includes("|含待办") &&
        reliefReply.text.includes("|含换脑说明"),
      `新客户端唤醒简报缺少职责/记忆/待办/换脑说明：${reliefReply.text}`,
    )
    const gammaAfterHijack = reboundSnap.data.agents.find((a) => a.id === gammaSeat.agentId)
    assert(gammaAfterHijack?.agentName === mockReliefName, `旧会话入座后席位绑定不应被改回，实际 ${gammaAfterHijack?.agentName}`)
    const updatedLimitCard = reboundSnap.data.messages.find((m) => m.id === limitMsg.id)
    assert(updatedLimitCard?.limited?.state === "rebound", "顶替后原撞额度卡片状态应变为 rebound")
    const keptTask = reboundSnap.data.tasks.find((t) => t.id === relayTask.data.task.id)
    assert(keptTask?.ownerId === gammaSeat.agentId, "换脑后原待办负责人不应丢失")

    // New bound session using its rotated credential file in bench-mcp state dir can rejoin normally.
    const keyFile = process.env.BENCH_KEY_FILE || `${process.cwd()}/data/human-key`
    const stateCandidates = [
      pathMod.resolve(pathMod.dirname(keyFile), "../state/bench-mcp"),
      pathMod.join(process.env.XDG_STATE_HOME || pathMod.join(osMod.homedir(), ".local", "state"), "bench-mcp"),
    ]
    let rotatedToken = null
    for (const dir of stateCandidates) {
      const f = pathMod.join(dir, `${mockReliefName}-sess-rel-${stamp}.json`)
      if (existsSync(f)) {
        rotatedToken = JSON.parse(readFileSync(f, "utf8")).token
        break
      }
    }
    if (rotatedToken) {
      assert(rotatedToken !== gammaSeat.token, "换脑后写给新会话的凭证文件应当是轮换后的新 token")
      const validRejoin = await request("/api/v1/join", {
        method: "POST",
        body: {
          token: rotatedToken,
          name: `丙${stamp}`,
          model: "mock-relief",
          role: "存储校验",
          agentName: mockReliefName,
          uuid: `sess-rel-${stamp}`,
        },
      })
      assert(validRejoin.status === 200 || validRejoin.status === 201, `当前绑定会话持新 token 入座应成功，实际 ${validRejoin.status}`)
    }

    // One-click restore_binding back to original session once quota resets.
    const restoreRes = await request(`/api/v1/agents/${gammaSeat.agentId}`, {
      method: "POST",
      body: { as: "human", action: "restore_binding", index: 0 },
    })
    assert(
      restoreRes.status === 200 && restoreRes.data.agent.agentName === mockLimitName,
      `一键切回原客户端会话失败 ${restoreRes.data.error || restoreRes.status}`,
    )

    // What became of each call (Message.calls): the room writes it where it
    // happens (lib/summon.ts), one fact at a time: queued, started, picked up,
    // answered are separate, and so are the ways it can fail to be answered.
    const callOf = async (messageId, seatId) => {
      const now = await request(`/api/v1/room?project=${project}`)
      return now.data.messages.find((item) => item.id === messageId)?.calls?.find((item) => item.id === seatId)
    }
    const settled = async (messageId, seatId, ends = ["answered", "silent", "failed", "stopped", "dropped", "cut"]) => {
      for (let i = 0; i < 80; i++) {
        const call = await callOf(messageId, seatId)
        if (call && ends.includes(call.state)) return call
        await new Promise((resolve) => setTimeout(resolve, 150))
      }
      return callOf(messageId, seatId)
    }
    const seatIn = async (label, kind) => {
      const made = await request("/api/v1/join", {
        method: "POST",
        body: { name: `${label}${stamp}`, model: "mock-1", role: "去向测试", agentName: kind, uuid: `sess-${kind}-${Math.random().toString(36).slice(2, 7)}` },
      })
      assert(made.status === 201, `${label}入座失败 ${made.data.error || made.status}`)
      return { id: made.data.agent.id, name: made.data.agent.name, token: made.data.token }
    }
    const owesOf = async (seatId) => (await request(`/api/v1/room?project=${project}`)).data.agents.find((a) => a.id === seatId)?.owes

    // Busy when called again: the first is being worked on, the second waits
    // in the lane, and each ends answered.
    const slowSeat = await seatIn("去向慢", mockSlowName)
    const c1 = await request("/api/v1/say", { method: "POST", body: { as: "human", text: `@${slowSeat.name} 第一句` } })
    await new Promise((resolve) => setTimeout(resolve, 300))
    const c2 = await request("/api/v1/say", { method: "POST", body: { as: "human", text: `@${slowSeat.name} 第二句` } })
    const during1 = await callOf(c1.data.message.id, slowSeat.id)
    const during2 = await callOf(c2.data.message.id, slowSeat.id)
    assert(
      ["started", "picked"].includes(during1?.state) && during1.runId && during2?.state === "queued",
      `忙的时候：前一条该是已叫到或在做，后一条该排着，实际 ${during1?.state} / ${during2?.state}`,
    )
    const end1 = await settled(c1.data.message.id, slowSeat.id)
    const end2 = await settled(c2.data.message.id, slowSeat.id)
    assert(end1?.state === "answered" && end2?.state === "answered", `两条最后都该是答了，实际 ${end1?.state} / ${end2?.state}`)
    assert(end1.runId !== end2.runId, "排着的那条该由后一次唤起来答")

    // Ended well without a word in the room: not an answer.
    const muteSeat = await seatIn("去向哑", mockMuteName)
    const c3 = await request("/api/v1/say", { method: "POST", body: { as: "human", text: `@${muteSeat.name} 你不会回答` } })
    const end3 = await settled(c3.data.message.id, muteSeat.id)
    assert(end3?.state === "silent", `跑完没说话该记成 silent，实际 ${end3?.state}`)

    // Ended in an error: failed, with why; and the seat owes that call.
    const badSeat = await seatIn("去向坏", mockBadName)
    const c4 = await request("/api/v1/say", { method: "POST", body: { as: "human", text: `@${badSeat.name} 你会出错` } })
    const end4 = await settled(c4.data.message.id, badSeat.id)
    assert(end4?.state === "failed" && /故意出错|退出码/.test(end4.note || ""), `唤起出错该记成 failed 带原因，实际 ${end4?.state} ${end4?.note}`)
    const badOwes = await owesOf(badSeat.id)
    assert(
      badOwes?.calls?.length === 1 && badOwes.calls[0].messageId === c4.data.message.id && badOwes.tasks.length === 0,
      `没叫成的那条该算席位欠着的，实际 ${JSON.stringify(badOwes)}`,
    )

    // Stopped by the user: the run it was in is stopped, what waited behind
    // it is dropped, and neither is owed (the user chose it).
    const stopSeat = await seatIn("去向停", mockSlowName)
    const c5 = await request("/api/v1/say", { method: "POST", body: { as: "human", text: `@${stopSeat.name} 这一轮会被停` } })
    await new Promise((resolve) => setTimeout(resolve, 300))
    const c6 = await request("/api/v1/say", { method: "POST", body: { as: "human", text: `@${stopSeat.name} 这条排在后面` } })
    const stopRes = await request(`/api/v1/agents/${stopSeat.id}`, { method: "POST", body: { as: "human", action: "stop" } })
    assert(stopRes.status === 200, `停止失败 ${stopRes.data.error || stopRes.status}`)
    const end5 = await settled(c5.data.message.id, stopSeat.id)
    const end6 = await settled(c6.data.message.id, stopSeat.id)
    assert(end5?.state === "stopped" && end6?.state === "dropped", `停止后该是 stopped / dropped，实际 ${end5?.state} / ${end6?.state}`)
    assert(!(await owesOf(stopSeat.id)), "用户自己停下的不算席位欠着")

    // Stopped with work on it (agents[].owes): a quiet seat owes the to-dos it
    // owns that wait on nobody else. Marked 卡住 with a reason, or sent for
    // the user's sign-off, it no longer does.
    assert(!(await owesOf(muteSeat.id)), "名下没有待办、点名也都有着落的席位不该算欠着")
    const owed = await request("/api/v1/tasks", {
      method: "POST",
      body: { as: "human", title: `欠着的待办${stamp}`, owner: muteSeat.name, steps: ["第一步", "第二步", "用户验收"] },
    })
    const owing = await owesOf(muteSeat.id)
    assert(
      owing?.tasks?.length === 1 && owing.tasks[0].id === owed.data.task.id && owing.tasks[0].step === "第一步" && owing.since > 0,
      `闲着的席位名下有没做完的待办该算欠着，实际 ${JSON.stringify(owing)}`,
    )
    const heldTask = await request(`/api/v1/tasks/${owed.data.task.id}`, {
      method: "POST",
      body: { agentId: muteSeat.id, token: muteSeat.token, action: "block", note: "等别人的接口" },
    })
    assert(heldTask.status === 200 && !(await owesOf(muteSeat.id)), "标成卡住并写了原因的待办不算欠着")
    const forReview = await request("/api/v1/tasks", {
      method: "POST",
      body: { as: "human", title: `等验收的待办${stamp}`, owner: muteSeat.name, steps: ["做事", "用户验收"] },
    })
    assert((await owesOf(muteSeat.id))?.tasks?.[0]?.id === forReview.data.task.id, "新的待办该算欠着")
    await request(`/api/v1/tasks/${forReview.data.task.id}`, {
      method: "POST",
      body: { agentId: muteSeat.id, token: muteSeat.token, action: "review", note: "做完了" },
    })
    assert(!(await owesOf(muteSeat.id)), "请了验收的待办轮到用户，不算席位欠着")

    // Network failures are tried again by the room (lib/netfail.ts): at most
    // twice, with the same messages; nothing in the room until the last try
    // fails. Start the room with BENCH_RETRY_MS=400,800 or this waits 80 s.
    const watch = async (messageId, seatId, ends, limit = 100_000) => {
      const seen = []
      const until = Date.now() + limit
      while (Date.now() < until) {
        const call = await callOf(messageId, seatId)
        if (call && seen.at(-1) !== call.state) seen.push(call.state)
        if (call && ends.includes(call.state)) return { call, seen }
        await new Promise((resolve) => setTimeout(resolve, 60))
      }
      return { call: await callOf(messageId, seatId), seen }
    }
    const roomSays = async (afterSeq, name) =>
      (await request(`/api/v1/room?project=${project}`)).data.messages.filter(
        (item) => item.seq > afterSeq && item.authorId === "room" && item.text.includes(name) && item.text.includes("没成功"),
      )
    const retrySetting = await request("/api/v1/retry")
    assert(retrySetting.status === 200 && retrySetting.data.on === true, `网络错误自动重试该默认开，实际 ${JSON.stringify(retrySetting.data)}`)

    const flakySeat = await seatIn("去向断网", mockFlakyName)
    const n1 = await request("/api/v1/say", { method: "POST", body: { as: "human", text: `@${flakySeat.name} 网会断两次` } })
    const flaky = await watch(n1.data.message.id, flakySeat.id, ["answered", "failed", "silent"])
    assert(
      flaky.call?.state === "answered" && flaky.seen.includes("retrying"),
      `前两次 ECONNRESET、第三次成功：该经过 retrying 再到 answered，实际经过 ${flaky.seen.join(" → ")}`,
    )
    assert((await roomSays(n1.data.message.seq, flakySeat.name)).length === 0, "重试成功了，群里不该有中间的报错")
    const flakyAnswer = (await request(`/api/v1/room?project=${project}`)).data.messages.find(
      (item) => item.authorId === flakySeat.id && item.replyTo === n1.data.message.id,
    )
    assert(flakyAnswer?.text.includes("带着原来的消息"), `重试要带着原来那批消息，实际回答 ${flakyAnswer?.text}`)

    const netSeat = await seatIn("去向总断", mockNetName)
    const n2 = await request("/api/v1/say", { method: "POST", body: { as: "human", text: `@${netSeat.name} 网一直不通` } })
    const net = await watch(n2.data.message.id, netSeat.id, ["answered", "failed", "silent"])
    assert(
      net.call?.state === "failed" && /自动重试了 2 次/.test(net.call.note || "") && net.seen.includes("retrying"),
      `一直失败：两次重试后该 failed 并写明重试过，实际 ${net.seen.join(" → ")} ${net.call?.note}`,
    )
    const netSaid = await roomSays(n2.data.message.seq, netSeat.name)
    assert(netSaid.length === 1, `都失败了只在群里报一次错，实际 ${netSaid.length} 条`)

    const badAgain = await request("/api/v1/say", { method: "POST", body: { as: "human", text: `@${badSeat.name} 不是网络的错` } })
    const bad = await watch(badAgain.data.message.id, badSeat.id, ["answered", "failed", "silent"], 15_000)
    assert(bad.call?.state === "failed" && !bad.seen.includes("retrying"), `非网络的错误不重试，实际 ${bad.seen.join(" → ")}`)

    // Stopped while it waits for the next try: no more tries.
    const n3 = await request("/api/v1/say", { method: "POST", body: { as: "human", text: `@${netSeat.name} 等重试时被停` } })
    const waiting = await watch(n3.data.message.id, netSeat.id, ["retrying", "failed"], 15_000)
    assert(waiting.call?.state === "retrying", `该先进入 retrying，实际 ${waiting.call?.state}`)
    const waitSnap = (await request(`/api/v1/room?project=${project}`)).data.agents.find((a) => a.id === netSeat.id)
    assert(waitSnap?.retry?.n === 1 && waitSnap.retry.of === 2 && waitSnap.retry.at > Date.now() - 1000, `等重试时席位该带 retry，实际 ${JSON.stringify(waitSnap?.retry)}`)
    const stopWait = await request(`/api/v1/agents/${netSeat.id}`, { method: "POST", body: { as: "human", action: "stop" } })
    assert(stopWait.status === 200 && stopWait.data.retryCancelled === true, `等重试时点停止该取消重试，实际 ${JSON.stringify(stopWait.data)}`)
    await new Promise((resolve) => setTimeout(resolve, 2500))
    const afterStop = await callOf(n3.data.message.id, netSeat.id)
    assert(afterStop?.state === "stopped", `停下后不该再重试，实际 ${afterStop?.state}`)
    assert(!(await owesOf(netSeat.id))?.calls?.some((item) => item.messageId === n3.data.message.id), "用户停下的重试不算席位欠着")

    // Turned off in settings: a network failure fails at once.
    const off = await request("/api/v1/retry", { method: "POST", body: { as: "human", on: false } })
    assert(off.status === 200 && off.data.on === false, "关掉自动重试失败")
    try {
      const n4 = await request("/api/v1/say", { method: "POST", body: { as: "human", text: `@${netSeat.name} 关了重试` } })
      const offRun = await watch(n4.data.message.id, netSeat.id, ["answered", "failed", "silent"], 15_000)
      assert(offRun.call?.state === "failed" && !offRun.seen.includes("retrying"), `关掉后不该重试，实际 ${offRun.seen.join(" → ")}`)
    } finally {
      await request("/api/v1/retry", { method: "POST", body: { as: "human", on: true } })
    }

    // A woken seat is told the to-dos it still owes (at most 3), except one
    // the messages it is handed already name.
    const owesSeat = await seatIn("去向欠", mockOwesName)
    const owedA = await request("/api/v1/tasks", {
      method: "POST",
      body: { as: "human", title: `还欠的甲${stamp}`, owner: owesSeat.name, steps: ["甲第一步", "用户验收"] },
    })
    const owedB = await request("/api/v1/tasks", {
      method: "POST",
      body: { as: "human", title: `还欠的乙${stamp}`, owner: owesSeat.name, steps: ["乙第一步", "用户验收"] },
    })
    const idA = owedA.data.task.id
    const idB = owedB.data.task.id
    const o1 = await request("/api/v1/say", { method: "POST", body: { as: "human", text: `@${owesSeat.name} 先看 ${idB}` } })
    await settled(o1.data.message.id, owesSeat.id)
    const owesAnswer = (await request(`/api/v1/room?project=${project}`)).data.messages.find(
      (item) => item.authorId === owesSeat.id && item.replyTo === o1.data.message.id,
    )
    assert(
      owesAnswer?.text.startsWith("[欠]") && owesAnswer.text.includes(idA) && owesAnswer.text.includes("甲第一步") && !owesAnswer.text.includes(idB),
      `提示里该带上还欠的 ${idA}、不重复消息里提到的 ${idB}，实际 ${owesAnswer?.text}`,
    )
    for (const id of [idA, idB]) {
      await request(`/api/v1/tasks/${id}`, { method: "POST", body: { agentId: owesSeat.id, token: owesSeat.token, action: "block", note: "测试收尾" } })
    }
    const o2 = await request("/api/v1/say", { method: "POST", body: { as: "human", text: `@${owesSeat.name} 现在不欠了` } })
    await settled(o2.data.message.id, owesSeat.id)
    const clearAnswer = (await request(`/api/v1/room?project=${project}`)).data.messages.find(
      (item) => item.authorId === owesSeat.id && item.replyTo === o2.data.message.id,
    )
    assert(clearAnswer?.text === "[不欠]", `没有欠的就什么都不加，实际 ${clearAnswer?.text}`)

    // 「请验收时先复验」: the project's checker is woken on its own when an owner
    // asks for review; its verdict lands on the task (Task.check), not in the room.
    const doer = await seatIn("复验做事", mockMuteName)
    const checkSeat = await seatIn("复验人", mockCheckName)
    const badChecker = await seatIn("复验坏", mockBadName)
    const asChecker = (seat, on) => request(`/api/v1/agents/${seat.id}`, { method: "POST", body: { as: "human", action: "checker", on } })
    const taskFor = async (seat, title) =>
      (await request("/api/v1/tasks", { method: "POST", body: { agentId: seat.id, token: seat.token, title, owner: seat.name, steps: ["做", "验收"] } })).data.task.id
    const askReview = (seat, id) => request(`/api/v1/tasks/${id}`, { method: "POST", body: { agentId: seat.id, token: seat.token, action: "review", note: "看右栏" } })
    const checkOf = async (id) => (await request(`/api/v1/room?project=${project}`)).data.tasks.find((t) => t.id === id)?.check
    const checked = async (id) => {
      for (let i = 0; i < 80; i++) {
        const check = await checkOf(id)
        if (check && !["queued", "running"].includes(check.state)) return check
        await new Promise((resolve) => setTimeout(resolve, 150))
      }
      return checkOf(id)
    }
    const offTask = await taskFor(doer, "没开复验")
    await askReview(doer, offTask)
    await new Promise((resolve) => setTimeout(resolve, 500))
    assert(!(await checkOf(offTask)), "没设复验人时请验收不该有复验")
    assert((await asChecker(checkSeat, true)).status === 200, "设复验人失败")
    const passTask = await taskFor(doer, "要复验")
    await askReview(doer, passTask)
    const passed = await checked(passTask)
    assert(passed?.state === "passed" && passed.note?.includes("看过了") && passed.runId, `复验该通过并记下依据，实际 ${JSON.stringify(passed)}`)
    assert(
      !(await request(`/api/v1/room?project=${project}`)).data.messages.some((m) => m.text?.includes("复验结论")),
      "复验的回答不该进群聊",
    )
    await askReview(doer, passTask)
    await new Promise((resolve) => setTimeout(resolve, 500))
    assert((await checkOf(passTask))?.at === passed.at, "没打回就再请验收，不该再复验一次")
    const failTask = await taskFor(doer, "【没过】的")
    await askReview(doer, failTask)
    const failed = await checked(failTask)
    assert(failed?.state === "failed" && failed.note?.startsWith("按钮没反应"), `复验该是没过，实际 ${JSON.stringify(failed)}`)
    const stillWaiting = (await request(`/api/v1/room?project=${project}`)).data.tasks.find((t) => t.id === failTask)
    assert(stillWaiting.review?.state === "waiting", "复验没过不该自动打回")
    await request(`/api/v1/tasks/${failTask}`, { method: "POST", body: { as: "human", action: "reject", note: "改" } })
    await askReview(doer, failTask)
    const again = await checked(failTask)
    assert(again?.at !== failed.at && again?.state === "failed", "打回后再请验收该重新复验")
    const unTask = await taskFor(doer, "【没验到】的")
    await askReview(doer, unTask)
    assert((await checked(unTask))?.state === "unverified", "复验该是没验到")
    const junkTask = await taskFor(doer, "【乱答】的")
    await askReview(doer, junkTask)
    const junk = await checked(junkTask)
    assert(junk?.state === "error" && junk.note?.includes("没交结论"), `没按格式交结论该记成没跑成，实际 ${JSON.stringify(junk)}`)
    const ownTask = await taskFor(checkSeat, "复验人自己的")
    await askReview(checkSeat, ownTask)
    const own = await checkOf(ownTask)
    assert(own?.state === "skipped" && own.note?.includes("负责人"), `复验人是负责人时该跳过，实际 ${JSON.stringify(own)}`)
    await asChecker(badChecker, true)
    const agentsNow = (await request(`/api/v1/room?project=${project}`)).data.agents
    assert(agentsNow.filter((a) => a.checker).length === 1, "同一时间只该有一个复验人")
    const badTask = await taskFor(doer, "复验人出错")
    await askReview(doer, badTask)
    const badCheck = await checked(badTask)
    assert(badCheck?.state === "error" && badCheck.note?.startsWith("复验没跑成"), `复验唤起失败该写没跑成，实际 ${JSON.stringify(badCheck)}`)
    await asChecker(badChecker, false)
    const afterOff = await taskFor(doer, "关掉复验以后")
    await askReview(doer, afterOff)
    await new Promise((resolve) => setTimeout(resolve, 500))
    assert(!(await checkOf(afterOff)), "关掉复验后不该再复验")

    // Codex seats under the room's permissions (scripts/codex-app.mjs): it
    // may write in its workspace and asks on the page for more; with full
    // permission it runs without a sandbox and asks nothing.
    const codexSeat = await seatIn("Codex权限", mockCodexName)
    const cx1 = await request("/api/v1/say", { method: "POST", body: { as: "human", text: `@${codexSeat.name} 干活` } })
    const cardFor = async (needle) => {
      for (let i = 0; i < 100; i++) {
        const card = (await request(`/api/v1/room?project=${project}`)).data.permits?.find((item) => item.agentId === codexSeat.id && String(item.input).includes(needle))
        if (card) return card
        await new Promise((resolve) => setTimeout(resolve, 150))
      }
      return null
    }
    const cmdCard = await cardFor(`rm -rf build-${stamp}`)
    assert(cmdCard?.tool === "终端" && String(cmdCard.input).includes("清理旧产物"), `Codex 要跑命令时该出权限卡片，实际 ${JSON.stringify(cmdCard)}`)
    await request("/api/v1/permit", { method: "POST", body: { as: "human", id: cmdCard.id, decision: "once" } })
    const fileCard = await cardFor(`a-${stamp}.ts`)
    assert(fileCard?.tool === "文件编辑", `Codex 要改工作区外的文件时该出权限卡片，实际 ${JSON.stringify(fileCard)}`)
    await request("/api/v1/permit", { method: "POST", body: { as: "human", id: fileCard.id, decision: "deny" } })
    await settled(cx1.data.message.id, codexSeat.id)
    const cxAnswer = (await request(`/api/v1/room?project=${project}`)).data.messages.find((m) => m.authorId === codexSeat.id && m.replyTo === cx1.data.message.id)
    assert(
      cxAnswer?.text === "沙箱=workspace-write 审批=on-request 本轮=workspaceWrite/on-request 命令=accept 文件=decline",
      `Codex 平时该是可写工作区、要时再问，点了允许和拒绝该传回去，实际 ${cxAnswer?.text}`,
    )
    assert((await request("/api/v1/permit", { method: "POST", body: { key: "no-such-run", action: "mode" } })).status === 404, "不在跑的唤起 key 不该能问权限")
    await request(`/api/v1/agents/${codexSeat.id}`, { method: "POST", body: { as: "human", action: "auto_full", on: true } })
    const cx2 = await request("/api/v1/say", { method: "POST", body: { as: "human", text: `@${codexSeat.name} 再干` } })
    await settled(cx2.data.message.id, codexSeat.id)
    const cxFull = (await request(`/api/v1/room?project=${project}`)).data.messages.find((m) => m.authorId === codexSeat.id && m.replyTo === cx2.data.message.id)
    assert(
      cxFull?.text === "沙箱=danger-full-access 审批=never 本轮=dangerFullAccess/never",
      `Codex 有全部权限时该不设沙箱、不再问，实际 ${cxFull?.text}`,
    )
    await request(`/api/v1/agents/${codexSeat.id}`, { method: "POST", body: { as: "human", action: "auto_full", on: false } })
    // 「这次唤起全部允许」 on the first card: the rest of the wake goes through unasked.
    const cx3 = await request("/api/v1/say", { method: "POST", body: { as: "human", text: `@${codexSeat.name} 第三轮` } })
    const fullCard = await cardFor(`rm -rf build-${stamp}`)
    assert(fullCard, "第三轮该先问命令")
    await request("/api/v1/permit", { method: "POST", body: { as: "human", id: fullCard.id, decision: "full" } })
    await settled(cx3.data.message.id, codexSeat.id)
    const cxGranted = (await request(`/api/v1/room?project=${project}`)).data.messages.find((m) => m.authorId === codexSeat.id && m.replyTo === cx3.data.message.id)
    assert(
      cxGranted?.text === "沙箱=workspace-write 审批=on-request 本轮=workspaceWrite/on-request 命令=acceptForSession 文件=acceptForSession",
      `点了这次唤起全部允许，后面的该不再问直接过，实际 ${cxGranted?.text}`,
    )

    // After a server restart (cold boot): lanes that held pending work start
    // paused so queued messages never storm-spawn on boot; open calls whose
    // process is gone settle to "cut" while queued ones stay "queued"; and
    // runs that were still "running" become interrupted and are announced once.
    const { execFileSync } = await import("node:child_process")
    const { mkdtempSync } = await import("node:fs")
    const restartDir = mkdtempSync(pathMod.join(osMod.tmpdir(), "bench-restart-"))
    try {
      const loaderCode = `
        import { registerHooks } from "node:module";
        import { existsSync } from "node:fs";
        import path from "node:path";
        const root = process.cwd();
        registerHooks({
          resolve(specifier, context, nextResolve) {
            if (specifier.startsWith("@/")) {
              const target = path.join(root, specifier.slice(2));
              const file = existsSync(target + ".ts") ? target + ".ts" : target;
              return nextResolve("file://" + file, context);
            }
            return nextResolve(specifier, context);
          }
        });
      `
      const beforeCrashOut = execFileSync(
        process.execPath,
        [
          "--no-warnings",
          "--input-type=module",
          "-e",
          `${loaderCode}
          const { join, say, markCalls, listProjects, inProject } = await import("./lib/store.ts");
          const { dbSaveLane } = await import("./lib/db.ts");
          const { startRun } = await import("./lib/runs.ts");
          const projId = listProjects()[0].id;
          inProject(projId, () => {
            const qJoined = join({ name: "重启排队席", model: "mock-1", role: "测试", agentName: "claude", uuid: "sess-restart-q" });
            const rJoined = join({ name: "重启打断席", model: "mock-1", role: "测试", agentName: "claude", uuid: "sess-restart-r" });
            const qId = qJoined.agent.id;
            const rId = rJoined.agent.id;
            const mQ = say({ as: "human", text: "@重启排队席 排队等重启" }).message;
            const mR = say({ as: "human", text: "@重启打断席 跑一半重启" }).message;
            markCalls([mQ.id], qId, "queued");
            dbSaveLane(qId, projId, {
              paused: undefined,
              pending: [{ id: mQ.id, line: "用户：@重启排队席 排队等重启" }],
              hops: 0,
            });
            const deadRun = startRun(rId, "重启打断席", "reply", {
              project: projId,
              body: "用户：@重启打断席 跑一半重启",
              replyTo: mR.id,
            });
            markCalls([mR.id], rId, "started", { runId: deadRun.id });
            console.log(JSON.stringify({ projId, qId, rId, mQId: mQ.id, mRId: mR.id, deadRunId: deadRun.id }));
          });
          process.exit(0);
          `,
        ],
        { env: { ...process.env, BENCH_DATA_DIR: restartDir }, encoding: "utf8" },
      )
      const pre = JSON.parse(beforeCrashOut.trim().split("\n").at(-1))

      const afterBootOut = execFileSync(
        process.execPath,
        [
          "--no-warnings",
          "--input-type=module",
          "-e",
          `${loaderCode}
          const { ensureSummon } = await import("./lib/summon.ts");
          const { snapshot, inProject } = await import("./lib/store.ts");
          const { getRun } = await import("./lib/runs.ts");
          ensureSummon();
          const snap = inProject(${JSON.stringify(pre.projId)}, () => snapshot());
          const dead = getRun(${JSON.stringify(pre.deadRunId)});
          console.log(JSON.stringify({ snap, dead }));
          process.exit(0);
          `,
        ],
        { env: { ...process.env, BENCH_DATA_DIR: restartDir }, encoding: "utf8" },
      )
      const post = JSON.parse(afterBootOut.trim().split("\n").at(-1))
      const qAgent = post.snap.agents.find((a) => a.id === pre.qId)
      assert(
        qAgent?.queuedCount === 1 && qAgent?.queuePaused === true,
        `重启后有积压消息的席位队列应自动暂停，实际 queuedCount=${qAgent?.queuedCount} queuePaused=${qAgent?.queuePaused}`,
      )
      const postMQ = post.snap.messages.find((m) => m.id === pre.mQId)
      const postMR = post.snap.messages.find((m) => m.id === pre.mRId)
      const callQ = postMQ?.calls?.find((c) => c.id === pre.qId)
      const callR = postMR?.calls?.find((c) => c.id === pre.rId)
      assert(callQ?.state === "queued", `重启后仍在队列里的点名去向应保持 queued，实际 ${callQ?.state}`)
      assert(callR?.state === "cut", `重启后失去进程的 running 点名去向应标为 cut，实际 ${callR?.state}`)
      assert(
        post.dead?.state === "failed" && post.dead?.interrupted === true,
        `重启前正在跑的唤起应标为 interrupted，实际 ${JSON.stringify(post.dead)}`,
      )
      const interruptedMsg = post.snap.messages.find((m) => Array.isArray(m.interrupted))
      assert(
        interruptedMsg?.interrupted?.some((item) => item.runId === pre.deadRunId),
        `重启后房间应发出包含被打断 runId 的 interrupted 通知消息`,
      )
    } finally {
      rmSync(restartDir, { recursive: true, force: true })
    }
  } finally {
    if (baseList) {
      await request("/api/v1/adapters", { method: "POST", body: { as: "human", agents: baseList } }).catch(() => {})
    }
    if (hadAgentsFile && originalAgentsFile !== null) {
      writeFileSync(agentsFile, originalAgentsFile, "utf8")
      await request("/api/v1/adapters").catch(() => {})
    }
    // Clean up temporary mock seat credentials written by giveSeat in bench-mcp state dir.
    const keyFile = process.env.BENCH_KEY_FILE || `${process.cwd()}/data/human-key`
    const stateDirs = new Set([
      pathMod.resolve(pathMod.dirname(keyFile), "../state/bench-mcp"),
      pathMod.join(process.env.XDG_STATE_HOME || pathMod.join(osMod.homedir(), ".local", "state"), "bench-mcp"),
    ])
    const prefixes = [`${mockLimitName}-`, `${mockReliefName}-`, `${mockSlowName}-`, `${mockCheckName}-`, `${mockCodexName}-`]
    for (const dir of stateDirs) {
      try {
        for (const f of readdirSync(dir)) {
          if (prefixes.some((p) => f.startsWith(p))) {
            rmSync(pathMod.join(dir, f), { force: true })
          }
        }
      } catch {}
    }
    rmSync(fakeCodex, { force: true })
  }

  // ---- Mobile / webhook push (lib/push.ts, /api/v1/push): local-only mock receiver ----
  // Start the room with BENCH_PUSH_MERGE_MS=600 BENCH_PUSH_PERMIT_MS=1200 for fast runs,
  // or leave unset to exercise the real 20s merge window and 30s permit wait.
  {
    const httpMod = await import("node:http")
    const cryptoMod = await import("node:crypto")
    const fsMod = await import("node:fs")
    const keyFileForPush = process.env.BENCH_KEY_FILE || `${process.cwd()}/data/human-key`
    const pushDataDir = pathMod.dirname(keyFileForPush)
    const pushConfigFile = pathMod.join(pushDataDir, "push.json")
    const hadPushFile = fsMod.existsSync(pushConfigFile)
    const originalPushFile = hadPushFile ? fsMod.readFileSync(pushConfigFile, "utf8") : null

    const mergeMs = Number(process.env.BENCH_PUSH_MERGE_MS) >= 50 ? Number(process.env.BENCH_PUSH_MERGE_MS) : 20_000
    const permitMs = Number(process.env.BENCH_PUSH_PERMIT_MS) >= 50 ? Number(process.env.BENCH_PUSH_PERMIT_MS) : 30_000
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const decodeRfc2047 = (raw) =>
      String(raw || "").replace(/=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=/gi, (_, b64) =>
        Buffer.from(b64, "base64").toString("utf8"),
      )

    const pushReceived = []
    let pushFailHits = 0
    const mockPushServer = httpMod.createServer((req, res) => {
      const chunks = []
      req.on("data", (c) => chunks.push(c))
      req.on("end", () => {
        const rawBody = Buffer.concat(chunks).toString("utf8")
        let jsonBody = null
        try {
          jsonBody = JSON.parse(rawBody)
        } catch {}
        pushReceived.push({ method: req.method, url: req.url, headers: req.headers, rawBody, jsonBody })
        if (req.url?.startsWith("/always-500")) {
          pushFailHits += 1
          res.writeHead(500, { "content-type": "text/plain" })
          res.end("mock failure")
          return
        }
        if (req.url?.startsWith("/bark_")) {
          res.writeHead(200, { "content-type": "application/json" })
          res.end(JSON.stringify({ code: 200, message: "success" }))
          return
        }
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ ok: true, code: 0, errcode: 0 }))
      })
    })
    await new Promise((r) => mockPushServer.listen(0, "127.0.0.1", r))
    const mockBase = `http://127.0.0.1:${mockPushServer.address().port}`
    const extraProjects = []
    const pendingPermits = []

    const pushReq = async (pathname, { method = "GET", body, proj = project, key = humanKey } = {}) => {
      const url = method === "GET" && proj ? `${origin}${pathname}?project=${encodeURIComponent(proj)}` : `${origin}${pathname}`
      const headers = {}
      if (body !== undefined) headers["content-type"] = "application/json"
      if (key) headers["x-bench-human"] = key
      const payload = body !== undefined && proj ? { project: proj, ...body } : body
      const res = await fetch(url, {
        method,
        headers,
        body: payload !== undefined ? JSON.stringify(payload) : undefined,
      })
      const raw = await res.text()
      let data = {}
      try {
        data = JSON.parse(raw)
      } catch {}
      return { status: res.status, data, raw }
    }

    try {
      // Human key required on both GET and POST
      assert((await pushReq("/api/v1/push", { key: "" })).status === 403, "无口令读 /api/v1/push 应 403")
      assert((await pushReq("/api/v1/push", { key: "0".repeat(64) })).status === 403, "错口令读 /api/v1/push 应 403")
      assert(
        (await pushReq("/api/v1/push", { method: "POST", key: "", body: { as: "human", enabled: true } })).status === 403,
        "无口令改 /api/v1/push 应 403",
      )

      const secretMarks = [
        `ntfy_sec_${stamp}`,
        `tk_sec_${stamp}`,
        `bark_sec_${stamp}`,
        `wecom_sec_${stamp}`,
        `feishu_sec_${stamp}`,
        `fs_sign_${stamp}`,
        `9988:AAH_tg_${stamp}`,
        `-1009988${stamp}`,
        `wh_sec_${stamp}`,
        `wh_tok_${stamp}`,
        `fail_sec_${stamp}`,
      ]
      const checkNoSecretLeak = async (where) => {
        const s1 = await pushReq("/api/v1/push")
        const s2 = await pushReq("/api/v1/room")
        const s3 = await pushReq("/api/v1/projects", { proj: "" })
        const hay = `${s1.raw}\n${s2.raw}\n${s3.raw}`
        for (const m of secretMarks) assert(!hay.includes(m), `推送密钥在 ${where} 泄露到了接口响应或快照中`)
        assert(!("push" in s2.data), "房间快照不应包含 push 配置字段")
      }

      // 1) All 6 channel formats + 0600 file permission + zero secret echo
      pushReceived.length = 0
      let pr = await pushReq("/api/v1/push", {
        method: "POST",
        body: { as: "human", action: "test", enabled: true, channel: "ntfy", target: `${mockBase}/${secretMarks[0]}`, token: secretMarks[1] },
      })
      assert(pr.status === 200 && pr.data.ok === true && pushReceived.length === 1, "ntfy 测试发送失败")
      assert(
        pushReceived[0].url === `/${secretMarks[0]}` &&
          pushReceived[0].headers.authorization === `Bearer ${secretMarks[1]}` &&
          decodeRfc2047(pushReceived[0].headers.title).includes(`自测${stamp}`),
        "ntfy 请求头或路径不对",
      )
      const pushMode = fsMod.statSync(pushConfigFile).mode & 0o777
      assert(pushMode === 0o600, `data/push.json 权限必须是 0600，实际 0${pushMode.toString(8)}`)
      await checkNoSecretLeak("ntfy")

      pushReceived.length = 0
      pr = await pushReq("/api/v1/push", {
        method: "POST",
        body: { as: "human", action: "test", enabled: true, channel: "bark", target: `${mockBase}/bark_${secretMarks[2]}` },
      })
      assert(
        pr.status === 200 && pr.data.ok === true && pushReceived[0]?.jsonBody?.group === "并坐" && pushReceived[0]?.jsonBody?.title,
        "Bark 格式不对",
      )

      pushReceived.length = 0
      pr = await pushReq("/api/v1/push", {
        method: "POST",
        body: { as: "human", action: "test", enabled: true, channel: "wecom", target: `${mockBase}/cgi-bin/webhook/send?key=${secretMarks[3]}` },
      })
      assert(
        pr.status === 200 && pr.data.ok === true && pushReceived[0]?.jsonBody?.msgtype === "text" && pushReceived[0]?.jsonBody?.text?.content,
        "企业微信机器人格式不对",
      )

      pushReceived.length = 0
      pr = await pushReq("/api/v1/push", {
        method: "POST",
        body: {
          as: "human",
          action: "test",
          enabled: true,
          channel: "feishu",
          target: `${mockBase}/open-apis/bot/v2/hook/${secretMarks[4]}`,
          token: secretMarks[5],
        },
      })
      const fsSign = cryptoMod
        .createHmac("sha256", `${pushReceived[0]?.jsonBody?.timestamp}\n${secretMarks[5]}`)
        .update("")
        .digest("base64")
      assert(
        pr.status === 200 && pr.data.ok === true && pushReceived[0]?.jsonBody?.msg_type === "text" && pushReceived[0]?.jsonBody?.sign === fsSign,
        "飞书机器人格式或签名不对",
      )

      pushReceived.length = 0
      pr = await pushReq("/api/v1/push", {
        method: "POST",
        body: {
          as: "human",
          action: "test",
          enabled: true,
          channel: "telegram",
          target: mockBase,
          token: secretMarks[6],
          extra: secretMarks[7],
        },
      })
      assert(
        pr.status === 200 &&
          pr.data.ok === true &&
          pushReceived[0]?.url === `/bot${secretMarks[6]}/sendMessage` &&
          pushReceived[0]?.jsonBody?.chat_id === secretMarks[7],
        "Telegram 机器人格式不对",
      )

      pushReceived.length = 0
      pr = await pushReq("/api/v1/push", {
        method: "POST",
        body: {
          as: "human",
          action: "test",
          enabled: true,
          channel: "webhook",
          target: `${mockBase}/${secretMarks[8]}`,
          token: secretMarks[9],
          titleOnly: true,
        },
      })
      assert(
        pr.status === 200 &&
          pr.data.ok === true &&
          pushReceived[0]?.headers.authorization === `Bearer ${secretMarks[9]}` &&
          pushReceived[0]?.jsonBody?.source === "bench" &&
          pushReceived[0]?.jsonBody?.body === "" &&
          pushReceived[0]?.jsonBody?.items?.[0]?.snippet === undefined,
        "自定义 Webhook 或只推标题（不带正文）格式不对",
      )
      await checkNoSecretLeak("all-6-channels")

      // 2) Retry at most once (2 total attempts) + sanitized lastError
      pushFailHits = 0
      pr = await pushReq("/api/v1/push", {
        method: "POST",
        body: { as: "human", action: "test", enabled: true, channel: "webhook", target: `${mockBase}/always-500?k=${secretMarks[10]}` },
      })
      assert(pr.data.ok === false && pushFailHits === 2 && pr.data.state?.lastError?.message?.includes("HTTP 500"), "失败重试次数应最多 1 次（共 2 次）且记录错误")
      await checkNoSecretLeak("retry-error")

      // 3) Foreground suppression, 20s merge, settled ask/review skip, and 30s permit wait
      const mkProj = async (title) => {
        const res = await pushReq("/api/v1/projects", { method: "POST", proj: "", body: { as: "human", name: `${title}${stamp}` } })
        assert(res.status === 201, `建推送测试项目失败 ${res.raw}`)
        extraProjects.push(res.data.project.id)
        return { id: res.data.project.id, name: res.data.project.name }
      }
      const mkSeat = async (projId, name) => {
        const res = await pushReq("/api/v1/join", { method: "POST", proj: projId, key: "", body: { name, model: "m", role: "测" } })
        assert(res.status === 201, `入座失败 ${res.raw}`)
        return { id: res.data.agent.id, name: res.data.agent.name, token: res.data.token }
      }

      const pFront = await mkProj("推前台")
      const pMerge = await mkProj("推合并")
      const pSettle = await mkProj("推已答")
      const pPerm = await mkProj("推权限")

      const sFront = await mkSeat(pFront.id, "前席")
      const sMerge1 = await mkSeat(pMerge.id, "合甲")
      const sMerge2 = await mkSeat(pMerge.id, "合乙")
      const sSet = await mkSeat(pSettle.id, "答席")
      const sPermFast = await mkSeat(pPerm.id, "快权")
      const sPermSlow = await mkSeat(pPerm.id, "慢权")

      pushReceived.length = 0
      await pushReq("/api/v1/push", {
        method: "POST",
        body: { as: "human", enabled: true, channel: "webhook", target: `${mockBase}/live`, token: "", onEnd: true, titleOnly: false },
      })

      // Page in foreground -> suppressed
      await pushReq("/api/v1/push", { method: "POST", body: { as: "human", action: "presence", front: true } })
      await pushReq("/api/v1/ask", {
        method: "POST",
        proj: pFront.id,
        key: "",
        body: { agentId: sFront.id, token: sFront.token, action: "ask", text: "页面在前台时不该推" },
      })
      await pushReq("/api/v1/push", { method: "POST", body: { as: "human", action: "presence", front: false } })

      const tStart = Date.now()
      // Same project within merge window -> coalesce into ONE push
      const ask65 = "验证超长正文截断：" + "一二三四五六七八九十".repeat(7)
      await pushReq("/api/v1/ask", {
        method: "POST",
        proj: pMerge.id,
        key: "",
        body: { agentId: sMerge1.id, token: sMerge1.token, action: "ask", text: ask65 },
      })
      const tMerge = await pushReq("/api/v1/tasks", {
        method: "POST",
        proj: pMerge.id,
        body: { as: "human", title: "待验项", owner: sMerge2.name, steps: ["做", "用户验收"] },
      })
      await pushReq(`/api/v1/tasks/${tMerge.data.task.id}`, {
        method: "POST",
        proj: pMerge.id,
        key: "",
        body: { agentId: sMerge2.id, token: sMerge2.token, action: "review", note: "请验收" },
      })

      // Answered ask before merge fires -> NOT pushed
      const openQ = await pushReq("/api/v1/ask", {
        method: "POST",
        proj: pSettle.id,
        key: "",
        body: { agentId: sSet.id, token: sSet.token, action: "ask", text: "马上回答的问题" },
      })
      await pushReq("/api/v1/say", {
        method: "POST",
        proj: pSettle.id,
        body: { as: "human", text: "已答", replyTo: openQ.data.message.id },
      })

      // Permits: one decided early (< permitMs), one unanswered (>= permitMs)
      pendingPermits.push(
        pushReq("/api/v1/permit", {
          method: "POST",
          proj: pPerm.id,
          key: "",
          body: { agentId: sPermFast.id, token: sPermFast.token, action: "tool", tool: "Bash", input: { command: "echo decided-early" } },
        }),
        pushReq("/api/v1/permit", {
          method: "POST",
          proj: pPerm.id,
          key: "",
          body: { agentId: sPermSlow.id, token: sPermSlow.token, action: "tool", tool: "Bash", input: { command: "echo waited-full" } },
        }),
      )
      await sleep(250)
      const permSnap = await pushReq("/api/v1/room", { proj: pPerm.id })
      const fastPerm = permSnap.data.permits.find((p) => p.agentId === sPermFast.id)
      const slowPerm = permSnap.data.permits.find((p) => p.agentId === sPermSlow.id)
      assert(fastPerm && slowPerm, "应有两条待批权限")
      await pushReq("/api/v1/permit", { method: "POST", proj: pPerm.id, body: { as: "human", id: fastPerm.id, decision: "once" } })

      // Wait past mergeMs (but before permitMs if permitMs > mergeMs + 1500)
      await sleep(Math.max(0, tStart + mergeMs + 1_200 - Date.now()))
      assert(pushReceived.filter((x) => x.jsonBody?.project === pFront.name).length === 0, "页面在前台时不该推")
      assert(pushReceived.filter((x) => x.jsonBody?.project === pSettle.name).length === 0, "已回答的提问不该补推")
      const mergedList = pushReceived.filter((x) => x.jsonBody?.project === pMerge.name)
      assert(
        mergedList.length === 1 && mergedList[0].jsonBody.count === 2 && [...mergedList[0].jsonBody.items[0].snippet].length === 61,
        `同一项目合并窗口内两件事应合成 1 条且正文截断 60 字，实际 ${JSON.stringify(mergedList)}`,
      )
      if (permitMs - mergeMs > 2_500) {
        assert(pushReceived.filter((x) => x.jsonBody?.project === pPerm.name).length === 0, "权限未满 30 秒前不该推")
      }

      await sleep(Math.max(0, tStart + permitMs + 1_500 - Date.now()))
      const permList = pushReceived.filter((x) => x.jsonBody?.project === pPerm.name)
      assert(
        permList.length === 1 &&
          permList[0].jsonBody.text.includes("waited-full") &&
          !permList[0].jsonBody.text.includes("decided-early"),
        `权限应只推等满 30 秒未处理的那条，实际 ${JSON.stringify(permList)}`,
      )
      await pushReq("/api/v1/permit", { method: "POST", proj: pPerm.id, body: { as: "human", id: slowPerm.id, decision: "deny", note: "测完" } })
      await Promise.allSettled(pendingPermits)
    } finally {
      for (const pid of extraProjects) {
        await pushReq(`/api/v1/projects/${pid}`, {
          method: "POST",
          proj: "",
          body: { as: "human", action: "delete", confirm: "删除" },
        }).catch(() => {})
      }
      await pushReq("/api/v1/push", { method: "POST", proj: "", body: { as: "human", action: "clear" } }).catch(() => {})
      if (hadPushFile && originalPushFile !== null) {
        fsMod.writeFileSync(pushConfigFile, originalPushFile, { mode: 0o600 })
        fsMod.chmodSync(pushConfigFile, 0o600)
      } else {
        fsMod.rmSync(pushConfigFile, { force: true })
      }
      mockPushServer.close()
    }
  }

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
