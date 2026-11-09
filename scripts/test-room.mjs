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
