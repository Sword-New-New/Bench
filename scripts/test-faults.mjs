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

function runRoomTest(copyDir, port, dataDir) {
  const startedAt = Date.now()
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["scripts/test-room.mjs"], {
      cwd: copyDir,
      env: {
        ...process.env,
        BENCH_PORT: String(port),
        BENCH_URL: `http://127.0.0.1:${port}`,
        BENCH_DATA_DIR: dataDir,
        BENCH_KEY_FILE: path.join(dataDir, "human-key"),
        XDG_STATE_HOME: path.join(copyDir, "state"),
        BENCH_RETRY_MS: "400,800",
        BENCH_PUSH_MERGE_MS: "600",
        BENCH_PUSH_PERMIT_MS: "1200",
      },
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
    env: {
      ...process.env,
      BENCH_DATA_DIR: dataDir,
      XDG_STATE_HOME: path.join(copyDir, "state"),
      BENCH_URL: `http://127.0.0.1:${port}`,
      BENCH_RETRY_MS: "400,800",
      BENCH_PUSH_MERGE_MS: "600",
      BENCH_PUSH_PERMIT_MS: "1200",
    },
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
        testRes = await runRoomTest(copyDir, port, dataDir)
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
