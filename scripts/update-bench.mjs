#!/usr/bin/env node
// Update this checkout when its working tree is clean: pull upstream changes
// with --ff-only, ensure dependencies are up to date, and explain how to
// restart without stopping or restarting the live room automatically.
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const gitBin = process.env.BENCH_GIT_BIN || "git"

function runGit(args, stdio = "pipe") {
  return spawnSync(gitBin, args, { cwd: root, encoding: "utf8", stdio })
}

const inside = runGit(["rev-parse", "--is-inside-work-tree"])
if (inside.error || inside.status !== 0 || inside.stdout.trim() !== "true") {
  console.error("当前目录不是 Git 仓库（可能通过压缩包下载），无法运行 npm run update 自动拉取更新。")
  console.error("建议从仓库地址重新 clone，或下载新版代码后运行 node scripts/ensure-deps.mjs 安装依赖。")
  process.exit(1)
}

const status = runGit(["status", "--porcelain"])
if (status.error || status.status !== 0) {
  console.error(`检查工作区状态失败：${status.stderr || status.error?.message || "未知错误"}`)
  process.exit(1)
}

const dirty = status.stdout
  .split("\n")
  .map((line) => line.trimEnd())
  .filter(Boolean)

if (dirty.length > 0) {
  console.error("工作区有未提交的改动，已停下更新，免得覆盖或产生冲突：")
  for (const line of dirty.slice(0, 15)) console.error(`  ${line}`)
  if (dirty.length > 15) console.error(`  ……共 ${dirty.length} 项`)
  console.error("请先提交、备份或还原这些改动后，再重新运行 npm run update。")
  process.exit(1)
}

console.log("工作区干净，正在拉取最新代码…")
const pull = runGit(["pull", "--ff-only"], "inherit")
if (pull.error || pull.status !== 0) {
  console.error("拉取最新代码失败，请检查网络、上游分支设置，或手动处理分叉后重试。")
  process.exit(pull.status && pull.status > 0 ? pull.status : 1)
}

const ensureScript = path.join(root, "scripts", "ensure-deps.mjs")
if (existsSync(ensureScript)) {
  const deps = spawnSync(process.execPath, [ensureScript, "--root", root], { cwd: root, stdio: "inherit" })
  if (deps.error || deps.status !== 0) {
    process.exit(deps.status && deps.status > 0 ? deps.status : 1)
  }
}

console.log("")
console.log("✓ 代码已是最新，依赖也已检查完。")
console.log("重启后生效（现在没有自动重启，以免打断正在干活的 AI）：")
if (process.platform === "win32") {
  console.log("  1. 如果开着并坐，切到它的窗口按 Ctrl+C 或关闭窗口；")
  console.log("  2. 重新双击 start.bat 启动。")
} else {
  console.log("  1. 先停掉当前运行中的房间：npm run stop（有 AI 在干活时会先列出提醒）")
  console.log("  2. 再重新启动：终端运行 ./start.sh（或 npm run dev），或重新点击「并坐」桌面图标。")
}
