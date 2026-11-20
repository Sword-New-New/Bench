#!/usr/bin/env node
// Install or remove the Linux desktop launcher (applications/bench.desktop) and
// optional login autostart entry (autostart/bench.desktop) using paths resolved
// dynamically from this checkout.
import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import readline from "node:readline"
import { fileURLToPath } from "node:url"

const argv = process.argv.slice(2)
const remove = argv.includes("--remove") || argv.includes("-r")
const noAutostart = argv.includes("--no-autostart")
const forceAutostart = argv.includes("--autostart")

if (argv.includes("--help") || argv.includes("-h")) {
  console.log("用法：npm run setup [-- --no-autostart | --autostart | --remove]")
  process.exit(0)
}

if (process.platform === "win32") {
  console.log("Windows 上不需要 .desktop 图标：直接双击项目里的 start.bat 即可打开并坐。")
  console.log("想放桌面图标或开机自启：右键 start.bat →「创建快捷方式」，放到桌面或启动文件夹（Win+R 运行 shell:startup）。")
  process.exit(1)
}

if (process.platform !== "linux") {
  console.log("`npm run setup` 的桌面图标和登录自启仅适用于 Linux 桌面环境。")
  console.log("macOS 请直接运行 ./start.sh，或按系统「登录项」自行添加。")
  process.exit(1)
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const home = os.homedir()
const dataHome = process.env.XDG_DATA_HOME || path.join(home, ".local", "share")
const configHome = process.env.XDG_CONFIG_HOME || path.join(home, ".config")
const appDir = path.join(dataHome, "applications")
const autoDir = path.join(configHome, "autostart")
const appFile = path.join(appDir, "bench.desktop")
const autoFile = path.join(autoDir, "bench.desktop")
const tmuxBin = process.env.BENCH_TMUX_BIN || "tmux"

function refreshDesktopDb() {
  if (spawnSync("update-desktop-database", ["-q", appDir], { stdio: "ignore" }).error) {
    // update-desktop-database is optional on minimal environments.
  }
}

if (remove) {
  let removed = 0
  for (const file of [appFile, autoFile]) {
    if (existsSync(file)) {
      rmSync(file)
      console.log(`已移除 ${file}`)
      removed++
    }
  }
  if (removed > 0) refreshDesktopDb()
  else console.log("没有发现已安装的桌面图标或开机自启文件。")
  process.exit(0)
}

const tmuxCheck = spawnSync(tmuxBin, ["-V"], { stdio: "ignore" })
if (tmuxCheck.error || tmuxCheck.status !== 0) {
  console.error("缺少 tmux，桌面图标和开机自启需要在 tmux 后台会话里启动并坐。")
  console.error("请先安装 tmux 后重试：")
  console.error("  Ubuntu / Debian：sudo apt install tmux")
  console.error("  Fedora / RHEL：  sudo dnf install tmux")
  console.error("  Arch Linux：     sudo pacman -S tmux")
  console.error("（如果只想在终端里用，不装 tmux 也能直接运行 ./start.sh。）")
  process.exit(1)
}

const startScript = path.join(root, "scripts", "start-bench.sh")
const iconPath = path.join(root, "public", "bench.png")
if (!existsSync(startScript)) {
  console.error(`找不到启动脚本 ${startScript}`)
  process.exit(1)
}

const quoteExec = (file) => (/\s/.test(file) ? `"${file.replace(/"/g, '\\"')}"` : file)
const desktopEntry = (autostart = false) =>
  [
    "[Desktop Entry]",
    "Version=1.0",
    "Type=Application",
    "Name=并坐",
    "GenericName=Agent 房间",
    "Comment=打开这台电脑上的 agent 共用房间",
    `Exec=${quoteExec(startScript)}${autostart ? " --background" : ""}`,
    ...(existsSync(iconPath) ? [`Icon=${iconPath}`] : []),
    "Terminal=false",
    "Categories=Network;",
    "Keywords=bench;agent;room;并坐;",
    "StartupNotify=true",
    ...(autostart ? ["X-GNOME-Autostart-enabled=true"] : []),
    "",
  ].join("\n")

mkdirSync(appDir, { recursive: true })
writeFileSync(appFile, desktopEntry(false), "utf8")
chmodSync(appFile, 0o755)
refreshDesktopDb()
console.log(`✓ 已安装桌面图标：${appFile}`)

async function askAutostart() {
  if (noAutostart) return false
  if (forceAutostart) return true
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => {
    let answered = false
    rl.question("是否设为登录后自动启动并坐？[y/N] ", (answer) => {
      answered = true
      rl.close()
      resolve(/^(?:y|yes|是)$/i.test(answer.trim()))
    })
    rl.on("close", () => {
      if (!answered) resolve(false)
    })
  })
}

const wantAuto = await askAutostart()
if (wantAuto) {
  mkdirSync(autoDir, { recursive: true })
  writeFileSync(autoFile, desktopEntry(true), "utf8")
  chmodSync(autoFile, 0o755)
  console.log(`✓ 已启用开机自动启动：${autoFile}`)
} else {
  console.log("未启用开机自动启动（需要时可再运行 npm run setup，或卸载时运行 npm run setup -- --remove）。")
}
