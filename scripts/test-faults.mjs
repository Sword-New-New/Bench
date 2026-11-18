#!/usr/bin/env node
// Fault-injection runner for bench's critical paths (docs/要害清单.md).
//
// How it works:
//   1. Creates an isolated working copy under ~/.cache/bench-copies/faults-<pid>
//      with its own BENCH_DATA_DIR and its own `next dev` process (never touches
//      the live room on :4399 or the main working tree's source files).
//   2. Runs `scripts/test-room.mjs` once against the clean copy — must pass.
//   3. For each fault in FAULTS: applies the exact source replacement inside the
//      isolated copy, warms the server so Next.js recompiles the module, runs
//      `scripts/test-room.mjs` (must fail!), and always restores the file in `finally`.
//   4. Prints a Markdown summary table and exits non-zero if the baseline failed
//      or any fault was not caught by the test suite.

import { spawn, spawnSync } from "node:child_process"
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

export const FAULTS = [
  {
    id: "keepalive-bumps-rev",
    artery: "3. 存储和搜索索引",
    file: "lib/store.ts",
    desc: "在线席位的保活又改房间版本号、整间房重写重发（每个开着的页面每 20 秒每席位重画一次）",
    expectedTest: "在线席位的保活不该改房间版本号",
    find: `  if (back) {\n    saved.set(id, now)\n    bumpRev()`,
    replace: `  if (back || true) {\n    saved.set(id, now)\n    bumpRev()`,
  },
  {
    id: "old-attachment-not-found",
    artery: "3. 存储和搜索索引",
    file: "lib/store.ts",
    desc: "附件只在内存里的最近 400 条消息里找，更早消息里的图片和视频打不开",
    expectedTest: "400 条以前的消息里的图片应当还能打开",
    find: `  return dbHasAttachment(current.id, file)`,
    replace: `  return false && dbHasAttachment(current.id, file)`,
  },
  {
    id: "queue-drop-after-wake",
    artery: "1. 叫醒和队列",
    file: "lib/summon.ts",
    desc: "排着的消息在唤起结束后被清空丢掉，不接着跑下一轮",
    expectedTest: "忙时连 @ 两条消息：第一条跑完后自动唤起第二条并均应 answered",
    find: `  launch(agent, command, log, seat.live, ({ out, failure, stopped, lost }) => {\n    queue.running = false`,
    replace: `  launch(agent, command, log, seat.live, ({ out, failure, stopped, lost }) => {\n    queue.running = false; queue.pending = []`,
  },
  {
    id: "call-fail-no-note",
    artery: "2. 点名的去向",
    file: "lib/store.ts",
    desc: "唤起失败时不往 Message.calls 记 failed 去向",
    expectedTest: "点名唤起报错退出时，Message.calls 应记为 failed 且计入 seatOwes",
    find: [
      "export function markCalls(",
      "  ids: string[],",
      "  agentId: string,",
      "  state: CallState,",
      "  extra: { runId?: string; note?: string; from?: CallState[]; run?: string } = {},",
      ") {",
      "  if (ids.length === 0) return",
    ].join("\n"),
    replace: [
      "export function markCalls(",
      "  ids: string[],",
      "  agentId: string,",
      "  state: CallState,",
      "  extra: { runId?: string; note?: string; from?: CallState[]; run?: string } = {},",
      ") {",
      '  if (ids.length === 0 || state === "failed") return',
    ].join("\n"),
  },
  {
    id: "fts-recall-leak",
    artery: "3. 存储和搜索索引",
    file: "lib/db.ts",
    desc: "撤回消息更新数据库时保留了旧 text 列，导致 FTS5 索引残留原文",
    expectedTest: "用户撤回消息后，messages_fts 全文索引中不应保留撤回前的原文",
    find: `       author_name = excluded.author_name,\n       text = excluded.text,`,
    replace: `       author_name = excluded.author_name,\n       text = messages.text,`,
  },
  {
    id: "restart-lane-not-paused",
    artery: "4. 重启后的恢复",
    file: "lib/summon.ts",
    desc: "服务器重启恢复队列时，未将有积压工作的队列自动设为 paused",
    expectedTest: "冷启动恢复时，有积压消息的席位队列应自动暂停（queuePaused === true）",
    find: `        const paused = Boolean(row.paused || hasWork)`,
    replace: `        const paused = Boolean(row.paused)`,
  },
  {
    id: "restart-resumes-earlier-pause",
    artery: "4. 重启后的恢复",
    file: "lib/summon.ts",
    desc: "重启后自动接上时，把这次重启之前就停着的队列（上次重启停了没接上的）也放开，几天前的旧活被拉起来",
    expectedTest: "重启前就暂停着的（用户停的、上次重启没接的）不该被自动接上",
    find: `        if (hasWork && !row.paused) bootPaused().add(row.agentId)`,
    replace: `        if (hasWork) bootPaused().add(row.agentId)`,
  },
  {
    id: "restart-rewakes-user-paused",
    artery: "4. 重启后的恢复",
    file: "lib/summon.ts",
    desc: "用户暂停着、又有一轮在跑的席位，重启后被自动叫回，用户的暂停也被解开",
    expectedTest: "用户暂停着、又有一轮在跑的席位，重启后不该被自动叫回、暂停也不该解开",
    find: `  if (userPaused(agentId)) return`,
    replace: `  if (false && userPaused(agentId)) return`,
  },
  {
    id: "restart-resumes-all-at-once",
    artery: "4. 重启后的恢复",
    file: "lib/summon.ts",
    desc: "重启后自动接上不错开，所有被打断的席位同时叫醒",
    expectedTest: "重启后应一个一个接上（被打断的先、排队的隔一段再接）",
    find: `    }, first + index * gap)`,
    replace: `    }, first)`,
  },
  {
    id: "rebind-no-token-rotate",
    artery: "5. 入座、换脑和凭证轮换",
    file: "lib/store.ts",
    desc: "跨厂家换脑（rebindAgent）时不轮换席位 token，旧会话仍能凭旧 token 发言",
    expectedTest: "换脑后旧会话带旧 token 调 /api/v1/say 应被 401 拒绝",
    find: `  agent.session = input.session\n  agent.token = randomBytes(18).toString("hex")`,
    replace: `  agent.session = input.session\n  void randomBytes`,
  },
  {
    id: "permit-held-ignored",
    artery: "6. 权限卡片与用户口令",
    file: "lib/permits.ts",
    desc: "hasFull 忽略本轮临时收回标记（heldWake），收回后仍放行默认全部权限",
    expectedTest: "开启默认全部权限后点本轮临时收回，fullAccess 应立即变为 false",
    find: `  return permits().grants.get(agentId) === wake || (autoFullOf(agentId) && heldOf(agentId) !== wake)`,
    replace: `  return permits().grants.get(agentId) === wake || autoFullOf(agentId)`,
  },
  {
    id: "review-step-self-tick",
    artery: "7. 提问和验收",
    file: "lib/store.ts",
    desc: "setTaskStep 未拦截 agent 自己将「请用户验收」那一步勾为 done",
    expectedTest: "agent 尝试自己勾掉验收步骤时应返回 403",
    find: `      if (actor.type === "agent" && state === "done" && isReviewStep(step)) {`,
    replace: `      if (false && actor.type === "agent" && state === "done" && isReviewStep(step)) {`,
  },
  {
    id: "front-guard-bypassed",
    artery: "6. 权限卡片与用户口令",
    file: "lib/store.ts",
    desc: "requireFrontSeat 未拦截非前台项目席位，导致普通项目的席位也能跨项目读取别的房间",
    expectedTest: "普通项目的席位调 /api/v1/overview 与 /api/v1/peek 应返回 403",
    find: `  if (!info.front) {\n    throw new ApiError(403, "这两件跨项目工具只给「前台」房间里的席位用")\n  }`,
    replace: `  if (false && !info.front) {\n    throw new ApiError(403, "这两件跨项目工具只给「前台」房间里的席位用")\n  }`,
  },
  {
    id: "recheck-duplicate-enqueue",
    artery: "7. 提问和验收",
    file: "lib/store.ts",
    desc: "补跑复验时未跳过已排着或正在跑的复验，导致重复入队并覆盖 check.at",
    expectedTest: "已在跑/排着的复验调补跑接口不应重复入队或覆盖 check.at",
    find: `    if (task.check && (task.check.state === "queued" || task.check.state === "running")) {`,
    replace: `    if (false && task.check && (task.check.state === "queued" || task.check.state === "running")) {`,
  },
  {
    id: "autocheck-picks-owner",
    artery: "7. 提问和验收",
    file: "lib/summon.ts",
    desc: "自动挑复验人未排除待办负责人自己（item.id !== task.ownerId）",
    expectedTest: "自动挑复验人绝不能挑待办负责人自己",
    find: `  const others = snap.agents.filter((item) => !item.demo && item.id !== task.ownerId)`,
    replace: `  const others = snap.agents.filter((item) => !item.demo)`,
  },
  {
    id: "autocheck-ignores-diff-client",
    artery: "7. 提问和验收",
    file: "lib/summon.ts",
    desc: "自动挑复验人在同家与不同家客户端都在时未优先挑不同家客户端",
    expectedTest: "同家与不同家都在时应优先挑不同家客户端的席位",
    find: `    if (aDiff !== bDiff) return aDiff - bDiff`,
    replace: `    if (false && aDiff !== bDiff) return aDiff - bDiff`,
  },
  {
    id: "check-verdict-kind-gaps-broken",
    artery: "7. 提问和验收",
    file: "lib/summon.ts",
    desc: "复验结论解析未忽略「没验到的：无」，将「无」误存入 Task.check.gaps",
    expectedTest: "「没验到的：无」不应存入 Task.check.gaps，类别与漏验应准确读入",
    find: `  if (!normalized || normalized === "无" || normalized === "没有" || normalized.toLowerCase() === "none") {`,
    replace: `  if (!normalized) {`,
  },
  {
    id: "check-missing-kind-defaulted",
    artery: "7. 提问和验收",
    file: "lib/summon.ts",
    desc: "复验输出未写「类别：」时擅自赋予默认类别而非不存",
    expectedTest: "复验未写类别时不该存入默认 Task.check.kind",
    find: `  if (!hit) return undefined`,
    replace: `  if (!hit) return "run"`,
  },
  {
    id: "auto-accept-not-called",
    artery: "7. 提问和验收",
    file: "lib/summon.ts",
    desc: "开了「查过没问题的，自动替我收下」，复验通过、跑得出，房间却不收下（复验结论写入后没调 autoAcceptChecked）",
    expectedTest: "开关开着、复验跑得出：房间该自己收下",
    find: `      autoAcceptChecked(item.taskId)\n`,
    replace: `      void 0\n`,
  },
  {
    id: "first-open-starts-twice",
    artery: "5. 入座、换脑和凭证轮换",
    file: "lib/first-open.ts",
    desc: "「第一次打开」点过「开始」之后再点，又建一个文件夹（不再看房间是不是还全新）",
    expectedTest: "（scripts/test-first.mjs）席位和文件夹都没多出来",
    test: "scripts/test-first.mjs",
    find: `  if (!isFresh()) throw new ApiError(409, "这个房间已经开始用了，刷新一下页面")`,
    replace: `  if (false) throw new ApiError(409, "")`,
  },
  {
    id: "first-open-stuck-after-failure",
    artery: "5. 入座、换脑和凭证轮换",
    file: "lib/first-open.ts",
    desc: "第一次打开点「开始」中途失败（席位建了、入座文件没写成），席位留着，房间不再算全新，再点开始被挡住",
    expectedTest: "（scripts/test-first.mjs）中途失败后席位收回，房间还是全新的，第一屏还在",
    test: "scripts/test-first.mjs",
    find: "          if (!before.has(agent.id) && !agent.demo) removeAgent(agent.id, true)",
    replace: "          if (false && !before.has(agent.id) && !agent.demo) removeAgent(agent.id, true)",
  },
  {
    id: "old-done-task-by-id-missing",
    artery: "3. 存储和搜索索引",
    file: "lib/store.ts",
    desc: "getTaskById 只在主快照窗口（snapshotTasks）里查找，导致超过 48 小时的旧待办按 id 拉不到",
    expectedTest: "（scripts/test-tasks-archive.mjs）完成超过 48 小时的旧待办从主快照剔除后，getTaskById 仍必须能拉到",
    test: "scripts/test-tasks-archive.mjs",
    find: `export function getTaskById(taskId: string): Task {\n  const clean = taskId.trim()\n  const found = room().state.tasks.find((t) => t.id === clean)`,
    replace: `export function getTaskById(taskId: string): Task {\n  const clean = taskId.trim()\n  const found = snapshotTasks(room().state.tasks).find((t) => t.id === clean)`,
  },
  {
    id: "plain-title-not-checked",
    artery: "7. 提问和验收",
    file: "lib/store.ts",
    desc: "agent 建待办时标题和步骤不再检查，夹着文件名、命令、编号的也放进右栏（「说人话」）",
    expectedTest: "夹着代码的标题该被退回并带改法",
    find: `  if (options.plain !== false) {\n    requirePlain(actor, "标题", title)`,
    replace: `  if (options.plain !== false && false) {\n    requirePlain(actor, "标题", title)`,
  },
  {
    id: "plain-review-note-not-checked",
    artery: "7. 提问和验收",
    file: "lib/store.ts",
    desc: "请验收的说明第一句不再检查，用户在验收卡上读到的又是文件名和命令（「说人话」）",
    expectedTest: "验收说明第一句夹代码该被退回",
    find: `    requirePlain(actor, "验收说明", note)\n`,
    replace: `    void note\n`,
  },
  {
    id: "plain-checks-the-user",
    artery: "7. 提问和验收",
    file: "lib/store.ts",
    desc: "「说人话」连用户自己在页面上建的待办也拦（只该管 agent）",
    expectedTest: "用户自己建的待办不该被检查",
    find: `  if (actor.type !== "agent" || !text) return\n  const fault`,
    replace: `  if (!text) return\n  const fault`,
  },
  {
    id: "permit-plain-dropped",
    artery: "5. 权限卡片与用户口令",
    file: "app/api/v1/permit/route.ts",
    desc: "权限请求不再带那句人话，权限卡又只剩原始工具名和命令（「说人话」）",
    expectedTest: "权限卡要先有一句人话",
    find: `, plain: { action: toolAction(tool, body.input), why: toolWhy(body.input) } },`,
    replace: ` },`,
  },
  {
    id: "autowake-no-max-cap",
    artery: "1. 叫醒和队列",
    file: "lib/continue.ts",
    desc: "停着欠活自动叫醒去掉最多 2 次上限（MAX_TRIES），导致无限循环叫醒烧额度",
    expectedTest: "（scripts/test-continue.mjs）同一批欠活最多叫 2 次，绝不能叫第 3 次",
    test: "scripts/test-continue.mjs",
    find: `          if (entry.count < MAX_TRIES) {`,
    replace: `          if (true || entry.count < MAX_TRIES) {`,
  },
  {
    id: "autowake-ignores-user-stop",
    artery: "1. 叫醒和队列",
    file: "lib/continue.ts",
    desc: "自动续做忽略用户点停止标记（isSeatUserStopped），用户手动停下后仍偷偷叫醒",
    expectedTest: "（scripts/test-continue.mjs）用户点停止的那一轮之后，绝不该自动叫醒",
    test: "scripts/test-continue.mjs",
    find: `          if (isSeatUserStopped(seat.id)) continue`,
    replace: `          if (false && isSeatUserStopped(seat.id)) continue`,
  },
  {
    id: "autowake-before-boot",
    artery: "1. 叫醒和队列",
    file: "lib/continue.ts",
    desc: "自动续做去掉启动前存量拦截（owes.since < s.bootAt），导致房间启动两分钟后把各项目几天前的旧欠活全部叫起来",
    expectedTest: "（scripts/test-continue.mjs）房间启动之前就已经停着的旧欠活绝不该自动叫醒",
    test: "scripts/test-continue.mjs",
    find: `          if ((seat.owes?.since ?? 0) < s.bootAt) continue`,
    replace: `          if (false && (seat.owes?.since ?? 0) < s.bootAt) continue`,
  },
  {
    id: "watch-nudge-as-human",
    artery: "6. 权限卡片、用户口令与前台跨项目守卫",
    file: "lib/store.ts",
    desc: "盯着的项目里前台直接催统筹的那句话被标成了用户名义（authorId: \"human\"），越权冒充用户下指令",
    expectedTest: "（scripts/test-watch.mjs）直接发出的消息 authorId 绝不能是 human",
    test: "scripts/test-watch.mjs",
    find: `  const message = appendMessage({\n    kind: "chat",\n    authorId: "front",\n    authorName: "前台",`,
    replace: `  const message = appendMessage({\n    kind: "chat",\n    authorId: "human",\n    authorName: "前台",`,
  },
  {
    id: "watch-nudge-unwatched-direct",
    artery: "6. 权限卡片、用户口令与前台跨项目守卫",
    file: "lib/front-relay.ts",
    desc: "没设盯防的项目调 bench_nudge 也跳过草稿卡片直接往目标项目发消息",
    expectedTest: "（scripts/test-watch.mjs）没盯的项目调 bench_nudge 必须只出 draft 草稿卡片",
    test: "scripts/test-watch.mjs",
    find: `      const directToCoord = Boolean(watched && watched.seatId === seat.id)`,
    replace: `      const directToCoord = true || Boolean(watched && watched.seatId === seat.id)`,
  },
  {
    id: "watch-reports-every-sweep",
    artery: "6. 权限卡片、用户口令与前台跨项目守卫",
    file: "lib/patrol.ts",
    desc: "盯着的项目同一次停下不再只报一次，每次巡查都把前台叫过来看",
    expectedTest: "（scripts/test-watch.mjs）同一次停下，过 40 分钟不该再报",
    test: "scripts/test-watch.mjs",
    find: "    key: `watch:${project.id}:${idleSince}`,",
    replace: "    key: `watch:${project.id}:${now}`,",
  },
  {
    id: "watch-hung-counts-as-working",
    artery: "6. 权限卡片、用户口令与前台跨项目守卫",
    file: "lib/patrol.ts",
    desc: "一轮开着却很久没动静的席位仍当它在干活，挂住几个小时前台也不来看",
    expectedTest: "（scripts/test-watch.mjs）一轮开着但 30 分钟没动静，应当它停了报给前台",
    test: "scripts/test-watch.mjs",
    find: "  const hung = realSeats.filter((s) => Boolean(s.runId) &&",
    replace: "  const hung = realSeats.filter((s) => false && Boolean(s.runId) &&",
  },
]

const COPY_ITEMS = [
  "app",
  "components",
  "lib",
  "public",
  "scripts",
  "types",
  "agents.json",
  "instrumentation.ts",
  "next.config.ts",
  "package.json",
  "package-lock.json",
  "postcss.config.mjs",
  "tsconfig.json",
]

function parseArgs(argv) {
  const only = []
  let port = Number(process.env.BENCH_FAULT_PORT || 4495)
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--only" && argv[i + 1]) {
      only.push(...argv[++i].split(",").map((s) => s.trim()).filter(Boolean))
    } else if (argv[i] === "--port" && argv[i + 1]) {
      port = Number(argv[++i])
    }
  }
  return { only, port }
}

function createIsolatedCopy(repoRoot, copyDir) {
  rmSync(copyDir, { recursive: true, force: true })
  mkdirSync(copyDir, { recursive: true })
  for (const item of COPY_ITEMS) {
    const src = path.join(repoRoot, item)
    if (!existsSync(src)) continue
    cpSync(src, path.join(copyDir, item), { recursive: true })
  }
  // Use hard-linked directory tree (`cp -al`) so Turbopack sees `node_modules`
  // inside the workspace root without duplicating disk space.
  const cpRes = spawnSync("cp", ["-al", path.join(repoRoot, "node_modules"), path.join(copyDir, "node_modules")])
  if (cpRes.status !== 0) {
    cpSync(path.join(repoRoot, "node_modules"), path.join(copyDir, "node_modules"), { recursive: true })
  }
  mkdirSync(path.join(copyDir, "data"), { recursive: true })
  mkdirSync(path.join(copyDir, "state"), { recursive: true })
}

async function waitServerReady(port, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/room`)
      if (res.ok) return
    } catch {}
    await new Promise((r) => setTimeout(r, 350))
  }
  throw new Error(`测试副本服务在端口 ${port} 启动超时（${timeoutMs}ms）`)
}

async function warmServer(port) {
  // Give the filesystem watcher + Turbopack a moment to notice the edit and recompile.
  await new Promise((r) => setTimeout(r, 1200))
  for (let i = 0; i < 2; i++) {
    try {
      await fetch(`http://127.0.0.1:${port}/api/v1/room`)
      await fetch(`http://127.0.0.1:${port}/api/v1/retry`)
    } catch {}
    await new Promise((r) => setTimeout(r, 250))
  }
}

function cleanEnv(extra = {}) {
  const next = { ...process.env }
  for (const k of Object.keys(next)) {
    if (k.startsWith("BENCH_")) delete next[k]
  }
  for (const k of [
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDECODE",
    "ANTIGRAVITY_CONVERSATION_ID",
    "CODEX_THREAD_ID",
    "CURSOR_AGENT_CHAT_ID",
    "DSH_SESSION_ID",
  ]) {
    delete next[k]
  }
  return { ...next, ...extra }
}

// test-room.mjs against the copy's server, or a fault's own `test` (one that
// runs the room's code in its own process, like scripts/test-first.mjs).
function runRoomTest(copyDir, port, dataDir, script = "scripts/test-room.mjs") {
  const startedAt = Date.now()
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], {
      cwd: copyDir,
      env: cleanEnv({
        BENCH_PORT: String(port),
        BENCH_URL: `http://127.0.0.1:${port}`,
        BENCH_DATA_DIR: dataDir,
        BENCH_KEY_FILE: path.join(dataDir, "human-key"),
        XDG_STATE_HOME: path.join(copyDir, "state"),
        BENCH_RETRY_MS: "400,800",
        BENCH_GIST_MS: "500",
        BENCH_PUSH_MERGE_MS: "600",
        BENCH_PUSH_PERMIT_MS: "1200",
      }),
      stdio: ["ignore", "pipe", "pipe"],
    })
    let out = ""
    let err = ""
    child.stdout.on("data", (d) => {
      out += d.toString()
    })
    child.stderr.on("data", (d) => {
      err += d.toString()
    })
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL")
      } catch {}
    }, 180_000)
    child.on("close", (status) => {
      clearTimeout(timer)
      const elapsedMs = Date.now() - startedAt
      const combined = `${err}\n${out}`.trim()
      const lastLine =
        combined
          .split("\n")
          .map((l) => l.trim())
          .filter(
            (l) =>
              l &&
              !l.startsWith("(node:") &&
              !l.startsWith("Reparsing") &&
              !l.startsWith("To eliminate") &&
              !l.startsWith("(Use "),
          )
          .at(-1) || ""
      resolve({
        ok: status === 0,
        status,
        elapsedMs,
        summary: lastLine.slice(0, 160),
        output: combined,
      })
    })
  })
}

async function main() {
  const repoRoot = process.cwd()
  const { only, port } = parseArgs(process.argv.slice(2))
  const selected = only.length > 0 ? FAULTS.filter((f) => only.includes(f.id)) : FAULTS
  if (selected.length === 0) {
    throw new Error(`没有匹配的故障项（可选：${FAULTS.map((f) => f.id).join(", ")}）`)
  }

  // Verify every fault target exists uniquely in the current repo before spinning up a server.
  for (const fault of selected) {
    const src = readFileSync(path.join(repoRoot, fault.file), "utf8")
    const occurrences = src.split(fault.find).length - 1
    if (occurrences !== 1) {
      throw new Error(`故障 [${fault.id}] 在 ${fault.file} 中匹配到 ${occurrences} 处（必须恰好为 1 处）`)
    }
  }

  const copyBase = path.join(os.homedir(), ".cache", "bench-copies")
  mkdirSync(copyBase, { recursive: true })
  const copyDir = path.join(copyBase, `faults-${process.pid}`)
  const dataDir = path.join(copyDir, "data")

  console.log(`[1/3] 创建隔离测试副本：${copyDir}（端口 ${port}）`)
  createIsolatedCopy(repoRoot, copyDir)

  const logFd = openSync(path.join(copyDir, "dev.log"), "a")
  const server = spawn("npx", ["next", "dev", "-H", "127.0.0.1", "-p", String(port)], {
    cwd: copyDir,
    env: cleanEnv({
      BENCH_DATA_DIR: dataDir,
      XDG_STATE_HOME: path.join(copyDir, "state"),
      BENCH_URL: `http://127.0.0.1:${port}`,
      BENCH_RETRY_MS: "400,800",
      BENCH_GIST_MS: "500",
      BENCH_PUSH_MERGE_MS: "600",
      BENCH_PUSH_PERMIT_MS: "1200",
    }),
    stdio: ["ignore", logFd, logFd],
    detached: true,
  })
  closeSync(logFd)

  const killServer = () => {
    try {
      if (server.pid) process.kill(-server.pid, "SIGKILL")
    } catch {}
    try {
      server.kill("SIGKILL")
    } catch {}
  }

  const results = []
  try {
    await waitServerReady(port)
    console.log(`[2/3] 运行干净基线测试（scripts/test-room.mjs）…`)
    const baseline = await runRoomTest(copyDir, port, dataDir)
    if (!baseline.ok) {
      console.error(baseline.output)
      throw new Error(`干净副本基线测试未通过（退出码 ${baseline.status}）：${baseline.summary}`)
    }
    console.log(`      ✓ 干净基线通过（${(baseline.elapsedMs / 1000).toFixed(1)}s）`)

    console.log(`[3/3] 逐个注入 ${selected.length} 处故障并运行测试（测试必须失败才算抓到）…`)
    for (const fault of selected) {
      const targetPath = path.join(copyDir, fault.file)
      const original = readFileSync(targetPath, "utf8")
      let testRes
      try {
        const mutated = original.replace(fault.find, fault.replace)
        if (mutated === original) {
          throw new Error(`故障 [${fault.id}] 替换未生效`)
        }
        writeFileSync(targetPath, mutated, "utf8")
        await warmServer(port)
        testRes = await runRoomTest(copyDir, port, dataDir, fault.test)
      } finally {
        writeFileSync(targetPath, original, "utf8")
        await warmServer(port)
      }

      const caught = !testRes.ok
      results.push({
        id: fault.id,
        artery: fault.artery,
        file: fault.file,
        desc: fault.desc,
        expectedTest: fault.expectedTest,
        caught,
        elapsedMs: testRes.elapsedMs,
        errorSummary: caught ? testRes.summary : "（测试未报错，退出码 0）",
      })
      const badge = caught ? "✓ 抓到" : "✗ 漏掉"
      console.log(`      ${badge} [${fault.id}] (${(testRes.elapsedMs / 1000).toFixed(1)}s) → ${caught ? testRes.summary : "未失败！"}`)
    }
  } finally {
    killServer()
    await new Promise((r) => setTimeout(r, 300))
    try {
      spawnSync("rm", ["-rf", copyDir])
    } catch {}
  }

  console.log("\n## 故障注入测试结果表\n")
  console.log("| 故障 ID | 所属要害 | 文件 | 故障说明 | 预期抓到它的测试 | 结果 | 实测报错摘要 |")
  console.log("| --- | --- | --- | --- | --- | --- | --- |")
  for (const r of results) {
    const statusText = r.caught ? "✓ 抓到" : "✗ 漏掉"
    const cleanErr = r.errorSummary.replace(/\|/g, "\\|")
    console.log(`| \`${r.id}\` | ${r.artery} | \`${r.file}\` | ${r.desc} | ${r.expectedTest} | ${statusText} | ${cleanErr} |`)
  }

  const missed = results.filter((r) => !r.caught)
  if (missed.length > 0) {
    throw new Error(`有 ${missed.length} 处故障未被测试抓到：${missed.map((m) => m.id).join(", ")}`)
  }
  console.log(`\n全部 ${results.length} 处要害故障均被测试抓到，副本已还原并清理。`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
