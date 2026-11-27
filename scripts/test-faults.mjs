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
    id: "summary-auto-cuts-in",
    artery: "1. 叫醒和队列",
    file: "lib/summary-auto.ts",
    desc: "摘要到期自动找人写时不看席位忙不忙，正在干活的也被叫去写摘要",
    expectedTest: "（scripts/test-summary-auto.mjs）唯一的席位在干活：不打断，等它",
    test: "scripts/test-summary-auto.mjs",
    find: `        const pick = left.find((seat) => free(seat, limited, now))`,
    replace: `        const pick = left[0]`,
  },
  {
    id: "summary-auto-no-cap",
    artery: "1. 叫醒和队列",
    file: "lib/summary-auto.ts",
    desc: "摘要没写成时不封顶，同一次到期一个接一个叫个没完、烧额度",
    expectedTest: "（scripts/test-summary-auto.mjs）同一次到期最多叫两个人",
    test: "scripts/test-summary-auto.mjs",
    find: `          if (entry.tries.length >= MAX_TRIES) {`,
    replace: `          if (false) {`,
  },
  {
    id: "summary-auto-wakes-stale",
    artery: "1. 叫醒和队列",
    file: "lib/summary-auto.ts",
    desc: "启动前就到期、之后没人说过话的项目也自动叫人写摘要，代码一生效几个项目一起叫起来",
    expectedTest: "（scripts/test-summary-auto.mjs）启动前就到期、启动后没人说过话的不叫",
    test: "scripts/test-summary-auto.mjs",
    find: `          if (!talkSinceBoot(snap, s.bootAt)) return`,
    replace: `          if (false) return`,
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
  {
    id: "watch-blocked-counts-as-unfinished",
    artery: "6. 权限卡片、用户口令与前台跨项目守卫",
    file: "lib/patrol.ts",
    desc: "盯着的项目把卡住（blocked）的旧待办也算进没做完，只剩卡住旧单时连报「全停了还有 N 件没做完」",
    expectedTest: "（scripts/test-watch.mjs）只剩卡住和等验收待办时绝不该误报全停没做完",
    test: "scripts/test-watch.mjs",
    find: '  const unfinishedWork = snap.tasks.filter((t) => t.status !== "done" && t.status !== "blocked" && !awaitingReview(t))',
    replace: '  const unfinishedWork = snap.tasks.filter((t) => t.status !== "done" && !awaitingReview(t))',
  },
  {
    id: "agy-replied-never-ended",
    artery: "1. 叫醒和队列",
    file: "lib/summon.ts",
    desc: "Antigravity 说完最后一句却不退出也不报结束时，房间一直等着，席位几个小时显示在做",
    expectedTest: "（scripts/test-agy-end.mjs）说完的一轮被收掉",
    test: "scripts/test-agy-end.mjs",
    find: `    if (replied && now - replied >= repliedEnd) {`,
    replace: `    if (false && replied && now - replied >= repliedEnd) {`,
  },
  {
    id: "quiet-run-killed-mid-tool",
    artery: "1. 叫醒和队列",
    file: "lib/events.ts",
    desc: "安静一阵就当说完了，把还在跑工具的一轮也收掉（只有用户能停一轮）",
    expectedTest: "（scripts/test-agy-end.mjs）工具没回来的一轮不能被房间收掉",
    test: "scripts/test-agy-end.mjs",
    find: `      repliedAt = step.step_type === "agent_response" && step.state !== "ACTIVE" ? Date.now() : undefined`,
    replace: `      repliedAt = Date.now()`,
  },
  {
    id: "limit-resume-wakes-each-run",
    artery: "1. 叫醒和队列",
    file: "lib/summon.ts",
    desc: "额度恢复时，同一个席位被拦下的每一轮各叫一次，多烧额度",
    expectedTest: "（scripts/test-limit-resume.mjs）两轮被拦下的活应一次叫醒带上",
    test: "scripts/test-limit-resume.mjs",
    find: `          takeBack(item, agent, queue)\n          taken++`,
    replace: `          takeBack(item, agent, queue)\n          taken++\n          run(agent.id)`,
  },
  {
    id: "limit-schedule-unwakeable",
    artery: "1. 叫醒和队列",
    file: "lib/summon.ts",
    desc: "到点叫不回去的检查也能定时，到点一行行报没成功",
    expectedTest: "（scripts/test-limit-resume.mjs）检查撞额度的卡不能定时",
    test: "scripts/test-limit-resume.mjs",
    find: `      if (!rewakeable(item)) {\n        throw new ApiError(400, item.purpose === "check"`,
    replace: `      if (false && !rewakeable(item)) {\n        throw new ApiError(400, item.purpose === "check"`,
  },
  {
    id: "check-stale-no-repick",
    artery: "8. 检查不会永远排队",
    file: "lib/summon.ts",
    desc: "排队很久没开始的检查不换人，一直挂在不动的席位上",
    expectedTest: "（scripts/test-check-queue.mjs）排久了应换到空着的席位上查",
    test: "scripts/test-check-queue.mjs",
    find: `          if (now - (check.queuedAt ?? check.at) >= checkStaleMs()) repickCheck(task.id, "stale")`,
    replace: `          void checkStaleMs`,
  },
  {
    id: "check-limit-no-repick",
    artery: "8. 检查不会永远排队",
    file: "lib/summon.ts",
    desc: "检查人撞了额度不换人，检查直接落成没跑成",
    expectedTest: "（scripts/test-check-queue.mjs）检查人撞额度应马上换到有额度的席位",
    test: "scripts/test-check-queue.mjs",
    find: `    if (limited) repickCheck(item.taskId, "limit", agent.id)\n    else if (stopped)`,
    replace: `    if (limited) setTaskCheck(item.taskId, item.at, { state: "error", note: "复验没跑成：撞额度" })\n    else if (stopped)`,
  },
  {
    id: "check-verdicts-not-batched",
    artery: "8. 检查不会永远排队",
    file: "lib/summon.ts",
    desc: "每出一件检查结论就叫一次前台，不攒着一次说全，白烧前台额度",
    expectedTest: "（scripts/test-check-queue.mjs）两件结论应攒成一次叫前台",
    test: "scripts/test-check-queue.mjs",
    find: `  entry.ids.add(taskId)\n  all.set(project, entry)`,
    replace: `  entry.ids.add(taskId)\n  all.set(project, entry)\n  if (entry.ids) return void tellChecksSettled(project)`,
  },
  {
    id: "recheck-no-limit",
    artery: "7. 提问和验收",
    file: "lib/store.ts",
    desc: "没过的待办改了再请验收，重查不设上限，同一件能被一直查下去烧额度",
    expectedTest: "（scripts/test-room.mjs）第三次请验收不该再重查",
    find: "(before.round ?? 0) < RECHECK_MAX",
    replace: "true",
  },
  {
    id: "recheck-pass-auto-accepted",
    artery: "7. 提问和验收",
    file: "lib/review.ts",
    desc: "上次没过、改了再查通过的待办被房间或前台自动收下，用户没看到",
    expectedTest: "（scripts/test-deputy.mjs）重查通过归到要你看的一栏，不自动收下",
    test: "scripts/test-deputy.mjs",
    find: "  if (check.prev) return { lane: \"look\",",
    replace: "  if (check.prev && false) return { lane: \"look\",",
  },
  {
    id: "rerun-drops-recheck",
    artery: "7. 提问和验收",
    file: "lib/store.ts",
    desc: "重查没跑成、前台补跑时丢了上一次的结论，补跑通过后被自动收下",
    expectedTest: "（scripts/test-deputy.mjs）补跑后还带着上一次的结论，通过也不自动收下",
    test: "scripts/test-deputy.mjs",
    find: "const carried = task.check?.prev ? { prev: task.check.prev, round: task.check.round } : null",
    replace: "const carried = null as { prev: TaskCheck[\"prev\"]; round?: number } | null",
  },
  {
    id: "passed-check-rechecked",
    artery: "7. 提问和验收",
    file: "lib/store.ts",
    desc: "已经通过的检查，负责人再请验收一次就又查一遍，白烧额度",
    expectedTest: "（scripts/test-room.mjs）重查通过后再请验收不再查",
    find: "const recheck = again && before && (before.state === \"failed\" || before.state === \"unverified\")",
    replace: "const recheck = again && before && (before.state === \"failed\" || before.state === \"unverified\" || before.state === \"passed\")",
  },
  {
    id: "waiting-limited-not-merged",
    artery: "7. 提问和验收",
    file: "lib/waiting.ts",
    desc: "「等你定」里同一个席位撞额度的每一张都各出一张卡（11-17 傍晚 5 张一模一样）",
    expectedTest: "同一个席位 5 张额度卡合成一张，写 5 次",
    find: `      for (const group of groupLimited(snap.messages)) limited.push({ ...meta, ...group })`,
    replace: `      for (const message of snap.messages) if (isPendingLimited(message)) limited.push({ ...meta, message, count: 1 })`,
  },
  {
    id: "waiting-older-limited-kept",
    artery: "7. 提问和验收",
    file: "lib/store.ts",
    desc: "额度卡被处理（叫醒、换客户端、忽略、定时）后，同席位旧的几张还开着、之后又冒出来",
    expectedTest: "处理最新一张，同席位旧的 4 张一起算处理了",
    find: `settleOlderLimited(current.state.messages, message)\n    bumpRev()`,
    replace: `void 0\n    bumpRev()`,
  },
  {
    id: "waiting-limited-count-old-ledger",
    artery: "7. 提问和验收",
    file: "lib/waiting-shared.ts",
    desc: "「共撞了 N 次」把上一轮已经翻篇的旧卡也算进去（早上连撞 5 次翻了篇，晚上新撞 1 次写成 6 次）",
    expectedTest: "上一轮的旧账不算",
    find: `    while (from > 0 && isPendingLimited(ordered[from - 1])) from--`,
    replace: `    from = 0`,
  },
  {
    id: "waiting-reviews-unsorted",
    artery: "7. 提问和验收",
    file: "lib/waiting-shared.ts",
    desc: "验收不按「查出问题的排前、等得久的排前」排",
    expectedTest: "验收：查出问题的排前，其余等得久的排前",
    find: `  const rank = (row: DigestRow) => (row.check?.state === "failed" ? 0 : 1)`,
    replace: `  const rank = (row: DigestRow) => (row.check?.state === "failed" ? 0 : 0)`,
  },
  {
    id: "stale-ask-not-told",
    artery: "7. 提问和验收",
    file: "lib/store.ts",
    desc: "几天前的提问被回答时，送给提问席位的话前面不再说明这是几天前的提问",
    expectedTest: "4 天前的提问：送给席位的回答前面加了一句",
    find: `  if (days > 0) {\n    reply.text =`,
    replace: `  if (false && days > 0) {\n    reply.text =`,
  },
  {
    id: "batch-settled-blocks-you",
    artery: "6. 权限卡片、用户口令与前台跨项目守卫",
    file: "lib/front-relay.ts",
    desc: "只剩「只能你签」导致卡片标为了结后，settleRelay 误拦剩下的「只能你签」行点通过",
    expectedTest: "（scripts/test-deputy.mjs）已了结卡片上剩下的「只能你签」还能逐件点通过",
    test: "scripts/test-deputy.mjs",
    find: "  const canPassRemaining =\n    relay.kind === \"batch\" &&\n    action === \"pass\" &&",
    replace: "  const canPassRemaining =\n    false &&\n    relay.kind === \"batch\" &&\n    action === \"pass\" &&",
  },
  {
    id: "batch-only-you-stays-open",
    artery: "6. 权限卡片、用户口令与前台跨项目守卫",
    file: "lib/front-relay.ts",
    desc: "整批栏处理完只剩「只能你签」时卡片仍保持 draft 开着，新卡进来时误把旧卡收起折叠",
    expectedTest: "（scripts/test-deputy.mjs）只剩「只能你签」的旧卡不挡新卡，也不会被新卡吞掉收起",
    test: "scripts/test-deputy.mjs",
    find: "  const settled = batchOnlyYouLeft(items)",
    replace: "  const settled = items.every((item) => Boolean(item.state))",
  },
  {
    id: "issue-pass-no-record",
    artery: "6. 权限卡片、用户口令与前台跨项目守卫",
    file: "lib/store.ts",
    desc: "用户通过检查没过、没查成或没检查的待办时漏记 review.issue 和带着问题收下记录",
    expectedTest: "（scripts/test-deputy.mjs）通过检查没过的待办应记 review.issue、历史「带着问题收下」和清单",
    test: "scripts/test-deputy.mjs",
    find: "    const issue = pass ? reviewIssueOf(task) : undefined",
    replace: "    const issue = undefined",
  },
  {
    id: "backup-prune-deletes-newest",
    artery: "3. 存储和搜索索引",
    file: "lib/backup.ts",
    desc: "清理超额备份时切反方向，把刚留出来的最新备份删掉、只留最旧的",
    expectedTest: "（scripts/test-backup.mjs）第 8 份出来后应删掉最旧的第 1 份并保留最新的第 2..8 份",
    test: "scripts/test-backup.mjs",
    find: "  const toRemove = good.slice(0, good.length - keep)",
    replace: "  const toRemove = good.slice(keep)",
  },
  {
    id: "backup-bad-replaces-good",
    artery: "3. 存储和搜索索引",
    file: "lib/backup.ts",
    desc: "新备份跳过只读 quick_check 与非空核对就直接转正落盘，坏的一份顶掉旧的好备份",
    expectedTest: "（scripts/test-backup.mjs）新的一份是坏的时候校验不通过、旧的 7 份好备份一份不少",
    test: "scripts/test-backup.mjs",
    find: "  let ro: DatabaseSync | undefined\n  try {\n    ro = new DatabaseSync(filePath, { readOnly: true })",
    replace: "  if (st.size >= 0) return { ok: true, projects: 1, messages: 1, tasks: 0 }\n  let ro: DatabaseSync | undefined\n  try {\n    ro = new DatabaseSync(filePath, { readOnly: true })",
  },
  {
    id: "restore-no-save-before",
    artery: "3. 存储和搜索索引",
    file: "scripts/restore-bench.mjs",
    desc: "找回数据时动手前没把当前的 bench.db / -wal / -shm 另存成 before-restore 就直接覆盖",
    expectedTest: "（scripts/test-backup.mjs）找回前必须将原数据库与 WAL 另存为 bench.db.before-restore-<时间>*",
    test: "scripts/test-backup.mjs",
    find: "  const saved = saveExistingDbBeforeRestore(liveDb)",
    replace: "  rmSync(`${liveDb}-wal`, { force: true }); rmSync(`${liveDb}-shm`, { force: true }); const saved = null",
  },
  {
    id: "restore-ignores-data-dir-port",
    artery: "3. 存储和搜索索引",
    file: "scripts/restore-bench.mjs",
    desc: "找回数据时只看 BENCH_URL 端口而不检查仓库默认 data/ 对应的房间端口，在房间开着时换掉数据库",
    expectedTest: "（scripts/test-backup.mjs）BENCH_URL 指向空端口但数据目录对应的房间开在默认端口时必须拒绝找回",
    test: "scripts/test-backup.mjs",
    find: "  if (isRepoDataDir) {\n    addTarget(\"127.0.0.1\", defaultPort, `http://127.0.0.1:${defaultPort}`)\n  }",
    replace: "  if (false && isRepoDataDir) {\n    addTarget(\"127.0.0.1\", defaultPort, `http://127.0.0.1:${defaultPort}`)\n  }",
  },
  {
    id: "backup-hourly-opens-db",
    artery: "3. 存储和搜索索引",
    file: "lib/backup.ts",
    desc: "每小时检查是否满 24 小时时把全部备份逐个打开跑 quick_check，在主线程造成卡顿",
    expectedTest: "（scripts/test-backup.mjs）未到期的每小时检查只看文件名和 mtime，不打开任何备份文件",
    test: "scripts/test-backup.mjs",
    find: "    const latest = listBackupCandidates().at(-1)",
    replace: "    const latest = listVerifiedBackups().at(-1)",
  },
  {
    id: "run-steps-cascade-wipe",
    artery: "3. 存储和搜索索引",
    file: "lib/db.ts",
    desc: "dbSaveRunMeta 改回 INSERT OR REPLACE INTO runs，在 endRun 更新 runs 时触发外键级联删除清空全部 run_steps",
    expectedTest: "唤起失败后查 /api/v1/runs/:id，run_steps 中的失败说明步骤必须保留不被级联清空",
    find: [
      "  stmt(",
      "    `INSERT INTO runs (",
      "       id, agent_id, agent_name, project_id, purpose, state, started_at, ended_at,",
      "       interrupted, announced, resumed_at, limited_resume_at, data_json",
      "     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      "     ON CONFLICT(id) DO UPDATE SET",
      "       agent_id = excluded.agent_id,",
      "       agent_name = excluded.agent_name,",
      "       project_id = excluded.project_id,",
      "       purpose = excluded.purpose,",
      "       state = excluded.state,",
      "       started_at = excluded.started_at,",
      "       ended_at = excluded.ended_at,",
      "       interrupted = excluded.interrupted,",
      "       announced = excluded.announced,",
      "       resumed_at = excluded.resumed_at,",
      "       limited_resume_at = excluded.limited_resume_at,",
      "       data_json = excluded.data_json`,",
    ].join("\n"),
    replace: [
      "  stmt(",
      "    `INSERT OR REPLACE INTO runs (",
      "       id, agent_id, agent_name, project_id, purpose, state, started_at, ended_at,",
      "       interrupted, announced, resumed_at, limited_resume_at, data_json",
      "     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,",
    ].join("\n"),
  },
  {
    id: "capacity-503-no-retry",
    artery: "1. 叫醒和队列",
    file: "lib/netfail.ts",
    desc: "UNAVAILABLE (code 503): No capacity available 报错不再识别为服务过载/瞬时故障，跳过重试且不转译中文说明",
    expectedTest: "503 模型暂无容量报错应经过 retrying 并写出「服务暂无容量（503）」中文说明",
    find: [
      "const CAPACITY_PATTERNS = [",
      "  /\\bno capacity available\\b/i,",
      "  /\\bservice unavailable\\b/i,",
      "  /\\b(?:unavailable|overloaded)\\b.*\\b(?:503|529)\\b/i,",
      "  /\\b(?:503|529)\\b.*(?:unavailable|overloaded|capacity|service unavailable)/i,",
      "  /\\boverloaded_error\\b/i,",
      "]",
    ].join("\n"),
    replace: "const CAPACITY_PATTERNS: RegExp[] = []",
  },
  {
    id: "failed-reconnect-stays-running-title",
    artery: "1. 叫醒和队列",
    file: "lib/runs.ts",
    desc: "唤起最终失败时，未恢复的 stream-error 步骤仍保留「网络重连中：」标题，与失败 × 图标矛盾",
    expectedTest: "流式重连最终失败后，stream-error 步骤标题应转为「网络重连未恢复：」",
    find: [
      "      if (state === \"failed\" && step.title.startsWith(\"网络重连中：\")) {",
      "        step.title = step.title.replace(/^网络重连中：/, \"网络重连未恢复：\")",
      "      }",
    ].join("\n"),
    replace: [
      "      if (false && state === \"failed\" && step.title.startsWith(\"网络重连中：\")) {",
      "        step.title = step.title.replace(/^网络重连中：/, \"网络重连未恢复：\")",
      "      }",
    ].join("\n"),
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
  // Use hard-linked directory tree (`cp -al`) on POSIX, or multi-threaded robocopy
  // on Windows (Turbopack rejects external directory junctions for node_modules).
  if (process.platform === "win32") {
    const srcNm = path.join(repoRoot, "node_modules")
    const dstNm = path.join(copyDir, "node_modules")
    const rb = spawnSync("robocopy", [srcNm, dstNm, "/E", "/MT:16", "/NFL", "/NDL", "/NJH", "/NJS", "/NC", "/NS", "/NP"], {
      windowsHide: true,
    })
    if (typeof rb.status !== "number" || rb.status >= 8) {
      cpSync(srcNm, dstNm, { recursive: true })
    }
  } else {
    const cpRes = spawnSync("cp", ["-al", path.join(repoRoot, "node_modules"), path.join(copyDir, "node_modules")])
    if (cpRes.status !== 0) {
      cpSync(path.join(repoRoot, "node_modules"), path.join(copyDir, "node_modules"), { recursive: true })
    }
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
        BENCH_RETRY_MS: "1200,1600",
        BENCH_GIST_MS: "500",
        BENCH_CHECK_QUIET_MS: "300",
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
    const limitMs = process.platform === "win32" ? 360_000 : 180_000
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try {
        child.kill("SIGKILL")
      } catch {}
    }, limitMs)
    child.on("close", (status) => {
      clearTimeout(timer)
      const elapsedMs = Date.now() - startedAt
      const combined = `${err}\n${out}`.trim()
      const lines = combined
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
      // An uncaught assertion ends with Node's own banner ("Node.js v24…"),
      // which says nothing: the line that names the error is the one to show.
      const errorLine = lines.findLast((l) => /^[A-Za-z]*Error(?: \[[A-Z_]+\])?: /.test(l))
      const lastLine = errorLine || lines.findLast((l) => !/^Node\.js v\d/.test(l)) || lines.at(-1) || ""
      resolve({
        ok: status === 0,
        status,
        elapsedMs,
        summary: (timedOut ? `超时(${Math.round(limitMs / 1000)}s)：${lastLine}` : lastLine).slice(0, 160),
        output: combined,
      })
    })
  })
}

function matchLineEndings(sample, text) {
  return sample.includes("\r\n") ? text.replace(/\r?\n/g, "\r\n") : text
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
    const find = matchLineEndings(src, fault.find)
    const occurrences = src.split(find).length - 1
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
  const nextBin = path.join(repoRoot, "node_modules", "next", "dist", "bin", "next")
  const server = spawn(process.execPath, [nextBin, "dev", "-H", "127.0.0.1", "-p", String(port)], {
    cwd: copyDir,
    env: cleanEnv({
      BENCH_DATA_DIR: dataDir,
      XDG_STATE_HOME: path.join(copyDir, "state"),
      BENCH_URL: `http://127.0.0.1:${port}`,
      BENCH_RETRY_MS: "1200,1600",
      BENCH_GIST_MS: "500",
      BENCH_CHECK_QUIET_MS: "300",
      BENCH_PUSH_MERGE_MS: "600",
      BENCH_PUSH_PERMIT_MS: "1200",
    }),
    stdio: ["ignore", logFd, logFd],
    detached: process.platform !== "win32",
    windowsHide: true,
  })
  closeSync(logFd)

  const killServer = () => {
    try {
      if (process.platform === "win32" && server.pid) {
        spawnSync("taskkill", ["/PID", String(server.pid), "/T", "/F"], { windowsHide: true })
      } else if (server.pid) {
        process.kill(-server.pid, "SIGKILL")
      }
    } catch {}
    try {
      server.kill("SIGKILL")
    } catch {}
  }

  const results = []
  try {
    await waitServerReady(port, 90_000)
  } catch (err) {
    let devLog = ""
    try {
      devLog = readFileSync(path.join(copyDir, "dev.log"), "utf8")
    } catch {}
    killServer()
    try {
      rmSync(copyDir, { recursive: true, force: true })
    } catch {}
    const excerpt = devLog.length > 3000 ? `${devLog.slice(0, 1500)}\n...\n${devLog.slice(-1500)}` : devLog
    throw new Error(`${err instanceof Error ? err.message : String(err)}\n--- dev.log ---\n${excerpt}`)
  }
  try {
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
        const find = matchLineEndings(original, fault.find)
        const replace = matchLineEndings(original, fault.replace)
        const mutated = original.replace(find, replace)
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
    await new Promise((r) => setTimeout(r, 400))
    try {
      rmSync(copyDir, { recursive: true, force: true })
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
