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
    const prefixes = [`${mockLimitName}-`, `${mockReliefName}-`, `${mockSlowName}-`]
    for (const dir of stateDirs) {
      try {
        for (const f of readdirSync(dir)) {
          if (prefixes.some((p) => f.startsWith(p))) {
            rmSync(pathMod.join(dir, f), { force: true })
          }
        }
      } catch {}
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
