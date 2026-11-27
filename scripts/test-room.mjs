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

  // Tasks finished more than 48 hours ago are omitted from the main snapshot
  // (`room.tasks`) to keep every push light, while `room.doneTotal` reports the
  // full count and `GET /api/v1/tasks` + `GET /api/v1/tasks/<id>` fetch them on demand.
  {
    const secondDone = await request("/api/v1/tasks", {
      method: "POST",
      body: { ...asAlpha, title: `另一条完成的待办${stamp}`, owner: alpha.data.agent.name, steps: ["做完它"] },
    })
    assert(secondDone.status === 201, "创建第二条已完成测试待办失败")
    const secondId = secondDone.data.task.id
    await request(`/api/v1/tasks/${secondId}`, { method: "POST", body: { ...asAlpha, action: "step", step: 1, state: "done" } })
    await request(`/api/v1/tasks/${secondId}`, { method: "POST", body: { ...asAlpha, action: "review", note: "完成" } })
    const secondPassed = await request(`/api/v1/tasks/${secondId}`, { method: "POST", body: { as: "human", action: "pass" } })
    assert(secondPassed.status === 200 && secondPassed.data.task.status === "done", "第二条已完成测试待办验收失败")

    // Both read-only endpoints work without the human key.
    const byIdRes = await request(`/api/v1/tasks/${secondId}?project=${project}`, { key: false })
    assert(
      byIdRes.status === 200 && byIdRes.data.task?.id === secondId && byIdRes.data.task?.status === "done",
      `按 id 拉取待办失败：${byIdRes.status} ${JSON.stringify(byIdRes.data)}`,
    )
    const missingTaskRes = await request(`/api/v1/tasks/t_00000000?project=${project}`, { key: false })
    assert(missingTaskRes.status === 404, `不存在的待办应返回 404，实际 ${missingTaskRes.status}`)

    const snapNow = await request(`/api/v1/room?project=${project}`)
    assert(
      snapNow.data.doneTotal === 2,
      `快照 doneTotal 应为全部已完成总数 2，实际 ${snapNow.data.doneTotal}`,
    )

    const page1 = await request(`/api/v1/tasks?project=${project}&done=1&limit=1`, { key: false })
    assert(
      page1.status === 200 &&
        page1.data.tasks?.length === 1 &&
        page1.data.doneTotal === 2 &&
        page1.data.hasMore === true,
      `分页拉取第一页已完成待办不对：${JSON.stringify(page1.data)}`,
    )
    const firstId = page1.data.tasks[0].id
    const otherId = firstId === secondId ? passed.data.task.id : secondId
    const page2 = await request(`/api/v1/tasks?project=${project}&done=1&before=${firstId}&limit=5`, {
      key: false,
    })
    assert(
      page2.status === 200 &&
        page2.data.tasks?.length === 1 &&
        page2.data.tasks[0].id === otherId &&
        page2.data.hasMore === false,
      `分页拉取更早已完成待办应包含 ${otherId}，实际 ${JSON.stringify(page2.data)}`,
    )

    // Verify >48h archival window, doneTotal, pagination, and by-id lookup against cold DB load.
    const { execFileSync } = await import("node:child_process")
    const pathMod = await import("node:path")
    const { fileURLToPath } = await import("node:url")
    const archiveTest = fileURLToPath(new URL("./test-tasks-archive.mjs", import.meta.url))
    const repoDir = pathMod.resolve(pathMod.dirname(archiveTest), "..")
    execFileSync(process.execPath, [archiveTest], {
      cwd: repoDir,
      env: { ...process.env, BENCH_ROOT: repoDir },
      encoding: "utf8",
    })
  }

  // 「等你定」: one card per thing, ordered, a stale question asked twice
  // (lib/waiting-shared.ts; the checks run in-process in scripts/test-waiting.mjs).
  {
    const { execFileSync } = await import("node:child_process")
    const pathMod = await import("node:path")
    const { fileURLToPath } = await import("node:url")
    const waitingTest = fileURLToPath(new URL("./test-waiting.mjs", import.meta.url))
    const repoDir = pathMod.resolve(pathMod.dirname(waitingTest), "..")
    execFileSync(process.execPath, [waitingTest], { cwd: repoDir, env: { ...process.env, BENCH_ROOT: repoDir }, encoding: "utf8" })
    const peekDoingTest = fileURLToPath(new URL("./test-peek-doing.mjs", import.meta.url))
    execFileSync(process.execPath, [peekDoingTest], { cwd: repoDir, env: { ...process.env, BENCH_ROOT: repoDir }, encoding: "utf8" })
  }

  // 「你不在的这段时间」: the card's data comes from GET /api/v1/away, read-only
  // and without the key; the lines themselves are tested in-process in
  // scripts/test-away.mjs.
  {
    const revBefore = (await request(`/api/v1/room?project=${project}`)).data.rev
    const away = await request(`/api/v1/away?since=${Date.now() - 3600_000}&project=${project}`, { key: false })
    assert(
      away.status === 200 && away.data.scope === "project" && Array.isArray(away.data.lines) && away.data.lines.every((line) => line.text && line.target),
      `GET /api/v1/away 结构不对：${away.status} ${JSON.stringify(away.data).slice(0, 200)}`,
    )
    const deskAway = await request(`/api/v1/away?since=${Date.now() - 3600_000}`, { key: false })
    assert(deskAway.status === 200 && deskAway.data.scope === "front" && Array.isArray(deskAway.data.projects), "不带 project 是前台总览")
    assert((await request("/api/v1/away?since=abc", { key: false })).status === 400, "since 不对要返回 400")
    assert((await request(`/api/v1/room?project=${project}`)).data.rev === revBefore, "读 /api/v1/away 不该改房间版本")
  }

  // 「说人话」: what an agent writes for the user is checked, and sent back
  // with a way to rewrite it when it reads as code. Only agents are held to it.
  const plainTask = (title, steps, who = asAlpha) =>
    request("/api/v1/tasks", { method: "POST", body: { ...who, title, owner: `甲${stamp}`, steps } })
  for (const bad of ["改 lib/store.ts 的 createTask", "gist.tsx 加 summaryOf", "把 `summaryOf` 换掉", "接着做 t_5de117f4", "bench_task 要检查标题", "看 http://127.0.0.1:4399 的页面"]) {
    const refused = await plainTask(bad, ["做"])
    assert(refused.status === 400 && /待办标题/.test(refused.data.error) && /用户能得到什么/.test(refused.data.error), `夹着代码的标题该被退回并带改法：${bad} 得到 ${refused.status} ${refused.data.error}`)
  }
  for (const fine of ["聊天里长回复先只显示一句结论", "把 Claude 和 GPT 接进 App：Gemini、DeepSeek 也能用", "第 3 步：深色下也看得清", "修：额度到点后自动继续"]) {
    const ok = await plainTask(fine, ["先做第一件", "再看效果"])
    assert(ok.status === 201, `大白话标题不该被拦：${fine} 得到 ${ok.status} ${ok.data.error}`)
  }
  const badStep = await plainTask("步骤被退回", ["改 components/room/gist.tsx"])
  assert(badStep.status === 400 && /待办步骤/.test(badStep.data.error), `夹着文件名的步骤该被退回 ${badStep.status} ${badStep.data.error}`)
  const plainOne = (await plainTask("检查加步骤", ["先做"])).data.task
  const plainPath = `/api/v1/tasks/${plainOne.id}`
  const addBad = await request(plainPath, { method: "POST", body: { ...asAlpha, action: "step", add: ["跑 tsc 和 eslint"] } })
  assert(addBad.status === 400 && /待办步骤/.test(addBad.data.error), `加步骤也要检查 ${addBad.status} ${addBad.data.error}`)
  assert((await request(`/api/v1/room?project=${project}`)).data.tasks.find((item) => item.id === plainOne.id).steps.length === 1, "被退回的步骤不该留下")
  const addFine = await request(plainPath, { method: "POST", body: { ...asAlpha, action: "step", add: ["再看效果"] } })
  assert(addFine.status === 200, "大白话步骤该能加")
  // A step's own note is a detail: not checked.
  const noteCode = await request(plainPath, { method: "POST", body: { ...asAlpha, action: "step", step: 1, state: "done", note: "改了 lib/store.ts，tsc 过了" } })
  assert(noteCode.status === 200, "步骤的 note 可以写技术细节")
  const reviewBad = await request(plainPath, { method: "POST", body: { ...asAlpha, action: "review", note: "改了 lib/store.ts，跑了 tsc" } })
  assert(reviewBad.status === 400 && /验收说明/.test(reviewBad.data.error) && /怎么看到效果/.test(reviewBad.data.error), `验收说明第一句夹代码该被退回 ${reviewBad.status} ${reviewBad.data.error}`)
  assert((await request(`/api/v1/room?project=${project}`)).data.tasks.find((item) => item.id === plainOne.id).review === undefined, "被退回的验收说明不该让待办进入等验收")
  const reviewFine = await request(plainPath, { method: "POST", body: { ...asAlpha, action: "review", note: "刷新页面，左栏顶上多了一个开关。\n细节：lib/store.ts 的 createTask，tsc 和 eslint 都过了" } })
  assert(reviewFine.status === 200 && reviewFine.data.task.review?.state === "waiting", `第一句是大白话、后面写代码，该能请验收 ${reviewFine.status} ${reviewFine.data.error}`)
  // The user's own to-dos are never checked, and a copy of an old one (its
  // title already stored) goes through for an agent too.
  const mine = await request("/api/v1/tasks", { method: "POST", body: { as: "human", title: "改 lib/store.ts 的 createTask", owner: `甲${stamp}`, steps: ["改 gist.tsx"] } })
  assert(mine.status === 201, `用户自己建的待办不该被检查 ${mine.status} ${mine.data.error}`)
  const copied = await request(`/api/v1/tasks/${mine.data.task.id}`, { method: "POST", body: { ...asAlpha, action: "fork" } })
  assert(copied.status === 200 && copied.data.task.title === mine.data.task.title, `复制一条旧待办不该被检查 ${copied.status} ${copied.data.error}`)

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
  assert(hinted?.reply?.id === question.data.message.id && hinted.reply.gist === question.data.message.text, "收件箱没说这条回复的是哪条")
  const chain = await request("/api/v1/messages", {
    method: "POST",
    body: { agentId: alpha.data.agent.id, token: alpha.data.token, chain: answer.data.message.id },
  })
  assert(chain.status === 200, `取回复链失败 ${chain.data.error || chain.status}`)
  assert(
    chain.data.messages.map((message) => message.text).join("|") === `${question.data.message.text}|我来回|接着回`,
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
    afterRoom.data.messages.some((message) => message.kind === "system" && message.seq > afterEnd.data.message.seq && message.text.includes(`己${stamp} 未报会话 id`)),
    "别的席位结束本轮后，agent 之间的 @ 被悄悄挡掉了",
  )
  const marked = await request("/api/v1/say", {
    method: "POST",
    body: { agentId: beta.data.agent.id, token: beta.data.token, text: "【本轮结束】我这边也好了" },
  })
  assert(marked.data.message.end === true, "以标记开头的回答没认成结束本轮")
  const mimic = await request("/api/v1/say", { method: "POST", body: { as: "human", text: "【本轮结束】人说的不算" } })
  assert(!mimic.data.message.end, "人说的话不该当成结束本轮")
  // The user says something to nobody and answers nothing: it goes to the
  // last AI that spoke here (t_bd01d3c1), the @ written into the text.
  const lastName = beta.data.agent.name
  assert(
    mimic.data.message.mentions.join() === beta.data.agent.id && mimic.data.message.text === `@${lastName} 【本轮结束】人说的不算`,
    `没 @ 人的话没改叫最后说话的 AI：${mimic.data.message.text}`,
  )
  const named = await request("/api/v1/say", { method: "POST", body: { as: "human", text: `@${alpha.data.agent.name} 只叫甲` } })
  assert(named.data.message.mentions.join() === alpha.data.agent.id && !named.data.message.text.includes(`@${lastName}`), "@ 了人还被加了别人")
  const answering = await request("/api/v1/say", { method: "POST", body: { as: "human", text: "回甲那句", replyTo: ended.data.message.id } })
  assert(answering.data.message.mentions.length === 0 && answering.data.message.text === "回甲那句", "回复某条时不该再加 @")
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
  assert(recalled.status === 200 && recalled.data.original.text === secret.data.message.text, "撤回失败或没带回原文")
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
  const pendingPermit = request("/api/v1/permit", { method: "POST", body: { ...seatA, action: "tool", tool: "Bash", input: { command: "ls /opt", description: "看看 /opt 下有什么" } } })
  let permitRoom
  for (let tries = 0; tries < 20; tries++) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    permitRoom = await request(`/api/v1/room?project=${project}`)
    if (permitRoom.data.permits?.length) break
  }
  const shown = permitRoom.data.permits?.[0]
  assert(shown?.tool === "Bash" && shown.input === "ls /opt" && shown.agentId === seatA.agentId, "权限请求没出现在快照里")
  assert(shown.plain?.action === "运行一条命令" && shown.plain.why === "看看 /opt 下有什么", `权限卡要先有一句人话：${JSON.stringify(shown.plain)}`)
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

  // First-layer waiting overview (`GET /api/v1/waiting`, read-only without key):
  // exposes open asks & waiting reviews across ordinary projects and drops them once handled.
  {
    const revTaskRes = await request("/api/v1/tasks", {
      method: "POST",
      body: { ...alphaSeat, title: `跨项目等定检查${stamp}`, owner: alpha.data.agent.name, steps: ["做完", "请用户验收"] },
    })
    assert(revTaskRes.status === 201, "创建等定检查待办失败")
    const revTaskId = revTaskRes.data.task.id
    await request(`/api/v1/tasks/${revTaskId}`, { method: "POST", body: { ...alphaSeat, action: "step", step: 1, state: "done" } })
    await request(`/api/v1/tasks/${revTaskId}`, { method: "POST", body: { ...alphaSeat, action: "review", note: "功能已备好。" } })

    const wait1 = await request("/api/v1/waiting", { key: false })
    assert(
      wait1.status === 200 &&
        Array.isArray(wait1.data.permits) &&
        Array.isArray(wait1.data.asks) &&
        Array.isArray(wait1.data.limited) &&
        Array.isArray(wait1.data.interrupted) &&
        Array.isArray(wait1.data.reviews) &&
        typeof wait1.data.workingTotal === "number",
      `GET /api/v1/waiting 返回结构不对：${JSON.stringify(wait1.data)}`,
    )
    assert(
      wait1.data.asks.some((item) => item.projectId === project && item.message?.id === later.data.message.id),
      "GET /api/v1/waiting 应包含当前未回答提问",
    )
    assert(
      wait1.data.reviews.some((item) => item.projectId === project && item.row?.id === revTaskId),
      "GET /api/v1/waiting 应包含当前等验收待办",
    )

    // Pass that review directly with explicit project (as the front desk does)
    const passByProj = await request(`/api/v1/tasks/${revTaskId}`, {
      method: "POST",
      body: { as: "human", project, action: "pass" },
    })
    assert(passByProj.status === 200 && passByProj.data.task.status === "done", "指定项目通过待办失败")
  }

  await request("/api/v1/say", { method: "POST", body: { as: "human", text: "要", replyTo: later.data.message.id } })
  askRoom = await request(`/api/v1/room?project=${project}`)
  const laterCard = askRoom.data.messages.find((message) => message.id === later.data.message.id)
  assert(laterCard.ask.state === "answered" && !laterCard.ask.handed, "没人在等时回答不该记成已直接交给提问者")
  {
    const wait2 = await request("/api/v1/waiting", { key: false })
    assert(
      !wait2.data.asks.some((item) => item.message?.id === later.data.message.id),
      "回答提问后 GET /api/v1/waiting 不应再包含该提问",
    )
  }

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
  // A picture on a message that will be older than the 400 kept in memory.
  // Not an upload: those are served from data/uploads whatever a message says.
  const oldFs = await import("node:fs")
  const oldPath = await import("node:path")
  const oldDir = oldFs.mkdtempSync(oldPath.join((await import("node:os")).tmpdir(), "bench-old-"))
  const oldPicture = oldPath.join(oldDir, `早期的图${stamp}.png`)
  oldFs.writeFileSync(
    oldPicture,
    Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"),
  )
  const earlyPhrase = await request("/api/v1/say", {
    method: "POST",
    body: { ...gammaSeat, text: `早期架构暗语：琥珀星云-${stamp}`, attachments: [{ path: oldPicture }] },
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

  // The picture on that early message still opens (the room once looked for
  // it only among the 400 in memory and answered 404).
  const oldImage = await fetch(`${origin}/api/v1/files?path=${encodeURIComponent(oldPicture)}&project=${project}`)
  await oldImage.arrayBuffer()
  assert(oldImage.status === 200, `400 条以前的消息里的图片应当还能打开，实际 ${oldImage.status}`)
  oldFs.rmSync(oldDir, { recursive: true, force: true })

  // A bridge's keep-alive from a seat that is online changes nothing the
  // page shows: the room's revision stays, so no page is sent the room again.
  // (Tried a few times: something else in the room may move it in between.)
  let beatKept = false
  let beatSeen = ""
  for (let attempt = 0; attempt < 4 && !beatKept; attempt++) {
    const revBefore = (await request(`/api/v1/room?project=${project}`)).data.rev
    const beat = await request("/api/v1/pulse", { method: "POST", body: { ...gammaSeat, keepalive: true } })
    const revAfter = (await request(`/api/v1/room?project=${project}`)).data.rev
    beatSeen = `${beat.status}：${revBefore} → ${revAfter}`
    beatKept = beat.status === 200 && revAfter === revBefore
  }
  assert(beatKept, `在线席位的保活不该改房间版本号（${beatSeen}）`)

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
  // 5-hour allowance that resets in an hour (carries on by itself by default,
  // t_51220c7e) and a weekly one (stays a card for the user).
  const mockSoonName = `mocksoon_${stamp}`
  const mockWeekName = `mockweek_${stamp}`
  // Ends well, and the only thing on stderr is the isolation launcher's socat
  // complaining about a bridged connection (lib/summon.ts withoutBridgeNoise).
  const mockBridgeName = `mockbridge_${stamp}`
  const mockBadName = `mockbad_${stamp}`
  // Network failures (lib/netfail.ts): fails twice then answers, always fails,
  // and one that says back the to-dos its prompt told it it still owes.
  const mockFlakyName = `mockflaky_${stamp}`
  const mockNetName = `mocknet_${stamp}`
  const mockBalanceName = `mockbal_${stamp}`
  const mockStreamNetName = `mockenet_${stamp}`
  const mockCapacityName = `mockcap_${stamp}`
  const mockOwesName = `mockowes_${stamp}`
  // Gists (t_83c6fcc9): a reply whose first line is its conclusion, a long one
  // that opens with a heading, a summary seat that writes one line per
  // message it is given, and one that fails.
  const mockGistName = `mockgist_${stamp}`
  const mockHeadName = `mockhead_${stamp}`
  const mockGisterName = `mockgister_${stamp}`
  const mockGisterBadName = `mockgbad_${stamp}`
  // The checker before the user's sign-off (lib/summon.ts checkTask): its
  // verdict goes by a mark in the task's title.
  const mockCheckName = `mockcheck_${stamp}`
  const mockCheckAltName = `mockcheck2_${stamp}`
  const checkCmd = `node -e "const t = process.argv[2] || ''; if (t.includes('【改好】')) { console.log('复验结论：通过\\n类别：跑得出\\n改好了\\n没验到的：无'); } else if (t.includes('【慢复验】')) { setTimeout(() => console.log('复验结论：通过\\n类别：跑得出\\n慢复验通过\\n没验到的：无'), 900); } else if (t.includes('【没过】')) { console.log('想了想\\n复验结论：没过\\n按钮没反应\\n没验到的：无'); } else if (t.includes('【没验到】')) { console.log('复验结论：没验到\\n要真机\\n没验到的：全部'); } else if (t.includes('【乱答】')) { console.log('挺好的'); } else if (t.includes('【跑得出】')) { console.log('复验结论：通过\\n类别：跑得出\\n接口断言全过\\n没验到的：无'); } else if (t.includes('【要人看带漏验】')) { console.log('复验结论：通过\\n类别：要人看\\n功能正常\\n没验到的：浅色窄屏排版未看'); } else if (t.includes('【只能本人签】')) { console.log('复验结论：通过\\n类别：只能本人签\\n涉及口令校验\\n没验到的：无'); } else { console.log('复验结论：通过\\n看过了\\n没验到的：无'); }" {uuid} {text}`
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
            command: `node -e "setTimeout(() => console.log('[慢轮完成]'), 2500)" {uuid} {text}`,
            reply: "stdout",
          },
          // Ends well without a word, and ends in an error.
          { name: mockMuteName, command: `node -e "setTimeout(() => {}, 200)" {uuid} {text}`, reply: "stdout" },
          {
            name: mockSoonName,
            command: `node -e "const d = new Date(Date.now() + 3600000); const h = d.getHours(); console.log('You\\'ve hit your 5-hour limit · resets ' + (h % 12 || 12) + ':' + String(d.getMinutes()).padStart(2, '0') + (h < 12 ? 'am' : 'pm')); process.exit(1)" {uuid} {text}`,
            reply: "stdout",
          },
          {
            name: mockWeekName,
            command: `node -e "const d = new Date(Date.now() + 3600000); const h = d.getHours(); console.log('You\\'ve hit your weekly limit · resets ' + (h % 12 || 12) + ':' + String(d.getMinutes()).padStart(2, '0') + (h < 12 ? 'am' : 'pm')); process.exit(1)" {uuid} {text}`,
            reply: "stdout",
          },
          {
            name: mockBridgeName,
            command: `node -e "process.stderr.write('2026/11/14 22:24:33 socat[52] E write(5, 0x58a7e3bed000, 24): Broken pipe\\n')" {uuid} {text}`,
            reply: "stdout",
          },
          { name: mockBadName, command: `node -e "process.stderr.write('mock 故意出错'); process.exit(3)" {uuid} {text}`, reply: "stdout" },
          {
            name: mockFlakyName,
            command: `node -e "const fs = require('fs'); const f = require('os').tmpdir() + '/bench-flaky-' + process.argv[1]; const n = fs.existsSync(f) ? Number(fs.readFileSync(f, 'utf8')) : 0; fs.writeFileSync(f, String(n + 1)); if (n < 2) { process.stderr.write('read ECONNRESET'); process.exit(1) } fs.rmSync(f); console.log('[重试后答了]' + ((process.argv[2] || '').includes('刚才被打断') ? '|带着原来的消息' : ''))" {uuid} {text}`,
            reply: "stdout",
          },
          {
            name: mockGistName,
            command: `node -e "console.log('做完了：第一行就是结论。' + String.fromCharCode(10, 10) + '## 细节' + String.fromCharCode(10) + '细节'.repeat(150))" {uuid} {text}`,
            reply: "stdout",
          },
          {
            name: mockHeadName,
            command: `node -e "console.log('## 先写标题' + String.fromCharCode(10) + '| a | b |' + String.fromCharCode(10) + '细节'.repeat(150))" {uuid} {text}`,
            reply: "stdout",
          },
          {
            name: mockGisterName,
            command: `node -e "const t = process.argv[2] || ''; const ids = [...t.matchAll(/【(m_[0-9a-z]+)】/g)].map((m) => m[1]); console.log(ids.map((id) => '[' + id + '] 补的摘要 @谁 ' + id).join(String.fromCharCode(10)))" {uuid} {text}`,
            reply: "stdout",
          },
          { name: mockGisterBadName, command: `node -e "process.stderr.write('摘要席位故意出错'); process.exit(2)" {uuid} {text}`, reply: "stdout" },
          { name: mockNetName, command: `node -e "process.stderr.write('TRANSPORT: Connection error.'); process.exit(1)" {uuid} {text}`, reply: "stdout" },
          {
            name: mockBalanceName,
            command: `node -e "console.log(JSON.stringify({ type: 'turn.failed', error: { message: JSON.stringify({ error: { message: 'You exceeded your current quota, please check your plan and billing details.', code: 'insufficient_quota' } }) } }))" {uuid} {text}`,
            reply: "stdout",
          },
          {
            name: mockStreamNetName,
            command: `node -e "console.log(JSON.stringify({ type: 'error', message: 'There was a network issue connecting to the server (attempt 1)', retry: true })); console.log(JSON.stringify({ event: 'error', message: 'API error: error decoding response body: EOF' }))" {uuid} {text}`,
            reply: "stdout",
          },
          {
            name: mockCapacityName,
            command: `node -e "const msg = 'API error (attempt 5): UNAVAILABLE (code 503): No capacity available for model gemini-4-argon-high on the server'; console.log(JSON.stringify({ event: 'error', message: msg, retry: true })); process.stderr.write(msg); process.exit(1)" {uuid} {text}`,
            reply: "stdout",
          },
          { name: mockCheckName, command: checkCmd, reply: "stdout" },
          { name: mockCheckAltName, command: checkCmd, reply: "stdout" },
          // "--json": read as a streaming client, like codex-wake.sh.
          { name: mockCodexName, command: `CODEX_BIN="${fakeCodex.replaceAll("\\", "/")}" node ./scripts/codex-app.mjs {uuid} {text} # --json`, reply: "stdout" },
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

    // With 「5 小时额度到点自动继续」 off, the card waits for the user.
    const limitOff = await request("/api/v1/retry", { method: "POST", body: { as: "human", limit: false } })
    assert(limitOff.status === 200 && limitOff.data.limit === false, `关掉到点自动继续失败 ${limitOff.status}`)
    assert((await request("/api/v1/retry")).data.limit === false, "关掉后 GET 该读到 limit=false")
    await request("/api/v1/say", { method: "POST", body: { as: "human", text: `@丙${stamp} 请开始执行压测` } })
    let limitMsg = null
    for (let tries = 0; tries < 30; tries++) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      const snap = await request(`/api/v1/room?project=${project}`)
      limitMsg = snap.data.messages.find((m) => m.limited?.agentId === gammaSeat.agentId)
      if (limitMsg) break
    }
    assert(limitMsg?.limited?.state === "open", `关掉自动继续时撞额度该是 open 的卡片，实际 ${limitMsg?.limited?.state}`)
    await request("/api/v1/retry", { method: "POST", body: { as: "human", limit: true } })
    assert((await request(`/api/v1/room?project=${project}`)).data.limitResume === true, "打开后房间快照该带 limitResume=true")

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

    // Only an @ calls a seat: a name written without one is talked about
    // (「两位开发都交付了，@验收 接手」 woke both developers).
    const calledSeat = await seatIn("被点名", mockReliefName)
    const namedSeat = await seatIn("被提到", mockReliefName)
    const mentionOnly = await request("/api/v1/say", {
      method: "POST",
      body: { as: "human", text: `@${calledSeat.name} ${namedSeat.name} 已经交付了，你接手` },
    })
    assert((await settled(mentionOnly.data.message.id, calledSeat.id))?.state === "answered", "被 @ 的席位没被叫醒")
    await new Promise((resolve) => setTimeout(resolve, 500))
    const notCalled = await callOf(mentionOnly.data.message.id, namedSeat.id)
    const namedSaid = (await request(`/api/v1/room?project=${project}`)).data.messages.some((m) => m.authorId === namedSeat.id)
    assert(!notCalled && !namedSaid, `正文里只写了名字、没有 @ 的席位不该被叫醒 ${JSON.stringify(notCalled)}`)

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
    // The launcher's socat line on stderr is not the client's error.
    const bridgeSeat = await seatIn("去向桥", mockBridgeName)
    const c3b = await request("/api/v1/say", { method: "POST", body: { as: "human", text: `@${bridgeSeat.name} 隔离启动器` } })
    const end3b = await settled(c3b.data.message.id, bridgeSeat.id)
    assert(end3b?.state === "silent", `只有 socat 桥接报错不该算失败，实际 ${end3b?.state} ${end3b?.note}`)

    // A 5-hour allowance with a reset in an hour: scheduled by itself (on by
    // default), a little after the reset; the user can still take it back.
    const limitCardOf = async (seatId) => {
      for (let tries = 0; tries < 40; tries++) {
        const found = (await request(`/api/v1/room?project=${project}`)).data.messages.find((m) => m.limited?.agentId === seatId)
        if (found) return found
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      return null
    }
    const soonSeat = await seatIn("额度五时", mockSoonName)
    await request("/api/v1/say", { method: "POST", body: { as: "human", text: `@${soonSeat.name} 干活` } })
    const soonCard = await limitCardOf(soonSeat.id)
    const soonLead = (soonCard?.limited?.at ?? 0) - (soonCard?.limited?.resetsAt ?? 0)
    assert(
      soonCard?.limited?.state === "scheduled" && soonCard.limited.resetsAt > Date.now() && soonLead === 45_000,
      `撞上 5 小时额度且读得出重置时间，默认该自己定好到点继续（重置后 45 秒），实际 ${JSON.stringify(soonCard?.limited)}`,
    )
    const soonCancel = await request(`/api/v1/runs/${soonCard.limited.runId}`, { method: "POST", body: { as: "human", action: "cancel" } })
    assert(soonCancel.status === 200, `自动定的也能取消，实际 ${soonCancel.status} ${soonCancel.data.error || ""}`)
    const soonAfter = (await request(`/api/v1/room?project=${project}`)).data.messages.find((m) => m.id === soonCard.id)
    assert(soonAfter?.limited?.state === "open" && !soonAfter.limited.at, `取消后卡片该回到 open，实际 ${JSON.stringify(soonAfter?.limited)}`)
    // A weekly allowance is never carried on by itself.
    const weekSeat = await seatIn("额度每周", mockWeekName)
    await request("/api/v1/say", { method: "POST", body: { as: "human", text: `@${weekSeat.name} 干活` } })
    const weekCard = await limitCardOf(weekSeat.id)
    assert(weekCard?.limited?.state === "open", `每周额度不该自动定时，实际 ${JSON.stringify(weekCard?.limited)}`)

    // Ended in an error: failed, with why; and the seat owes that call.
    const badSeat = await seatIn("去向坏", mockBadName)
    const c4 = await request("/api/v1/say", { method: "POST", body: { as: "human", text: `@${badSeat.name} 你会出错` } })
    const end4 = await settled(c4.data.message.id, badSeat.id)
    assert(end4?.state === "failed" && /故意出错|退出码/.test(end4.note || ""), `唤起出错该记成 failed 带原因，实际 ${end4?.state} ${end4?.note}`)
    const badRun = await request(`/api/v1/runs/${end4.runId}`)
    assert(
      badRun.status === 200 &&
        badRun.data.run?.state === "failed" &&
        badRun.data.run.steps.some((step) => step.state === "failed" && `${step.title} ${step.output ?? ""}`.includes("mock 故意出错")),
      `失败 run 的步骤必须在 endRun 后完整保留，实际 steps=${JSON.stringify(badRun.data.run?.steps)}`,
    )
    const badRoomMsgs = (await request(`/api/v1/room?project=${project}`)).data.messages.filter(
      (item) => item.seq > c4.data.message.seq && item.authorId === "room" && item.text.includes(badSeat.name) && item.text.includes("没成功"),
    )
    assert(
      badRoomMsgs.length === 1 &&
        badRoomMsgs[0].runId === end4.runId &&
        !badRoomMsgs[0].text.includes("（看过程）") &&
        badRoomMsgs[0].text.includes("mock 故意出错"),
      `系统报错消息应带可点 runId 且不被 30 字截断，实际 ${JSON.stringify(badRoomMsgs[0])}`,
    )
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
    assert(
      netSaid.length === 1 && netSaid[0].runId === net.call.runId && netSaid[0].text.includes("网络错误"),
      `都失败了只在群里报一次带 runId 的网络错误，实际 ${JSON.stringify(netSaid)}`,
    )
    const netRun = await request(`/api/v1/runs/${net.call.runId}`)
    assert(netRun.status === 200 && (netRun.data.run?.steps?.length ?? 0) > 0, "网络失败 run 的步骤记录必须保留")

    const badAgain = await request("/api/v1/say", { method: "POST", body: { as: "human", text: `@${badSeat.name} 不是网络的错` } })
    const bad = await watch(badAgain.data.message.id, badSeat.id, ["answered", "failed", "silent"], 15_000)
    assert(bad.call?.state === "failed" && !bad.seen.includes("retrying"), `非网络的错误不重试，实际 ${bad.seen.join(" → ")}`)

    // Insufficient balance / relay insufficient_quota JSON on stream-json (even exit 0):
    // must unwrap JSON, skip net retry, post LimitedCard(kind="balance"), and keep steps.
    const balSeat = await seatIn("去向欠费", mockBalanceName)
    const balSay = await request("/api/v1/say", { method: "POST", body: { as: "human", text: `@${balSeat.name} 余额测试` } })
    const balCall = await watch(balSay.data.message.id, balSeat.id, ["answered", "failed", "silent"], 15_000)
    assert(
      balCall.call?.state === "failed" && !balCall.seen.includes("retrying") && /余额不足/.test(balCall.call.note || ""),
      `余额不足报错应直接 failed 且注明余额不足，实际 ${balCall.seen.join(" → ")} ${balCall.call?.note}`,
    )
    const balSnap = await request(`/api/v1/room?project=${project}`)
    const balCard = balSnap.data.messages.find((m) => m.limited?.agentId === balSeat.id)
    assert(
      balCard?.limited?.kind === "balance" && balCard.limited.label === "余额不足" && balCard.limited.runId === balCall.call.runId,
      `余额不足应生成 kind=balance 的 LimitedCard，实际 ${JSON.stringify(balCard)}`,
    )
    const balRun = await request(`/api/v1/runs/${balCall.call.runId}`)
    assert(balRun.data.run?.steps?.some((s) => s.state === "failed"), "余额不足 run 必须保留失败步骤供查看过程")

    // Codex/Antigravity stream errors (`type: "error"` + `event: "error"` with EOF) even when CLI exits 0:
    // must not be mistaken for silent, must trigger net retry, and must keep stream-error steps.
    const snetSeat = await seatIn("去向流断", mockStreamNetName)
    const snetSay = await request("/api/v1/say", { method: "POST", body: { as: "human", text: `@${snetSeat.name} 流网络测试` } })
    const snet = await watch(snetSay.data.message.id, snetSeat.id, ["answered", "failed", "silent"])
    assert(
      snet.call?.state === "failed" &&
        snet.seen.includes("retrying") &&
        /网络错误/.test(snet.call.note || "") &&
        /自动重试了 2 次/.test(snet.call.note || ""),
      `流内 EOF 网络报错（即使退出码 0）应触发重试并记网络错误，实际 ${snet.seen.join(" → ")} ${snet.call?.note}`,
    )
    const snetRun = await request(`/api/v1/runs/${snet.call.runId}`)
    assert(
      snetRun.data.run?.steps?.some((s) => s.id === "stream-error" && s.state === "failed"),
      "流式报错应写入 stream-error 步骤并持久化",
    )

    // Antigravity "UNAVAILABLE (code 503): No capacity available for model ...":
    // must trigger net retry, translate explain/end steps & toast to Chinese,
    // and transition unrecovered "网络重连中：" steps to "网络重连未恢复：".
    const capSeat = await seatIn("去向满载", mockCapacityName)
    const capSay = await request("/api/v1/say", { method: "POST", body: { as: "human", text: `@${capSeat.name} 503容量测试` } })
    const cap = await watch(capSay.data.message.id, capSeat.id, ["answered", "failed", "silent"])
    assert(
      cap.call?.state === "failed" &&
        cap.seen.includes("retrying") &&
        /服务暂无容量（503，gemini-4-argon-high）/.test(cap.call.note || "") &&
        /自动重试了 2 次/.test(cap.call.note || ""),
      `503 模型暂无容量应触发重试并记中文提示，实际 ${cap.seen.join(" → ")} ${cap.call?.note}`,
    )
    const capSaid = await roomSays(capSay.data.message.seq, capSeat.name)
    assert(
      capSaid.length === 1 && capSaid[0].runId === cap.call.runId && capSaid[0].text.includes("服务暂无容量（503"),
      `503 容量不足在群里应只发一次带 runId 的中文提示，实际 ${JSON.stringify(capSaid)}`,
    )
    const capRun = await request(`/api/v1/runs/${cap.call.runId}`)
    const capSteps = capRun.data.run?.steps ?? []
    const capStreamSteps = capSteps.filter((s) => s.id === "stream-error")
    assert(
      capStreamSteps.length > 0 &&
        capStreamSteps.every((s) => s.state === "failed" && !s.title.startsWith("网络重连中：")) &&
        capStreamSteps.some((s) => s.title.startsWith("网络重连未恢复：")),
      `失败后的重连步骤应转为「网络重连未恢复：」而非继续显示「网络重连中：」，实际 ${JSON.stringify(capStreamSteps)}`,
    )
    const capExplain = capSteps.find((s) => s.id === "explain")
    assert(
      capExplain?.output?.includes("503") &&
        capExplain.output.includes("gemini-4-argon-high") &&
        capExplain.output.includes("暂无可用容量") &&
        capExplain.output.includes("原始报错："),
      `503 失败原因说明应给出中文排查建议与原始报错，实际 ${JSON.stringify(capExplain)}`,
    )
    const capEnd = capSteps.find((s) => s.id === "end")
    assert(
      capEnd?.title?.startsWith("没成功：服务暂无容量（503，gemini-4-argon-high）") && capEnd.output?.includes("No capacity available"),
      `结束步骤应显示中文摘要并在结果中保留原始报错，实际 ${JSON.stringify(capEnd)}`,
    )

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

    // Gists (Message.gist, t_83c6fcc9): an agent's reply gets its first line
    // when that is a conclusion; a long one that opens with structure gets
    // none, until the project's summary seat writes one; the user's messages
    // never have one. Start the room with BENCH_GIST_MS=500 to keep it short.
    const replyTo = async (messageId, seatId, limit = 15_000) => {
      const until = Date.now() + limit
      while (Date.now() < until) {
        const found = (await request(`/api/v1/room?project=${project}`)).data.messages.find(
          (item) => item.authorId === seatId && item.replyTo === messageId,
        )
        if (found) return found
        await new Promise((resolve) => setTimeout(resolve, 150))
      }
      return undefined
    }
    const gistOfMessage = async (messageId) => (await request(`/api/v1/room?project=${project}`)).data.messages.find((item) => item.id === messageId)?.gist
    const waitGist = async (messageId, limit) => {
      const until = Date.now() + limit
      while (Date.now() < until) {
        const gist = await gistOfMessage(messageId)
        if (gist) return gist
        await new Promise((resolve) => setTimeout(resolve, 200))
      }
      return undefined
    }
    const gistSeat = await seatIn("摘要甲", mockGistName)
    const headSeat = await seatIn("摘要乙", mockHeadName)
    const g1 = await request("/api/v1/say", { method: "POST", body: { as: "human", text: `@${gistSeat.name} 第一行写结论。${"人说的长话".repeat(60)}` } })
    assert(!g1.data.message.gist, "人的消息不该有 gist")
    const r1 = await replyTo(g1.data.message.id, gistSeat.id)
    assert(
      r1?.gist?.text === "做完了：第一行就是结论。" && r1.gist.by === "author",
      `第一行是短结论的回复，gist 就是它、by 是 author，实际 ${JSON.stringify(r1?.gist)}`,
    )
    const g2 = await request("/api/v1/say", { method: "POST", body: { as: "human", text: `@${headSeat.name} 先写标题` } })
    const r2 = await replyTo(g2.data.message.id, headSeat.id)
    assert(r2 && !r2.gist, `第一行是标题的长回复不该有 gist，实际 ${JSON.stringify(r2?.gist)}`)
    assert(!(await waitGist(r2.id, 2500)), "没设摘要席位时不该补")

    const gisterSeatMade = await seatIn("补摘要", mockGisterName)
    const setG = await request(`/api/v1/agents/${gisterSeatMade.id}`, { method: "POST", body: { as: "human", action: "gister", on: true } })
    assert(setG.status === 200, `设摘要席位失败 ${setG.data.error || setG.status}`)
    const roomG = await request(`/api/v1/room?project=${project}`)
    assert(roomG.data.agents.filter((a) => a.gister).map((a) => a.id).join() === gisterSeatMade.id, "一个项目只该有一个摘要席位")
    const g3 = await request("/api/v1/say", { method: "POST", body: { as: "human", text: `@${headSeat.name} 再来一条标题开头的` } })
    const r3 = await replyTo(g3.data.message.id, headSeat.id)
    const filled = await waitGist(r3.id, 20_000)
    assert(
      filled?.by === gisterSeatMade.name && filled.text === `补的摘要 谁 ${r3.id}`,
      `开了摘要席位后该被补上、by 是那个席位、去掉 @，实际 ${JSON.stringify(filled)}`,
    )
    const quiet = (await request(`/api/v1/room?project=${project}`)).data.messages.filter(
      (item) => item.seq > g3.data.message.seq && item.authorId === gisterSeatMade.id,
    )
    assert(quiet.length === 0, "摘要席位补摘要不该在群里发言")
    assert(r1.gist.by === "author" && (await gistOfMessage(r1.id))?.by === "author", "作者自己的 gist 不该被覆盖")

    const badGister = await seatIn("坏补摘要", mockGisterBadName)
    await request(`/api/v1/agents/${badGister.id}`, { method: "POST", body: { as: "human", action: "gister", on: true } })
    const g4 = await request("/api/v1/say", { method: "POST", body: { as: "human", text: `@${headSeat.name} 摘要席位会出错` } })
    const r4 = await replyTo(g4.data.message.id, headSeat.id)
    assert(!(await waitGist(r4.id, 5000)), "摘要席位失败时不该有 gist")
    const r4Now = (await request(`/api/v1/room?project=${project}`)).data.messages.find((item) => item.id === r4.id)
    assert(r4Now?.text === r4.text, "摘要席位失败不该动消息本身")
    const failNotes = (await request(`/api/v1/room?project=${project}`)).data.messages.filter(
      (item) => item.seq > g4.data.message.seq && item.authorId === "room" && item.text.includes(badGister.name),
    )
    assert(failNotes.length === 0, `摘要席位失败不在群里报错，实际 ${failNotes.map((item) => item.text).join(" / ")}`)
    await request(`/api/v1/agents/${badGister.id}`, { method: "POST", body: { as: "human", action: "gister", on: false } })

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
      passed.kind === undefined && passed.gaps === undefined,
      `复验未写类别、没验到的写「无」时都不该存进 Task.check，实际 ${JSON.stringify(passed)}`,
    )
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
    assert(!again.prev && !again.round, `打回后重新计数，不该带上一次的结论，实际 ${JSON.stringify(again)}`)
    // 没过 → 不打回、改好再请验收：重查（t_a58c8546），带上一次的结论；通过后再请不再查。
    const askWith = (seat, id, note) => request(`/api/v1/tasks/${id}`, { method: "POST", body: { agentId: seat.id, token: seat.token, action: "review", note } })
    const fixTask = await taskFor(doer, "【没过】要改的")
    await askReview(doer, fixTask)
    const fixFailed = await checked(fixTask)
    assert(fixFailed?.state === "failed", `先该没过，实际 ${JSON.stringify(fixFailed)}`)
    assert((await askWith(doer, fixTask, "【改好】按钮修好了，点一下就有反应")).status === 200, "再请验收失败")
    const fixAgain = await checked(fixTask)
    assert(
      fixAgain?.at !== fixFailed.at && fixAgain?.state === "passed" && fixAgain.round === 1 && fixAgain.prev?.state === "failed" && fixAgain.prev.note?.startsWith("按钮没反应"),
      `没过的改好再请验收该重查一遍并留上一次的结论，实际 ${JSON.stringify(fixAgain)}`,
    )
    const fixLane = (await request(`/api/v1/room?project=${project}`)).data.tasks.find((t) => t.id === fixTask)
    assert(fixLane.review?.state === "waiting", "重查通过也不该自动收下")
    await askWith(doer, fixTask, "【改好】再说一遍")
    await new Promise((resolve) => setTimeout(resolve, 500))
    assert((await checkOf(fixTask))?.at === fixAgain.at, "重查通过后再请验收，不该再查")
    // 最多重查两次，第三次再请保留现有结论。
    const stuckTask = await taskFor(doer, "【没过】改不好的")
    await askReview(doer, stuckTask)
    let stuck = await checked(stuckTask)
    for (const round of [1, 2]) {
      await askReview(doer, stuckTask)
      const next = await checked(stuckTask)
      assert(next?.at !== stuck.at && next?.state === "failed" && next.round === round, `第 ${round} 次重查该排上，实际 ${JSON.stringify(next)}`)
      stuck = next
    }
    await askReview(doer, stuckTask)
    await new Promise((resolve) => setTimeout(resolve, 500))
    const capped = await checkOf(stuckTask)
    assert(capped?.at === stuck.at && capped.round === 2, `重查两次后再请验收不该再查，实际 ${JSON.stringify(capped)}`)
    await request(`/api/v1/tasks/${stuckTask}`, { method: "POST", body: { as: "human", action: "reject", note: "再改" } })
    await askReview(doer, stuckTask)
    const reset = await checked(stuckTask)
    assert(reset?.at !== capped.at && !reset.round && !reset.prev, `打回后重新计数，实际 ${JSON.stringify(reset)}`)
    await askReview(doer, stuckTask)
    const resetAgain = await checked(stuckTask)
    assert(resetAgain?.round === 1, `打回后再没过，再请验收又能重查，实际 ${JSON.stringify(resetAgain)}`)
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

    // t_ab05661d: (1) check kind & gaps parsing, (2) single & batch re-check
    // without duplicate queueing, (3) auto-pick checker rules, and (4) compact
    // context every 5 consecutive checks on Claude/Codex seats.
    await asChecker(checkSeat, true)
    const runKindTask = await taskFor(doer, "【跑得出】逻辑修复")
    await askReview(doer, runKindTask)
    const runKindRes = await checked(runKindTask)
    assert(
      runKindRes?.state === "passed" && runKindRes.kind === "run" && runKindRes.gaps === undefined,
      `「类别：跑得出」+「没验到的：无」应存 kind=run 且不存 gaps，实际 ${JSON.stringify(runKindRes)}`,
    )

    const lookGapsTask = await taskFor(doer, "【要人看带漏验】排版微调")
    await askReview(doer, lookGapsTask)
    const lookGapsRes = await checked(lookGapsTask)
    assert(
      lookGapsRes?.state === "passed" && lookGapsRes.kind === "look" && lookGapsRes.gaps === "浅色窄屏排版未看",
      `「类别：要人看」与「没验到的：…」应准确存入 kind/gaps，实际 ${JSON.stringify(lookGapsRes)}`,
    )

    const youKindTask = await taskFor(doer, "【只能本人签】口令调整")
    await askReview(doer, youKindTask)
    const youKindRes = await checked(youKindTask)
    assert(
      youKindRes?.state === "passed" && youKindRes.kind === "you" && youKindRes.gaps === undefined,
      `「类别：只能本人签」应存 kind=you，实际 ${JSON.stringify(youKindRes)}`,
    )

    // Permission & state guards on manual re-check
    const agentRecheck = await request(`/api/v1/tasks/${afterOff}`, {
      method: "POST",
      body: { agentId: doer.id, token: doer.token, action: "check" },
    })
    assert(agentRecheck.status === 403, `普通席位不应能调单条补跑复验，实际 ${agentRecheck.status}`)
    const notWaitingTask = await taskFor(doer, "还没请验收")
    const prematureCheck = await request(`/api/v1/tasks/${notWaitingTask}`, {
      method: "POST",
      body: { as: "human", action: "check" },
    })
    assert(prematureCheck.status === 400, `未请验收的待办补跑复验应返回 400，实际 ${prematureCheck.status}`)

    // Single & batch re-check: must NOT re-queue a check already queued/running,
    // and batch re-check only queues tasks with no verdict (none / skipped / error).
    const slowCheckTask = await taskFor(doer, "【慢复验】防重复排")
    await askReview(doer, slowCheckTask)
    const slowInitial = await checkOf(slowCheckTask)
    assert(
      slowInitial && (slowInitial.state === "queued" || slowInitial.state === "running"),
      `慢复验刚触发应处于 queued 或 running，实际 ${JSON.stringify(slowInitial)}`,
    )
    const slowDupSingle = await request(`/api/v1/tasks/${slowCheckTask}`, {
      method: "POST",
      body: { as: "human", action: "check" },
    })
    const slowAfterSingle = await checkOf(slowCheckTask)
    assert(
      slowDupSingle.status === 200 && slowDupSingle.data.queued === false && slowAfterSingle?.at === slowInitial.at,
      `已在跑/排着的复验调单条补跑不应重复入队或覆盖 check.at，实际 queued=${slowDupSingle.data.queued} at=${slowAfterSingle?.at} vs ${slowInitial.at}`,
    )

    const batch1 = await request("/api/v1/check", {
      method: "POST",
      body: { as: "human", project },
    })
    assert(
      batch1.status === 200 &&
        batch1.data.queued >= 4 &&
        batch1.data.skipped.some((s) => s.taskId === ownTask && s.why.includes("负责人")),
      `整批补跑应排入无结论待办并把负责人自己的待办列入 skipped，实际 ${JSON.stringify(batch1.data)}`,
    )
    assert(
      (await checkOf(slowCheckTask))?.at === slowInitial.at && (await checkOf(passTask))?.at === passed.at,
      "整批补跑不应改动已在跑的待办和已有结论待办的 check.at",
    )

    // Immediate second batch call while those 4+ items are still queued behind slowCheckTask: 0 new queued!
    const batch2 = await request("/api/v1/check", {
      method: "POST",
      body: { as: "human", project },
    })
    assert(
      batch2.status === 200 && batch2.data.queued === 0,
      `排着的复验未跑完时再调整批补跑不应重复排入，实际 ${JSON.stringify(batch2.data)}`,
    )

    assert((await checked(slowCheckTask))?.state === "passed", "慢复验最终应通过")
    assert((await checked(offTask))?.state === "passed", "补跑的 offTask 应得出通过结论")
    assert((await checked(afterOff))?.state === "passed", "补跑的 afterOff 应得出通过结论")
    assert((await checked(badTask))?.state === "passed", "之前 error 的 badTask 补跑后应通过")
    await checked(junkTask)

    // Single manual re-check CAN re-run an already-settled waiting task with a fresh timestamp
    const rerunSettled = await request(`/api/v1/tasks/${passTask}`, {
      method: "POST",
      body: { as: "human", action: "check" },
    })
    assert(
      rerunSettled.status === 200 && rerunSettled.data.queued === true && rerunSettled.data.task.check.at > passed.at,
      "对已有结论的等验收待办手动单条补跑应更新 check.at 并重跑",
    )
    assert((await checked(passTask))?.state === "passed", "单条重跑应顺利完成")
    await asChecker(checkSeat, false)

    // Auto-pick checker (`ProjectInfo.check = "auto"`) in a clean temporary project
    let autoProjId = ""
    try {
      const mkAuto = await request("/api/v1/projects", {
        method: "POST",
        body: { as: "human", name: `自动挑_${stamp}` },
      })
      assert(mkAuto.status === 201, `建自动挑测试项目失败 ${mkAuto.status}`)
      autoProjId = mkAuto.data.project.id

      const joinInAuto = async (name, agentName, uuidTag) => {
        const res = await request("/api/v1/join", {
          method: "POST",
          body: { project: autoProjId, name, model: "m-1", role: "测", agentName, uuid: `${uuidTag}-${stamp}` },
        })
        assert(res.status === 200 || res.status === 201, `入座自动挑项目失败 ${name}: ${res.status} ${JSON.stringify(res.data)}`)
        return { id: res.data.agent.id, name: res.data.agent.name, token: res.data.token }
      }
      const autoTask = async (seat, title) => {
        const created = await request("/api/v1/tasks", {
          method: "POST",
          body: { project: autoProjId, agentId: seat.id, token: seat.token, title, owner: seat.name, steps: ["做", "验收"] },
        })
        const tid = created.data.task.id
        await request(`/api/v1/tasks/${tid}`, {
          method: "POST",
          body: { project: autoProjId, agentId: seat.id, token: seat.token, action: "step", step: 1, state: "done" },
        })
        await request(`/api/v1/tasks/${tid}`, {
          method: "POST",
          body: { project: autoProjId, agentId: seat.id, token: seat.token, action: "review", note: "请验" },
        })
        return tid
      }
      const autoCheckOf = async (tid) =>
        (await request(`/api/v1/room?project=${autoProjId}`)).data.tasks.find((t) => t.id === tid)?.check
      const waitAutoCheck = async (tid) => {
        for (let i = 0; i < 80; i++) {
          const chk = await autoCheckOf(tid)
          if (chk && !["queued", "running"].includes(chk.state)) return chk
          await new Promise((r) => setTimeout(r, 150))
        }
        return autoCheckOf(tid)
      }

      const autoOwner = await joinInAuto("干活甲", mockCheckName, "ao1")
      // Mutual exclusion between fixed seat checker and check: "auto"
      await request(`/api/v1/agents/${autoOwner.id}`, {
        method: "POST",
        body: { project: autoProjId, as: "human", action: "checker", on: true },
      })
      const setAutoRes = await request(`/api/v1/projects/${autoProjId}`, {
        method: "POST",
        body: { as: "human", action: "update", name: `自动挑_${stamp}`, check: "auto" },
      })
      const snapAuto1 = await request(`/api/v1/room?project=${autoProjId}`)
      assert(
        setAutoRes.data.project.check === "auto" &&
          snapAuto1.data.project.check === "auto" &&
          !snapAuto1.data.agents.some((a) => a.checker),
        "开启项目 check='auto' 应清除原有的指定复验席位",
      )
      await request(`/api/v1/agents/${autoOwner.id}`, {
        method: "POST",
        body: { project: autoProjId, as: "human", action: "checker", on: true },
      })
      const snapAuto2 = await request(`/api/v1/room?project=${autoProjId}`)
      assert(!snapAuto2.data.project.check, "指定具体复验席位后应自动清掉项目的 check='auto'")
      await request(`/api/v1/projects/${autoProjId}`, {
        method: "POST",
        body: { as: "human", action: "update", name: `自动挑_${stamp}`, check: "auto" },
      })

      // 1) Never pick the task's own owner
      const soloTid = await autoTask(autoOwner, "只有负责人自己")
      const soloChk = await autoCheckOf(soloTid)
      assert(
        soloChk?.state === "skipped" && !soloChk.by,
        `自动挑绝不能挑待办负责人自己，应记 skipped，实际 ${JSON.stringify(soloChk)}`,
      )

      // 2) Never pick a client currently blocked by usage limits
      const limPeer = await joinInAuto("限额席", mockLimitName, "lim1")
      await request("/api/v1/say", {
        method: "POST",
        body: { project: autoProjId, as: "human", text: `@${limPeer.name} 触发限额` },
      })
      for (let i = 0; i < 60; i++) {
        const snapLim = await request(`/api/v1/room?project=${autoProjId}`)
        if (snapLim.data.messages.some((m) => m.limited?.agentId === limPeer.id)) break
        await new Promise((r) => setTimeout(r, 100))
      }
      const limSkipTid = await autoTask(autoOwner, "限额客户端不挑")
      const limSkipChk = await autoCheckOf(limSkipTid)
      assert(
        limSkipChk?.state === "skipped" && limSkipChk.note?.includes("限额"),
        `正被限额拦着的客户端不应被自动挑中，实际 ${JSON.stringify(limSkipChk)}`,
      )

      // 3) Same-client vs different-client: even when same-client seat is quieter for longer,
      //    must pick the different-client seat; among idle different-client seats, pick the quietest;
      //    when one is running, pick the idle one!
      const sameClientPeer = await joinInAuto("同家老席", mockCheckName, "same1")
      void sameClientPeer
      await new Promise((r) => setTimeout(r, 30))
      const diffOldPeer = await joinInAuto("异家久闲", mockCheckAltName, "diff1")
      await new Promise((r) => setTimeout(r, 30))
      const diffNewPeer = await joinInAuto("异家新动", mockCheckAltName, "diff2")

      const diffPickTid = await autoTask(autoOwner, "【慢复验】优先挑不同家且最久没动")
      const diffPickInitial = await autoCheckOf(diffPickTid)
      assert(
        diffPickInitial?.by === diffOldPeer.id,
        `同家与不同家都在时应优先挑不同家，且挑最久没动的异家久闲（${diffOldPeer.name}），实际挑了 ${diffPickInitial?.name}`,
      )

      // While diffOldPeer is still running that 900ms check, ask another review: must pick idle diffNewPeer!
      const idlePickTid = await autoTask(autoOwner, "优先挑没在跑的异家席")
      const idlePickChk = await waitAutoCheck(idlePickTid)
      assert(
        idlePickChk?.by === diffNewPeer.id && idlePickChk?.state === "passed",
        `异家久闲正在跑复验时应挑没在跑的异家新动（${diffNewPeer.name}），实际挑了 ${idlePickChk?.name}`,
      )
      assert((await waitAutoCheck(diffPickTid))?.state === "passed", "异家久闲的慢复验应完成")

      // 4) Peers first (t_50597554): a seat that has had a to-do of its own in this project is
      //    picked before seats that never have, even ones on a different client.
      const peerOwnTid = await autoTask(sameClientPeer, "同家老席自己的活")
      const peerOwnChk = await waitAutoCheck(peerOwnTid)
      assert(
        peerOwnChk?.by === autoOwner.id && peerOwnChk?.state === "passed",
        `复验人应先从在项目里干过活的席位里挑（${autoOwner.name}），实际挑了 ${peerOwnChk?.name}（${JSON.stringify(peerOwnChk)}）`,
      )
      const peerPickTid = await autoTask(autoOwner, "干过活的同家席优先于没干过活的异家席")
      const peerPickChk = await waitAutoCheck(peerPickTid)
      assert(
        peerPickChk?.by === sameClientPeer.id && peerPickChk?.state === "passed",
        `干过活的同家席应优先于没干过活的异家席，实际挑了 ${peerPickChk?.name}`,
      )

      // 5) A seat whose check could not run is left alone for a while: the next one goes to another.
      const badPeer = await joinInAuto("坏复验", mockBadName, "bad1")
      await waitAutoCheck(await autoTask(badPeer, "坏席自己的活"))
      const failTid = await autoTask(autoOwner, "先落到会出错的席位上")
      const failChk = await waitAutoCheck(failTid)
      assert(
        failChk?.by === badPeer.id && failChk?.state === "error" && failChk.note?.includes("复验没跑成"),
        `干过活的异家席（会出错）应先被挑中并记没跑成，实际 ${JSON.stringify(failChk)}`,
      )
      const afterFailTid = await autoTask(autoOwner, "刚没跑成的席位不再挑")
      const afterFailChk = await waitAutoCheck(afterFailTid)
      assert(
        afterFailChk?.by === sameClientPeer.id && afterFailChk?.state === "passed",
        `刚才复验没跑成的席位这次不应再被挑中，实际挑了 ${afterFailChk?.name}（${JSON.stringify(afterFailChk)}）`,
      )

      // 6) 「查过没问题的，自动替我收下」 (t_491538da): with the room's switch on,
      //    a check that passes as 跑得出 lets the room pass the to-do itself;
      //    one the user has to look at stays waiting.
      try {
        const autoOn = await request("/api/v1/deputy", { method: "POST", body: { as: "human", action: "auto", on: true } })
        assert(autoOn.status === 200 && autoOn.data.on === true, `打开「自动收下」失败 ${autoOn.status} ${autoOn.data.error || ""}`)
        await new Promise((r) => setTimeout(r, 5))
        const taskNow = async (tid) => (await request(`/api/v1/room?project=${autoProjId}`)).data.tasks.find((t) => t.id === tid)
        const autoRunTid = await autoTask(autoOwner, "【跑得出】自动收下")
        let autoRun = null
        for (let i = 0; i < 80; i++) {
          autoRun = await taskNow(autoRunTid)
          if (autoRun?.review?.state === "passed") break
          await new Promise((r) => setTimeout(r, 150))
        }
        assert(
          autoRun?.review?.state === "passed" && autoRun.review.deputy?.seatId === "room" && autoRun.status === "done",
          `开关开着、复验跑得出：房间该自己收下，实际 ${JSON.stringify(autoRun?.review)} ${JSON.stringify(autoRun?.check)}`,
        )
        const lookTid = await autoTask(autoOwner, "【要人看带漏验】不自动收")
        const lookChk = await waitAutoCheck(lookTid)
        await new Promise((r) => setTimeout(r, 200))
        const look = await taskNow(lookTid)
        assert(lookChk?.state === "passed" && look?.review?.state === "waiting", `要人看的复验通过了也不该自动收，实际 ${JSON.stringify(look?.review)}`)
      } finally {
        await request("/api/v1/deputy", { method: "POST", body: { as: "human", action: "auto", on: false } })
      }
    } finally {
      if (autoProjId) {
        await request(`/api/v1/projects/${autoProjId}`, {
          method: "POST",
          body: { as: "human", action: "delete", confirm: "删除" },
        }).catch(() => {})
      }
    }

    // Compact context every 5 consecutive checks on a Claude/Codex checker seat
    let compactProjId = ""
    const compactLogFile = pathMod.join(osMod.tmpdir(), `bench-check-compact-${stamp}.log`)
    try {
      const preAdapters = (await request("/api/v1/adapters")).data.agents.map(({ name, command, reply }) => ({ name, command, reply }))
      const fakeClaudeCheckCmd = `node -e "const fs = require('fs'); const t = process.argv[2] || ''; if (t.trim() === '/compact') { fs.appendFileSync('${compactLogFile.replaceAll("\\", "/")}', 'compact\\n'); console.log('Compacted'); } else { console.log('复验结论：通过\\n类别：跑得出\\n通过\\n没验到的：无'); }" {uuid} {text}`
      const patchedAdapters = [
        ...preAdapters.filter((a) => a.name !== "claude"),
        { name: "claude", command: fakeClaudeCheckCmd, reply: "stdout" },
      ]
      await request("/api/v1/adapters", { method: "POST", body: { as: "human", agents: patchedAdapters } })
      try {
        const mkComp = await request("/api/v1/projects", {
          method: "POST",
          body: { as: "human", name: `复验压缩_${stamp}` },
        })
        compactProjId = mkComp.data.project.id
        const cOwnerRes = await request("/api/v1/join", {
          method: "POST",
          body: { project: compactProjId, name: "压缩做事", model: "m", role: "做", agentName: mockMuteName, uuid: `co-${stamp}` },
        })
        const cCheckerRes = await request("/api/v1/join", {
          method: "POST",
          body: { project: compactProjId, name: "Claude复验", model: "claude-sonnet", role: "验", agentName: "claude", uuid: `cc-${stamp}` },
        })
        const cOwner = { id: cOwnerRes.data.agent.id, name: cOwnerRes.data.agent.name, token: cOwnerRes.data.token }
        const cCheckerId = cCheckerRes.data.agent.id
        await request(`/api/v1/agents/${cCheckerId}`, {
          method: "POST",
          body: { project: compactProjId, as: "human", action: "checker", on: true },
        })

        for (let k = 1; k <= 5; k++) {
          const ct = await request("/api/v1/tasks", {
            method: "POST",
            body: { project: compactProjId, agentId: cOwner.id, token: cOwner.token, title: `连验第${k}条`, owner: cOwner.name, steps: ["做", "验收"] },
          })
          const ctid = ct.data.task.id
          await request(`/api/v1/tasks/${ctid}`, {
            method: "POST",
            body: { project: compactProjId, agentId: cOwner.id, token: cOwner.token, action: "step", step: 1, state: "done" },
          })
          await request(`/api/v1/tasks/${ctid}`, {
            method: "POST",
            body: { project: compactProjId, agentId: cOwner.id, token: cOwner.token, action: "review", note: "验" },
          })
          for (let w = 0; w < 60; w++) {
            const chk = (await request(`/api/v1/room?project=${compactProjId}`)).data.tasks.find((t) => t.id === ctid)?.check
            if (chk && !["queued", "running"].includes(chk.state)) break
            await new Promise((r) => setTimeout(r, 100))
          }
          if (k === 4) {
            const fsTmp = await import("node:fs")
            assert(!fsTmp.existsSync(compactLogFile), "连着复验不到 5 条时不应提前触发压缩")
          }
        }
        const fsTmp = await import("node:fs")
        for (let w = 0; w < 40; w++) {
          if (fsTmp.existsSync(compactLogFile)) break
          await new Promise((r) => setTimeout(r, 100))
        }
        assert(
          fsTmp.existsSync(compactLogFile) && fsTmp.readFileSync(compactLogFile, "utf8").trim() === "compact",
          "Claude/Codex 席位连着复验满 5 条后应自动触发一次上下文压缩",
        )
      } finally {
        await request("/api/v1/adapters", { method: "POST", body: { as: "human", agents: preAdapters } }).catch(() => {})
      }
    } finally {
      ;(await import("node:fs")).rmSync(compactLogFile, { force: true })
      if (compactProjId) {
        await request(`/api/v1/projects/${compactProjId}`, {
          method: "POST",
          body: { as: "human", action: "delete", confirm: "删除" },
        }).catch(() => {})
      }
    }

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
    // Then the room takes them up by itself, one seat at a time (here 0.4s
    // after the start, 1.5s apart; really 60s and 30s). A pause the user made,
    // or one left from an earlier restart, stays.
    const { execFileSync } = await import("node:child_process")
    const { mkdtempSync } = await import("node:fs")
    const restartDir = mkdtempSync(pathMod.join(osMod.tmpdir(), "bench-restart-"))
    try {
      const loaderCode = `
        import { registerHooks } from "node:module";
        import { existsSync } from "node:fs";
        import path from "node:path";
        import { pathToFileURL } from "node:url";
        const root = process.cwd();
        registerHooks({
          resolve(specifier, context, nextResolve) {
            if (specifier.startsWith("@/")) {
              const target = path.join(root, specifier.slice(2));
              const file = existsSync(target + ".ts") ? target + ".ts" : target;
              return nextResolve(pathToFileURL(file).href, context);
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
            const qJoined = join({ name: "重启排队席", model: "mock-1", role: "测试", agentName: ${JSON.stringify(mockReliefName)}, uuid: "sess-restart-q" });
            const rJoined = join({ name: "重启打断席", model: "mock-1", role: "测试", agentName: ${JSON.stringify(mockReliefName)}, uuid: "sess-restart-r" });
            const uJoined = join({ name: "重启前手停席", model: "mock-1", role: "测试", agentName: ${JSON.stringify(mockReliefName)}, uuid: "sess-restart-u" });
            const oJoined = join({ name: "上次重启停席", model: "mock-1", role: "测试", agentName: ${JSON.stringify(mockReliefName)}, uuid: "sess-restart-o" });
            const pJoined = join({ name: "手停又在跑席", model: "mock-1", role: "测试", agentName: ${JSON.stringify(mockReliefName)}, uuid: "sess-restart-p" });
            const mP = say({ as: "human", text: "@手停又在跑席 跑着时被我暂停" }).message;
            dbSaveLane(pJoined.agent.id, projId, { paused: true, pending: [], hops: 0 });
            const pausedRun = startRun(pJoined.agent.id, "手停又在跑席", "reply", { project: projId, body: "用户：@手停又在跑席 跑着时被我暂停", replyTo: mP.id });
            markCalls([mP.id], pJoined.agent.id, "started", { runId: pausedRun.id });
            const mU = say({ as: "human", text: "@重启前手停席 我先暂停了" }).message;
            const mO = say({ as: "human", text: "@上次重启停席 上次重启就停着" }).message;
            markCalls([mU.id], uJoined.agent.id, "queued");
            markCalls([mO.id], oJoined.agent.id, "queued");
            dbSaveLane(uJoined.agent.id, projId, { paused: true, pending: [{ id: mU.id, line: "用户：@重启前手停席 我先暂停了" }], hops: 0 });
            dbSaveLane(oJoined.agent.id, projId, { paused: true, restartPaused: true, pending: [{ id: mO.id, line: "用户：@上次重启停席 上次重启就停着" }], hops: 0 });
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
            console.log(JSON.stringify({ projId, qId, rId, uId: uJoined.agent.id, oId: oJoined.agent.id, pId: pJoined.agent.id, pausedRunId: pausedRun.id, mQId: mQ.id, mRId: mR.id, deadRunId: deadRun.id }));
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
          const started = Date.now();
          ensureSummon();
          // Copied now: the room keeps changing these objects as it resumes.
          const snap = JSON.parse(JSON.stringify(inProject(${JSON.stringify(pre.projId)}, () => snapshot())));
          const dead = JSON.parse(JSON.stringify(getRun(${JSON.stringify(pre.deadRunId)})));
          const answeredAt = {};
          const stateOf = (s, messageId, seatId) => s.messages.find((m) => m.id === messageId)?.calls?.find((c) => c.id === seatId)?.state;
          let late = snap;
          while (Date.now() - started < 8000 && Object.keys(answeredAt).length < 2) {
            await new Promise((r) => setTimeout(r, 50));
            late = inProject(${JSON.stringify(pre.projId)}, () => snapshot());
            for (const [seat, messageId] of [[${JSON.stringify(pre.rId)}, ${JSON.stringify(pre.mRId)}], [${JSON.stringify(pre.qId)}, ${JSON.stringify(pre.mQId)}]]) {
              if (!answeredAt[seat] && stateOf(late, messageId, seat) === "answered") answeredAt[seat] = Date.now() - started;
            }
          }
          const pausedRun = getRun(${JSON.stringify(pre.pausedRunId)});
          console.log(JSON.stringify({ snap, dead, answeredAt, late, pausedRun }));
          process.exit(0);
          `,
        ],
        {
          env: { ...process.env, BENCH_DATA_DIR: restartDir, BENCH_RESTART_RESUME_MS: "400", BENCH_RESTART_RESUME_GAP_MS: "1500" },
          encoding: "utf8",
        },
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
      assert(interruptedMsg.text.includes("稍后自动接上"), `重启通知应说房间会自己接上：${interruptedMsg.text}`)
      const tR = post.answeredAt[pre.rId]
      const tQ = post.answeredAt[pre.qId]
      assert(tR >= 400 && tQ >= 400, `重启后应先等一会儿再接上，不是一启动就叫：${JSON.stringify(post.answeredAt)}`)
      assert(tR && tQ && tQ - tR >= 1000, `重启后应一个一个接上（被打断的先、排队的隔一段再接）：${JSON.stringify(post.answeredAt)}`)
      // Paused by the user while a wake was running: the wake is cut, but it
      // stays for the user's 「重新叫醒」, and so does the pause.
      const pSeat = post.late.agents.find((a) => a.id === pre.pId)
      assert(
        !post.pausedRun?.resumedAt && pSeat?.queuePaused === true,
        `用户暂停着、又有一轮在跑的席位，重启后不该被自动叫回、暂停也不该解开：${JSON.stringify({ resumedAt: post.pausedRun?.resumedAt, paused: pSeat?.queuePaused })}`,
      )
      for (const id of [pre.uId, pre.oId]) {
        const seat = post.late.agents.find((a) => a.id === id)
        assert(
          seat?.queuePaused === true && seat?.queuedCount === 1,
          `重启前就暂停着的（用户停的、上次重启没接的）不该被自动接上：${seat?.name} ${JSON.stringify({ paused: seat?.queuePaused, n: seat?.queuedCount })}`,
        )
      }
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
      if (process.platform !== "win32") {
        assert(pushMode === 0o600, `data/push.json 权限必须是 0600，实际 0${pushMode.toString(8)}`)
      }
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

  // ---- Reception project (「前台」) & cross-project read-only tools (t_d2b37871) ----
  {
    const fsFront = await import("node:fs")
    const osFront = await import("node:os")
    const pathFront = await import("node:path")
    const { spawn: spawnFront } = await import("node:child_process")

    const frontReq = async (pathname, { method = "GET", proj = "", body, key = humanKey } = {}) => {
      const url = proj ? `${origin}${pathname}${pathname.includes("?") ? "&" : "?"}project=${encodeURIComponent(proj)}` : `${origin}${pathname}`
      const headers = {}
      if (body !== undefined) headers["content-type"] = "application/json"
      if (key && body && body.as === "human") headers["x-bench-human"] = key
      const res = await fetch(url, {
        method,
        headers: Object.keys(headers).length ? headers : undefined,
        body: body !== undefined ? JSON.stringify(proj ? { project: proj, ...body } : body) : undefined,
      })
      const raw = await res.text()
      let data = {}
      try {
        data = JSON.parse(raw)
      } catch {}
      return { status: res.status, data, raw }
    }

    const sleepFront = (ms) => new Promise((r) => setTimeout(r, ms))
    const mcpStateRoot = fsFront.mkdtempSync(pathFront.join(osFront.tmpdir(), `bench-front-mcp-${stamp}-`))
    const wakeOutFile = pathFront.join(mcpStateRoot, "front-wake-prompt.txt")
    const mockFailKind = `mockffail_${stamp}`
    const mockFrontKind = `mockfbot_${stamp}`
    const agentsJsonPath = `${process.cwd()}/agents.json`
    const hadAgentsBefore = fsFront.existsSync(agentsJsonPath)
    const savedAgentsRaw = hadAgentsBefore ? fsFront.readFileSync(agentsJsonPath, "utf8") : null

    const beforeProjectsRes = await frontReq("/api/v1/projects")
    assert(beforeProjectsRes.status === 200, "读取初始项目列表失败")
    const existingFront = beforeProjectsRes.data.projects.find((p) => p.front === true)
    let createdFrontId = ""
    let bizProjectId = ""
    let pendingPermitPromise = null
    let cleanBaseAdapters = null
    const mcpProcs = []
    const mockFailScript = pathFront.join(mcpStateRoot, "mock-fail-wake.mjs")
    const mockFrontScript = pathFront.join(mcpStateRoot, "mock-front-wake.mjs")
    fsFront.writeFileSync(
      mockFailScript,
      `process.stderr.write(${JSON.stringify(`模拟点名唤起报错_${stamp}`)})\nprocess.exit(2)\n`,
      "utf8",
    )
    fsFront.writeFileSync(
      mockFrontScript,
      `import { writeFileSync } from "node:fs"\nwriteFileSync(${JSON.stringify(wakeOutFile)}, process.argv[3] || "", "utf8")\nconsole.log(${JSON.stringify(`【本轮结束】前台已收到指令_${stamp}`)})\n`,
      "utf8",
    )

    const startMcpClient = (uuidTag) => {
      const child = spawnFront(process.execPath, ["scripts/bench-mcp.mjs", "--agent", "claude"], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          BENCH_URL: origin,
          XDG_STATE_HOME: mcpStateRoot,
          CLAUDE_CODE_SESSION_ID: uuidTag,
        },
        stdio: ["pipe", "pipe", "pipe"],
      })
      mcpProcs.push(child)
      let seqId = 1
      const pending = new Map()
      let buf = ""
      child.stdout.on("data", (chunk) => {
        buf += chunk.toString("utf8")
        let idx
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx).trim()
          buf = buf.slice(idx + 1)
          if (!line) continue
          try {
            const msg = JSON.parse(line)
            if (msg.id !== undefined && pending.has(msg.id)) {
              const resolve = pending.get(msg.id)
              pending.delete(msg.id)
              resolve(msg)
            }
          } catch {}
        }
      })
      const rpc = (method, params = {}) =>
        new Promise((resolve, reject) => {
          const id = seqId++
          const timer = setTimeout(() => {
            pending.delete(id)
            reject(new Error(`MCP ${method} 超时`))
          }, 15_000)
          pending.set(id, (msg) => {
            clearTimeout(timer)
            resolve(msg)
          })
          child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`)
        })
      return { child, rpc }
    }

    try {
      // 1) Ordinary project cannot take reserved name 「前台」 or set front: true via update
      const badPlainFront = await frontReq("/api/v1/projects", {
        method: "POST",
        body: { as: "human", name: "前台" },
      })
      assert(badPlainFront.status === 400, `普通新建项目起名「前台」应返回 400，实际 ${badPlainFront.status}`)

      const badPatchFront = await frontReq(`/api/v1/projects/${project}`, {
        method: "POST",
        body: { as: "human", front: true },
      })
      assert(badPatchFront.status === 400, `普通项目改成 front: true 应返回 400，实际 ${badPatchFront.status}`)

      // 2) Create / get single reception project (idempotent, pinned at index 0)
      const f1 = await frontReq("/api/v1/projects", {
        method: "POST",
        body: { as: "human", front: true },
      })
      assert(
        (existingFront ? f1.status === 200 : f1.status === 201) &&
          f1.data.project?.name === "前台" &&
          f1.data.project?.front === true,
        `开启前台失败：${f1.status} ${f1.raw}`,
      )
      const frontId = f1.data.project.id
      if (!existingFront) createdFrontId = frontId

      const f2 = await frontReq("/api/v1/projects", {
        method: "POST",
        body: { as: "human", front: true },
      })
      assert(
        f2.status === 200 && f2.data.project?.id === frontId && f2.data.project?.front === true,
        `重复请求 front: true 应幂等返回同一个前台项目，实际 ${f2.status} ${f2.raw}`,
      )

      const renameFrontAttempt = await frontReq(`/api/v1/projects/${frontId}`, {
        method: "POST",
        body: { as: "human", name: "别的名字" },
      })
      assert(renameFrontAttempt.status === 400, `前台改名应返回 400，实际 ${renameFrontAttempt.status}`)

      const listedAfterFront = await frontReq("/api/v1/projects")
      assert(
        listedAfterFront.data.projects[0]?.id === frontId &&
          listedAfterFront.data.projects[0]?.front === true &&
          listedAfterFront.data.projects.filter((p) => p.front === true).length === 1,
        "GET /api/v1/projects 必须把唯一的前台项目排在第 0 项且带 front: true",
      )

      // 3) Register temporary mock adapters for failed call & reception wake prompt capture
      const curAdapters = await frontReq("/api/v1/adapters")
      assert(curAdapters.status === 200, "读取 adapters 失败")
      cleanBaseAdapters = curAdapters.data.agents.map(({ name, command, reply }) => ({ name, command, reply }))
      const saveAdaptersRes = await frontReq("/api/v1/adapters", {
        method: "POST",
        body: {
          as: "human",
          agents: [
            ...cleanBaseAdapters,
            {
              name: mockFailKind,
              command: `node '${mockFailScript}' {uuid} {text}`,
              reply: "stdout",
            },
            {
              name: mockFrontKind,
              command: `node '${mockFrontScript}' {uuid} {text}`,
              reply: "stdout",
            },
          ],
        },
      })
      assert(saveAdaptersRes.status === 200, `保存前台测试适配器失败 ${saveAdaptersRes.raw}`)

      // 4) Build a realistic business project with >4 seats, summary, tasks, open ask, pending permit, failed call, recalled msg, and >30 chat lines
      const bizDir = fsFront.mkdtempSync(pathFront.join(osFront.tmpdir(), `bench-biz-dir-${stamp}-`))
      const mkBiz = await frontReq("/api/v1/projects", {
        method: "POST",
        body: { as: "human", name: `业务房${stamp}`, dir: bizDir },
      })
      assert(mkBiz.status === 201, `建业务项目失败 ${mkBiz.raw}`)
      bizProjectId = mkBiz.data.project.id
      const bizName = mkBiz.data.project.name

      // Re-verify reception stays at index 0 even after creating another project
      const listedWithBiz = await frontReq("/api/v1/projects")
      assert(listedWithBiz.data.projects[0]?.id === frontId, "新建普通项目后前台仍须排在第 0 项")

      const joinBizSeat = async (name, extra = {}) => {
        const res = await frontReq("/api/v1/join", {
          method: "POST",
          proj: bizProjectId,
          body: { name, model: "mock-model", role: "开发", ...extra },
        })
        assert(res.status === 201, `业务席位 ${name} 入座失败 ${res.raw}`)
        return { id: res.data.agent.id, name: res.data.agent.name, token: res.data.token }
      }

      const secretSessionUuid = `sess_secret_${stamp}_xyz987`
      const bizWorker = await joinBizSeat("工匠", { agentName: "claude", uuid: secretSessionUuid })
      const bizAsker = await joinBizSeat("提问员")
      const bizOweSeat = await joinBizSeat("欠活员", { agentName: mockFailKind, uuid: `fail_${stamp}` })
      const bizQuiet1 = await joinBizSeat("闲甲")
      const bizQuiet2 = await joinBizSeat("闲乙")
      const bizQuiet3 = await joinBizSeat("闲丙")
      void bizQuiet1
      void bizQuiet2
      void bizQuiet3

      await frontReq("/api/v1/pulse", {
        method: "POST",
        proj: bizProjectId,
        body: { agentId: bizWorker.id, token: bizWorker.token, status: "working", doing: "正在重构结算管线" },
      })

      // Room summary (>300 chars so overview clips head while peek shows full text)
      const fullSummaryText = `【摘要头_${stamp}】` + "这是业务房间阶段进展摘要正文，记录架构与接口决策。".repeat(12) + `【摘要尾_${stamp}】`
      const sumRes = await frontReq("/api/v1/summary", {
        method: "POST",
        proj: bizProjectId,
        body: { agentId: bizWorker.id, token: bizWorker.token, action: "write", text: fullSummaryText },
      })
      assert(sumRes.status === 200, `写摘要失败 ${sumRes.raw}`)

      // Tasks: one waiting for review, one owed by quiet seat
      const tReviewRes = await frontReq("/api/v1/tasks", {
        method: "POST",
        proj: bizProjectId,
        body: {
          agentId: bizWorker.id,
          token: bizWorker.token,
          title: `结算对账单_${stamp}`,
          owner: bizWorker.name,
          steps: ["核对流水", "请用户验收"],
        },
      })
      assert(tReviewRes.status === 201, "建待验收任务失败")
      const tReviewId = tReviewRes.data.task.id
      await frontReq(`/api/v1/tasks/${tReviewId}`, {
        method: "POST",
        proj: bizProjectId,
        body: { agentId: bizWorker.id, token: bizWorker.token, action: "step", step: 1, state: "done", note: "对账完毕" },
      })
      await frontReq(`/api/v1/tasks/${tReviewId}`, {
        method: "POST",
        proj: bizProjectId,
        body: { agentId: bizWorker.id, token: bizWorker.token, action: "review", note: "报表已生成，请核验导出结果" },
      })

      const tOwedRes = await frontReq("/api/v1/tasks", {
        method: "POST",
        proj: bizProjectId,
        body: {
          as: "human",
          title: `补齐回滚脚本_${stamp}`,
          owner: bizOweSeat.name,
          steps: ["编写回滚脚本", "本地演练"],
        },
      })
      assert(tOwedRes.status === 201, "建欠活任务失败")
      const tOwedId = tOwedRes.data.task.id

      // Trigger a failed @ call on bizOweSeat
      const callFailMsg = await frontReq("/api/v1/say", {
        method: "POST",
        proj: bizProjectId,
        body: { as: "human", text: `@${bizOweSeat.name} 请把回滚脚本交上来` },
      })
      assert(callFailMsg.status === 200, "发送点名消息失败")
      const callFailMsgId = callFailMsg.data.message.id
      for (let i = 0; i < 30; i++) {
        const snap = await frontReq("/api/v1/room", { proj: bizProjectId })
        const msg = snap.data.messages.find((m) => m.id === callFailMsgId)
        if (msg?.calls?.some((c) => c.state === "failed")) break
        await sleepFront(150)
      }

      // Open bench_ask with options
      const askRes = await frontReq("/api/v1/ask", {
        method: "POST",
        proj: bizProjectId,
        body: {
          agentId: bizAsker.id,
          token: bizAsker.token,
          action: "ask",
          text: `导出格式用 CSV 还是 Parquet_${stamp}？`,
          options: [
            { label: "CSV", detail: "兼容表格直接打开" },
            { label: "Parquet", detail: "列式压缩体积小" },
          ],
        },
      })
      assert(askRes.status === 200, `发起提问失败 ${askRes.raw}`)
      const openAskId = askRes.data.message.id

      // Pending permit request
      pendingPermitPromise = frontReq("/api/v1/permit", {
        method: "POST",
        proj: bizProjectId,
        key: "",
        body: {
          agentId: bizWorker.id,
          token: bizWorker.token,
          action: "tool",
          tool: "Bash",
          input: { command: `pg_dump --schema-only db_${stamp}` },
        },
      })
      let pendingPermitId = ""
      for (let i = 0; i < 20; i++) {
        const snap = await frontReq("/api/v1/room", { proj: bizProjectId })
        if (snap.data.permits?.length > 0) {
          pendingPermitId = snap.data.permits[0].id
          break
        }
        await sleepFront(100)
      }
      assert(Boolean(pendingPermitId), "业务项目应有一条挂起的权限请求")

      // Post & immediately recall a sensitive message (must NEVER appear in overview/peek)
      const recalledSecret = `绝密撤回口令_${stamp}_DO_NOT_SHOW`
      const toRecall = await frontReq("/api/v1/say", {
        method: "POST",
        proj: bizProjectId,
        body: { as: "human", text: recalledSecret },
      })
      const recallDone = await frontReq("/api/v1/recall", {
        method: "POST",
        proj: bizProjectId,
        body: { as: "human", id: toRecall.data.message.id },
      })
      assert(recallDone.status === 200, "撤回消息失败")

      // Post 33 talk lines so peek's 30-message window + `before` pagination can be verified
      for (let i = 1; i <= 31; i++) {
        await frontReq("/api/v1/say", {
          method: "POST",
          proj: bizProjectId,
          body: {
            agentId: bizWorker.id,
            token: bizWorker.token,
            text: `流水日志_${stamp}_${String(i).padStart(2, "0")}`,
          },
        })
      }

      // Advance bizQuiet1's seenSeq to right here, then post 2 more lines that remain unseen by bizQuiet1
      const quietInboxBefore = await frontReq("/api/v1/inbox", {
        method: "POST",
        proj: bizProjectId,
        body: { agentId: bizQuiet1.id, token: bizQuiet1.token, after: 0 },
      })
      const savedQuietCursor = quietInboxBefore.data.seq
      assert(savedQuietCursor > 0, "记录测试席位初始 seenSeq 失败")

      for (let i = 32; i <= 33; i++) {
        await frontReq("/api/v1/say", {
          method: "POST",
          proj: bizProjectId,
          body: {
            agentId: bizWorker.id,
            token: bizWorker.token,
            text: `流水日志_${stamp}_${String(i).padStart(2, "0")}`,
          },
        })
      }

      // 5) Guard checks: 401 without token, 403 for seats in ordinary projects (both HTTP & MCP)
      const unauthOverview = await frontReq("/api/v1/overview", { method: "POST", body: {} })
      assert(unauthOverview.status === 401, `无凭证调 overview 应返回 401，实际 ${unauthOverview.status}`)
      const unauthPeek = await frontReq("/api/v1/peek", { method: "POST", body: { project: bizProjectId } })
      assert(unauthPeek.status === 401, `无凭证调 peek 应返回 401，实际 ${unauthPeek.status}`)

      const forbidOverview = await frontReq("/api/v1/overview", {
        method: "POST",
        body: { agentId: bizWorker.id, token: bizWorker.token },
      })
      assert(forbidOverview.status === 403, `普通项目席位调 /api/v1/overview 必须返回 403，实际 ${forbidOverview.status}`)

      const forbidPeek = await frontReq("/api/v1/peek", {
        method: "POST",
        body: { agentId: bizWorker.id, token: bizWorker.token, project: bizProjectId },
      })
      assert(forbidPeek.status === 403, `普通项目席位调 /api/v1/peek 必须返回 403，实际 ${forbidPeek.status}`)

      // Also verify via real bench-mcp.mjs stdio bridge for an ordinary project seat
      const ordinaryMcp = startMcpClient(`ord_mcp_${stamp}`)
      await ordinaryMcp.rpc("initialize", { protocolVersion: "2025-06-18" })
      const ordJoin = await ordinaryMcp.rpc("tools/call", {
        name: "bench_join",
        arguments: { project: bizName, name: "桥普通席", model: "claude", role: "验证" },
      })
      assert(!ordJoin.result?.isError, `普通桥席位入座失败：${JSON.stringify(ordJoin)}`)
      const ordOverviewCall = await ordinaryMcp.rpc("tools/call", { name: "bench_overview", arguments: {} })
      assert(
        ordOverviewCall.result?.isError === true && ordOverviewCall.result?.content?.[0]?.text?.includes("前台"),
        `普通项目席位经 MCP 调 bench_overview 应报错拒绝，实际：${JSON.stringify(ordOverviewCall)}`,
      )
      const ordPeekCall = await ordinaryMcp.rpc("tools/call", {
        name: "bench_peek",
        arguments: { project: bizName },
      })
      assert(
        ordPeekCall.result?.isError === true && ordPeekCall.result?.content?.[0]?.text?.includes("前台"),
        `普通项目席位经 MCP 调 bench_peek 应报错拒绝，实际：${JSON.stringify(ordPeekCall)}`,
      )

      // 6) Seat in reception project: verify wake prompt carries <200-char front duty (and ordinary project does not)
      const frontWakeSeat = await frontReq("/api/v1/join", {
        method: "POST",
        proj: frontId,
        body: {
          name: `前台总管${stamp}`,
          model: "mock-front",
          role: "接待总览",
          agentName: mockFrontKind,
          uuid: `front_wake_${stamp}`,
        },
      })
      assert(frontWakeSeat.status === 201, `前台席位入座失败 ${frontWakeSeat.raw}`)

      const wakeTrigger = await frontReq("/api/v1/say", {
        method: "POST",
        proj: frontId,
        body: { as: "human", text: `@前台总管${stamp} 帮我看下各项目有什么事等我处理` },
      })
      assert(wakeTrigger.status === 200, "前台点名发言失败")

      for (let i = 0; i < 40; i++) {
        if (fsFront.existsSync(wakeOutFile)) break
        await sleepFront(150)
      }
      assert(fsFront.existsSync(wakeOutFile), "前台席位被点名后应被成功唤起并写出提示词")
      const capturedFrontPrompt = fsFront.readFileSync(wakeOutFile, "utf8")
      const dutyMatch = capturedFrontPrompt.match(/你是前台[\s\S]*?说清楚。/)
      assert(
        dutyMatch &&
          dutyMatch[0].length <= 200 &&
          dutyMatch[0].includes("bench_overview") &&
          dutyMatch[0].includes("bench_peek") &&
          dutyMatch[0].includes("t_…") &&
          dutyMatch[0].includes("m_…") &&
          // Drafts only: relay / nudge / review cards count once the user clicks (t_e8af4882).
          ["bench_relay", "bench_nudge", "bench_review_card", "点了才算", "不能替他验收"].every((part) => dutyMatch[0].includes(part)),
        `前台唤起提示词须包含 <=200 字的完整职责说明，实际：${dutyMatch ? `${dutyMatch[0].length}字: ${dutyMatch[0]}` : capturedFrontPrompt.slice(-400)}`,
      )
      // Sign-off by the desk (t_50597554): the three tools are named, and
      // signing is the one exception to 「不能替他验收」, only for what the
      // room marks 「可代签」.
      assert(
        ["bench_review_batch", "bench_check", "bench_accept", "只有一个例外", "可代签", "被拒就留给他"].every((part) => capturedFrontPrompt.includes(part)),
        `前台守则要写明整批卡片、补跑复验和代签的例外，实际：${capturedFrontPrompt.slice(capturedFrontPrompt.indexOf("你是前台"), capturedFrontPrompt.indexOf("你是前台") + 420)}`,
      )

      // At the desk (a chat with its one AI) a message with no @ wakes it too.
      fsFront.rmSync(wakeOutFile, { force: true })
      for (let i = 0; i < 40 && (await frontReq("/api/v1/room", { proj: frontId })).data.agents?.some((a) => a.runId); i++) await sleepFront(150)
      const plainAsk = await frontReq("/api/v1/say", {
        method: "POST",
        proj: frontId,
        body: { as: "human", text: `不带艾特再问一次_${stamp}` },
      })
      assert(plainAsk.status === 200 && !plainAsk.data.message?.text?.includes("@"), `前台不带 @ 的话正文里不该补 @：${plainAsk.raw}`)
      for (let i = 0; i < 40; i++) {
        if (fsFront.existsSync(wakeOutFile)) break
        await sleepFront(150)
      }
      assert(
        fsFront.existsSync(wakeOutFile) && fsFront.readFileSync(wakeOutFile, "utf8").includes(`不带艾特再问一次_${stamp}`),
        "前台里不带 @ 的话也要叫醒值班的 AI",
      )

      // Ordinary project wake prompt must NOT include reception duty
      const bizPromptPreview = await frontReq("/api/v1/prompt", { proj: bizProjectId })
      assert(!JSON.stringify(bizPromptPreview.data).includes("你是前台"), "普通项目提示词不应含前台职责")

      // 7) Call bench_overview & bench_peek from reception seat (both MCP stdio & HTTP)
      const frontMcp = startMcpClient(`front_mcp_${stamp}`)
      await frontMcp.rpc("initialize", { protocolVersion: "2025-06-18" })
      const toolListRes = await frontMcp.rpc("tools/list", {})
      const toolNames = (toolListRes.result?.tools ?? []).map((t) => t.name)
      assert(
        toolNames.includes("bench_overview") && toolNames.includes("bench_peek"),
        "bench-mcp.mjs tools/list 应注册 bench_overview 与 bench_peek",
      )

      // The desk seats one AI (t_31cd7f9e): a second one is turned away, and
      // the bridge passes the room's reason on instead of 「名字被占」.
      const frontMcpJoin = await frontMcp.rpc("tools/call", {
        name: "bench_join",
        arguments: { project: "前台", name: `前台桥${stamp}`, model: "claude", role: "前台" },
      })
      const secondText = frontMcpJoin.result?.content?.[0]?.text ?? ""
      assert(
        frontMcpJoin.result?.isError === true && secondText.includes("前台只坐一个") && !secondText.includes("名字"),
        `前台已有人值班时，第二个 MCP 入座应被拒并说明原因，实际：${JSON.stringify(frontMcpJoin)}`,
      )
      // The bridge then sits in the desk's seat, the way the room hands a
      // session its seat (lib/spawn.ts giveSeat).
      fsFront.mkdirSync(pathFront.join(mcpStateRoot, "bench-mcp"), { recursive: true })
      fsFront.writeFileSync(
        pathFront.join(mcpStateRoot, "bench-mcp", `claude-front_mcp2_${stamp}.json`),
        JSON.stringify({ agentId: frontWakeSeat.data.agent.id, token: frontWakeSeat.data.token, name: `前台总管${stamp}`, project: frontId, cursor: 0 }),
      )
      frontMcp.child.kill()
      const deskMcp = startMcpClient(`front_mcp2_${stamp}`)
      await deskMcp.rpc("initialize", { protocolVersion: "2025-06-18" })

      const snapBizBefore = await frontReq("/api/v1/room", { proj: bizProjectId })
      const bizSeqBefore = snapBizBefore.data.seq

      const mcpOverview = await deskMcp.rpc("tools/call", { name: "bench_overview", arguments: {} })
      assert(!mcpOverview.result?.isError, `前台调 bench_overview 失败：${JSON.stringify(mcpOverview)}`)
      const overviewText = mcpOverview.result?.content?.[0]?.text ?? ""
      assert(overviewText.length > 0 && overviewText.length <= 4600, `bench_overview 输出应精简控制在几千字内，实际 ${overviewText.length}`)
      assert(
        overviewText.includes(bizProjectId) &&
          overviewText.includes(bizName) &&
          overviewText.includes(bizDir) &&
          overviewText.includes("提问 1") &&
          overviewText.includes("权限 1") &&
          overviewText.includes("验收 1") &&
          overviewText.includes("未完待办：2") &&
          overviewText.includes("工匠（在做）") &&
          overviewText.includes("欠活员") &&
          overviewText.includes("停着还欠") &&
          overviewText.includes("其余无事席位") &&
          overviewText.includes(`【摘要头_${stamp}】`) &&
          !overviewText.includes(`【摘要尾_${stamp}】`),
        `bench_overview 内容不符合预期：\n${overviewText}`,
      )

      // Peek by project name via MCP
      const mcpPeek = await deskMcp.rpc("tools/call", {
        name: "bench_peek",
        arguments: { project: bizName },
      })
      assert(!mcpPeek.result?.isError, `前台调 bench_peek 失败：${JSON.stringify(mcpPeek)}`)
      const peekText = mcpPeek.result?.content?.[0]?.text ?? ""
      assert(
        peekText.includes(`【摘要头_${stamp}】`) &&
          peekText.includes(`【摘要尾_${stamp}】`) &&
          peekText.includes(tReviewId) &&
          peekText.includes("步骤 1/2") &&
          peekText.includes("报表已生成，请核验导出结果") &&
          peekText.includes(tOwedId) &&
          peekText.includes(openAskId) &&
          peekText.includes(`导出格式用 CSV 还是 Parquet_${stamp}？`) &&
          peekText.includes("Parquet") &&
          peekText.includes(pendingPermitId) &&
          peekText.includes(`pg_dump --schema-only db_${stamp}`) &&
          peekText.includes(callFailMsgId) &&
          peekText.includes(`模拟点名唤起报错_${stamp}`) &&
          peekText.includes(`流水日志_${stamp}_33`) &&
          !peekText.includes(`流水日志_${stamp}_01`),
        `bench_peek 内容缺失关键段落：\n${peekText}`,
      )

      // HTTP /api/v1/peek pagination with `before` (by project id)
      const httpOverview = await frontReq("/api/v1/overview", {
        method: "POST",
        body: { agentId: frontWakeSeat.data.agent.id, token: frontWakeSeat.data.token },
      })
      assert(httpOverview.status === 200, "HTTP /api/v1/overview 应返回 200")

      const httpPeekPage1 = await frontReq("/api/v1/peek", {
        method: "POST",
        body: { agentId: frontWakeSeat.data.agent.id, token: frontWakeSeat.data.token, project: bizProjectId },
      })
      assert(
        httpPeekPage1.status === 200 &&
          httpPeekPage1.data.talk.messages.length === 10 &&
          httpPeekPage1.data.talk.hasMore === true &&
          typeof httpPeekPage1.data.talk.oldestSeq === "number" &&
          httpPeekPage1.data.text.includes(`用 before=${httpPeekPage1.data.talk.oldestSeq} 翻`),
        `HTTP /api/v1/peek 默认精简第一页应返回最近 10 条并写明 before 翻页提示`,
      )

      const httpPeekFull1 = await frontReq("/api/v1/peek", {
        method: "POST",
        body: { agentId: frontWakeSeat.data.agent.id, token: frontWakeSeat.data.token, project: bizProjectId, full: true },
      })
      assert(
        httpPeekFull1.status === 200 &&
          httpPeekFull1.data.talk.messages.length === 30 &&
          httpPeekFull1.data.talk.hasMore === true &&
          typeof httpPeekFull1.data.talk.oldestSeq === "number",
        `HTTP /api/v1/peek 传 full:true 应保留旧行为返回最近 30 条且 hasMore=true`,
      )

      const httpPeekPage2 = await frontReq("/api/v1/peek", {
        method: "POST",
        body: {
          agentId: frontWakeSeat.data.agent.id,
          token: frontWakeSeat.data.token,
          project: bizProjectId,
          full: true,
          before: httpPeekFull1.data.talk.oldestSeq,
        },
      })
      assert(
        httpPeekPage2.status === 200 && httpPeekPage2.data.text.includes(`流水日志_${stamp}_01`),
        `bench_peek 传 before 往前翻页应能读到第 01 条早期对话`,
      )

      // 8) Security & strictly read-only guarantees: no recalled text, no humanKey/tokens/uuids, no seenSeq move, no wake triggered
      const combinedPayloads = [overviewText, peekText, httpOverview.raw, httpPeekPage1.raw, httpPeekPage2.raw].join("\n")
      assert(!combinedPayloads.includes(recalledSecret), "已撤回消息原文绝不能出现在 overview 或 peek 中")
      assert(!combinedPayloads.includes(humanKey), "human-key 绝不能出现在 overview 或 peek 中")
      assert(!combinedPayloads.includes(bizWorker.token), "席位 token 绝不能出现在 overview 或 peek 中")
      assert(!combinedPayloads.includes(secretSessionUuid), "席位底层 session uuid 绝不能出现在 overview 或 peek 中")

      const snapBizAfter = await frontReq("/api/v1/room", { proj: bizProjectId })
      assert(snapBizAfter.data.seq === bizSeqBefore, `只读工具不应往业务房间写任何消息或改变 seq（前 ${bizSeqBefore}，后 ${snapBizAfter.data.seq}）`)
      assert(
        !snapBizAfter.data.agents.some((a) => Boolean(a.runId)),
        "跨项目只读查询绝不应触发任何席位唤起",
      )

      // Check bizQuiet1's unseen messages are still unseen (seenSeq was NOT advanced by overview/peek)
      const quietInboxAfter = await frontReq("/api/v1/inbox", {
        method: "POST",
        proj: bizProjectId,
        body: { agentId: bizQuiet1.id, token: bizQuiet1.token, after: savedQuietCursor },
      })
      const unseenTexts = quietInboxAfter.data.messages.map((m) => m.text).join("\n")
      assert(
        unseenTexts.includes(`流水日志_${stamp}_32`) && unseenTexts.includes(`流水日志_${stamp}_33`),
        "调完 overview/peek 后别的项目席位原有的未读消息和 seenSeq 必须保持原样",
      )

      // 9) t_ab05661d: front-desk `bench_check` tool + settle notification waking
      //    the reception seat + `bench_overview` / `bench_peek` carrying check state, kind & gaps
      const plainCheckDenied = await ordinaryMcp.rpc("tools/call", {
        name: "bench_check",
        arguments: { project: bizProjectId },
      })
      assert(plainCheckDenied.result?.isError === true, "普通项目席位调 bench_check 必须被 403 拒绝")

      // First call `bench_check` via MCP while bizProject has check off -> returns skipped (proving MCP tool works)
      const mcpCheckBeforeAuto = await deskMcp.rpc("tools/call", {
        name: "bench_check",
        arguments: { project: bizName },
      })
      const mcpBeforeText = mcpCheckBeforeAuto.result?.content?.[0]?.text || ""
      assert(
        !mcpCheckBeforeAuto.result?.isError && mcpBeforeText.includes("没开复验"),
        `前台经 MCP 调 bench_check（未开复验时）应返回未开复验原因，实际 ${mcpBeforeText}`,
      )

      const mockBizCheckKind = `mockbizchk_${stamp}`
      const mockBizCheckScript = pathFront.join(mcpStateRoot, `mock-biz-chk-${stamp}.mjs`)
      fsFront.writeFileSync(
        mockBizCheckScript,
        `console.log("复验结论：通过\\n类别：要人看\\n对账逻辑通过\\n没验到的：导出报表视觉样式需肉眼看")\n`,
        "utf8",
      )
      const curFrontAdapters = (await frontReq("/api/v1/adapters")).data.agents.map(({ name, command, reply }) => ({ name, command, reply }))
      await frontReq("/api/v1/adapters", {
        method: "POST",
        body: {
          as: "human",
          agents: [
            ...curFrontAdapters,
            {
              name: mockBizCheckKind,
              command: `node '${mockBizCheckScript}' {uuid} {text}`,
              reply: "stdout",
            },
          ],
        },
      })
      await joinBizSeat("业务复验员", { agentName: mockBizCheckKind, uuid: `bizchk_${stamp}` })
      await sleepFront(25)
      await frontReq("/api/v1/pulse", {
        method: "POST",
        proj: bizProjectId,
        body: { agentId: bizOweSeat.id, token: bizOweSeat.token, keepalive: true },
      })
      await frontReq(`/api/v1/projects/${bizProjectId}`, {
        method: "POST",
        body: { as: "human", action: "update", name: bizName, dir: bizDir, check: "auto" },
      })

      // Ensure any previous wake on frontWakeSeat has settled before clearing wakeOutFile
      for (let i = 0; i < 40; i++) {
        const fSnap = await frontReq("/api/v1/room", { proj: frontId })
        if (!fSnap.data.agents?.some((a) => a.runId)) break
        await sleepFront(150)
      }
      const sessRestore = await frontReq("/api/v1/session", {
        method: "POST",
        proj: frontId,
        body: {
          agentId: frontWakeSeat.data.agent.id,
          token: frontWakeSeat.data.token,
          agentName: mockFrontKind,
          uuid: `front_wake_${stamp}`,
        },
      })
      assert(sessRestore.status === 200, `恢复前台模拟会话失败：${sessRestore.status} ${sessRestore.raw}`)
      fsFront.rmSync(wakeOutFile, { force: true })

      const frontBatchCheck = await frontReq("/api/v1/check", {
        method: "POST",
        body: {
          agentId: frontWakeSeat.data.agent.id,
          token: frontWakeSeat.data.token,
          project: bizName,
        },
      })
      assert(
        frontBatchCheck.status === 200 && frontBatchCheck.data.queued === 1,
        `前台席位调 /api/v1/check 应成功排入业务房未复验待办，实际 ${frontBatchCheck.raw}`,
      )

      // The pick takes a seat that has had a to-do of its own here first (t_50597554): that is
      // 欠活员, whose client fails. The check can't run; the desk is told all the same, and how
      // to go on.
      for (let i = 0; i < 60; i++) {
        if (fsFront.existsSync(wakeOutFile)) break
        await sleepFront(150)
      }
      const failedRound = (await frontReq("/api/v1/room", { proj: bizProjectId })).data.tasks?.find((t) => t.id === tReviewId)?.check
      const failedPrompt = fsFront.existsSync(wakeOutFile) ? fsFront.readFileSync(wakeOutFile, "utf8") : ""
      assert(
        failedRound?.state === "error" &&
          failedRound.by === bizOweSeat.id &&
          failedPrompt.includes("通过 0 件、没过 0 件、没验到 0 件（另有 1 件跳过或没跑成）") &&
          failedPrompt.includes("bench_check 再排一次"),
        `复验没跑成也要叫醒前台并告诉它再排一次，实际 check=${JSON.stringify(failedRound)} 说明：${failedPrompt.slice(failedPrompt.indexOf("巡查"), failedPrompt.indexOf("巡查") + 400)}`,
      )
      // Queued again: the seat that just failed is left alone, the other one checks.
      for (let i = 0; i < 40; i++) {
        const fSnap = await frontReq("/api/v1/room", { proj: frontId })
        if (!fSnap.data.agents?.some((a) => a.runId)) break
        await sleepFront(150)
      }
      fsFront.rmSync(wakeOutFile, { force: true })
      const frontBatchAgain = await frontReq("/api/v1/check", {
        method: "POST",
        body: { agentId: frontWakeSeat.data.agent.id, token: frontWakeSeat.data.token, project: bizName },
      })
      assert(frontBatchAgain.status === 200 && frontBatchAgain.data.queued === 1, `没跑成的应能再排一次，实际 ${frontBatchAgain.raw}`)

      // Wait for check to finish AND front desk AI to be woken with the hidden settled summary
      for (let i = 0; i < 60; i++) {
        if (fsFront.existsSync(wakeOutFile)) break
        await sleepFront(150)
      }
      if (!fsFront.existsSync(wakeOutFile)) {
        const bDbg = (await frontReq("/api/v1/room", { proj: bizProjectId })).data.tasks?.find((t) => t.id === tReviewId)?.check
        const fDbg = (await frontReq("/api/v1/room", { proj: frontId })).data
        throw new Error(
          `项目排着的复验全部有了结论后应自动叫醒前台值班 AI | bizCheck=${JSON.stringify(bDbg)} | frontAgents=${JSON.stringify(fDbg.agents)} | frontLastMsg=${JSON.stringify(fDbg.messages?.slice(-2))}`,
        )
      }
      const settledPrompt = fsFront.readFileSync(wakeOutFile, "utf8")
      assert(
        settledPrompt.includes(bizName) &&
          settledPrompt.includes("通过 1 件、没过 0 件、没验到 0 件") &&
          settledPrompt.includes("用户看不到这条"),
        `前台收到的复验完成说明应包含项目名与通过/没过/没验到计数，实际：\n${settledPrompt
          .split("\n")
          .filter((line) => /巡查|复验|bench_peek/.test(line))
          .join("\n")
          .slice(0, 1500)}\ncheck=${JSON.stringify((await frontReq("/api/v1/room", { proj: bizProjectId })).data.tasks?.find((t) => t.id === tReviewId)?.check)}`,
      )
      const frontSnapAfterCheck = await frontReq("/api/v1/room", { proj: frontId })
      assert(
        frontSnapAfterCheck.data.messages.some((m) => m.risk?.items?.some((it) => it.projectId === bizProjectId && it.text.includes("通过 1 件"))),
        "前台房间应记下一条带 risk 的隐藏复验汇总消息",
      )

      // Verify bench_overview and bench_peek now include check state, kind ("look" / 要人看), and hasGaps
      const ovWithCheck = await frontReq("/api/v1/overview", {
        method: "POST",
        body: { agentId: frontWakeSeat.data.agent.id, token: frontWakeSeat.data.token },
      })
      const bizOvProj = ovWithCheck.data.projects.find((p) => p.id === bizProjectId)
      const ovRev = bizOvProj?.waitingReviews?.find((r) => r.id === tReviewId)
      assert(
        ovRev?.checkState === "passed" &&
          ovRev?.checkKind === "look" &&
          ovRev?.hasGaps === true &&
          ovWithCheck.data.text.includes("复验通过") &&
          ovWithCheck.data.text.includes("要人看") &&
          ovWithCheck.data.text.includes("有没验到的"),
        `bench_overview 应带上等验收待办的复验状态、类别与有无漏验，实际 ${JSON.stringify(ovRev)}`,
      )

      const peekWithCheck = await frontReq("/api/v1/peek", {
        method: "POST",
        body: { agentId: frontWakeSeat.data.agent.id, token: frontWakeSeat.data.token, project: bizProjectId },
      })
      const peekRev = peekWithCheck.data.waiting?.reviews?.find((r) => r.id === tReviewId)
      assert(
        peekRev?.checkState === "passed" &&
          peekRev?.checkKind === "look" &&
          peekRev?.hasGaps === true &&
          peekWithCheck.data.text.includes("类别：要人看") &&
          peekWithCheck.data.text.includes("有没验到的（导出报表视觉样式需肉眼看）"),
        `bench_peek 应带上等验收待办的复验状态、类别与漏验内容，实际 ${JSON.stringify(peekRev)}`,
      )

      fsFront.rmSync(bizDir, { recursive: true, force: true })
    } finally {
      for (const proc of mcpProcs) {
        try {
          proc.kill("SIGTERM")
        } catch {}
      }
      if (bizProjectId) {
        const snap = await frontReq("/api/v1/room", { proj: bizProjectId }).catch(() => null)
        for (const p of snap?.data?.permits ?? []) {
          await frontReq("/api/v1/permit", {
            method: "POST",
            proj: bizProjectId,
            body: { as: "human", id: p.id, decision: "deny", note: "测试清理" },
          }).catch(() => {})
        }
        if (pendingPermitPromise) await Promise.allSettled([pendingPermitPromise])
        await frontReq(`/api/v1/projects/${bizProjectId}`, {
          method: "POST",
          body: { as: "human", action: "delete", confirm: "删除" },
        }).catch(() => {})
      }
      if (createdFrontId) {
        await frontReq(`/api/v1/projects/${createdFrontId}`, {
          method: "POST",
          body: { as: "human", action: "delete", confirm: "删除" },
        }).catch(() => {})
      }
      if (cleanBaseAdapters) {
        await frontReq("/api/v1/adapters", {
          method: "POST",
          body: { as: "human", agents: cleanBaseAdapters },
        }).catch(() => {})
      }
      if (hadAgentsBefore && savedAgentsRaw !== null) {
        fsFront.writeFileSync(agentsJsonPath, savedAgentsRaw, "utf8")
      }
      fsFront.rmSync(mcpStateRoot, { recursive: true, force: true })
    }
  }

  // ---- Auto-continue (t_4494da49) & watched projects (t_0fefb44c) ----
  {
    const { execFile } = await import("node:child_process")
    const { promisify } = await import("node:util")
    const execSubTest = promisify(execFile)
    const pathSub = await import("node:path")
    const keyPath = process.env.BENCH_KEY_FILE || `${process.cwd()}/data/human-key`
    await execSubTest(process.execPath, [pathSub.join(process.cwd(), "scripts/test-continue.mjs")], {
      cwd: process.cwd(),
      env: { ...process.env },
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    })
    await execSubTest(process.execPath, [pathSub.join(process.cwd(), "scripts/test-watch.mjs")], {
      cwd: process.cwd(),
      env: { ...process.env, BENCH_URL: origin, BENCH_KEY_FILE: keyPath },
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    })
    await execSubTest(process.execPath, [pathSub.join(process.cwd(), "scripts/test-backup.mjs")], {
      cwd: process.cwd(),
      env: { ...process.env },
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    })
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
