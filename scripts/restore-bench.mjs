#!/usr/bin/env node
// Restore data/bench.db from a verified SQLite backup (t_8e27bddd).
// Pure Node (22.13+), cross-platform (Linux / macOS / Windows), no bash needed.

import { spawnSync } from "node:child_process"
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs"
import net from "node:net"
import path from "node:path"
import { createInterface } from "node:readline/promises"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"

const BACKUP_NAME_RE = /^bench-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})\.db$/

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, "..")
const dataDir = process.env.BENCH_DATA_DIR
  ? path.resolve(process.env.BENCH_DATA_DIR)
  : path.join(repoRoot, "data")
const backupsDir = path.join(dataDir, "backups")

const pad2 = (n) => String(n).padStart(2, "0")

function formatStampSec(ms = Date.now()) {
  const d = new Date(ms)
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`
}

function formatHumanTime(ms) {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

function parseBackupName(name) {
  const m = BACKUP_NAME_RE.exec(name)
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  const da = Number(m[3])
  const hh = Number(m[4])
  const mm = Number(m[5])
  const d = new Date(y, mo - 1, da, hh, mm, 0, 0)
  if (
    d.getFullYear() !== y ||
    d.getMonth() + 1 !== mo ||
    d.getDate() !== da ||
    d.getHours() !== hh ||
    d.getMinutes() !== mm
  ) {
    return null
  }
  return d.getTime()
}

function parseArgs(argv) {
  let latest = process.env.npm_config_latest === "true"
  let file = process.env.npm_config_file || ""
  let help = false

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--latest") {
      latest = true
    } else if (arg === "--file") {
      if (!argv[i + 1] || argv[i + 1].startsWith("-")) {
        console.error("参数 --file 后面需要跟备份文件路径。")
        process.exit(2)
      }
      file = argv[++i]
    } else if (arg.startsWith("--file=")) {
      file = arg.slice("--file=".length)
      if (!file) {
        console.error("参数 --file= 后面需要跟备份文件路径。")
        process.exit(2)
      }
    } else if (arg === "--help" || arg === "-h") {
      help = true
    } else {
      console.error(`不认识的参数：${arg}`)
      console.error("用法：npm run restore [-- --latest | --file <备份路径>]")
      process.exit(2)
    }
  }

  if (latest && file) {
    console.error("--latest 和 --file 不能同时使用，请只选其一。")
    process.exit(2)
  }

  return { latest, file, help }
}

function hasSystemPortListener(targetPort) {
  if (process.platform === "win32") {
    const ns = spawnSync("netstat", ["-ano", "-p", "tcp"], { encoding: "utf8" })
    if (!ns.error && ns.status === 0) {
      for (const line of ns.stdout.split(/\r?\n/)) {
        const cols = line.trim().split(/\s+/)
        if (cols.length >= 4 && cols[0].toUpperCase() === "TCP" && cols[3].toUpperCase() === "LISTENING") {
          if (cols[1].endsWith(`:${targetPort}`)) return true
        }
      }
    }
    return false
  }

  const ss = spawnSync("ss", ["-H", "-ltn", `sport = :${targetPort}`], { encoding: "utf8" })
  if (!ss.error && ss.status === 0 && ss.stdout.trim().length > 0) {
    return true
  }

  const lsof = spawnSync("lsof", ["-nP", `-iTCP:${targetPort}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" })
  if (!lsof.error && lsof.status === 0 && lsof.stdout.trim().length > 0) {
    return true
  }

  if (process.platform === "linux") {
    const hexPort = targetPort.toString(16).toUpperCase().padStart(4, "0")
    for (const procFile of ["/proc/net/tcp", "/proc/net/tcp6"]) {
      if (!existsSync(procFile)) continue
      try {
        const lines = readFileSync(procFile, "utf8").split("\n").slice(1)
        for (const line of lines) {
          const cols = line.trim().split(/\s+/)
          if (cols.length >= 4 && cols[3] === "0A" && cols[1].endsWith(`:${hexPort}`)) {
            return true
          }
        }
      } catch {}
    }
  }

  return false
}

function probeTcpConnect(host, port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const targetHost = host === "0.0.0.0" ? "127.0.0.1" : host
    const socket = net.createConnection({ host: targetHost, port })
    let settled = false
    const done = (listening) => {
      if (settled) return
      settled = true
      try {
        socket.destroy()
      } catch {}
      resolve(listening)
    }
    socket.setTimeout(timeoutMs)
    socket.once("connect", () => done(true))
    socket.once("timeout", () => done(false))
    socket.once("error", () => done(false))
  })
}

function normalizePath(p) {
  const abs = path.resolve(p)
  try {
    return realpathSync(abs)
  } catch {}
  const parent = path.dirname(abs)
  try {
    return path.join(realpathSync(parent), path.basename(abs))
  } catch {
    return abs
  }
}

function findPidHoldingDb(targetDataDir) {
  if (process.platform !== "linux" || !existsSync("/proc")) return null
  const dbBase = path.join(targetDataDir, "bench.db")
  const watchPaths = new Set([
    normalizePath(dbBase),
    normalizePath(`${dbBase}-wal`),
    normalizePath(`${dbBase}-shm`),
  ])
  let entries
  try {
    entries = readdirSync("/proc")
  } catch {
    return null
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    const pid = Number(entry)
    if (pid <= 1 || pid === process.pid) continue
    let fds
    try {
      fds = readdirSync(`/proc/${pid}/fd`)
    } catch {
      continue
    }
    for (const fd of fds) {
      let target
      try {
        target = readlinkSync(`/proc/${pid}/fd/${fd}`)
      } catch {
        continue
      }
      const cleaned = target.replace(/ \(deleted\)$/, "")
      if (watchPaths.has(target) || watchPaths.has(cleaned)) {
        return pid
      }
    }
  }
  return null
}

async function isRoomRunning() {
  const holderPid = findPidHoldingDb(dataDir)
  if (holderPid !== null) {
    return {
      running: true,
      detail: `进程 PID ${holderPid} 正打开着 ${path.join(dataDir, "bench.db")}`,
    }
  }

  const targets = new Map()
  const addTarget = (host, port, label) => {
    if (!Number.isInteger(port) || port < 1 || port > 65535) return
    const key = `${host}:${port}`
    if (!targets.has(key)) targets.set(key, { host, port, label })
  }

  const defaultPort = Number(process.env.BENCH_DEFAULT_PORT || 4399)
  const repoDefaultDataDir = path.join(repoRoot, "data")
  const isRepoDataDir = normalizePath(dataDir) === normalizePath(repoDefaultDataDir)
  if (isRepoDataDir) {
    addTarget("127.0.0.1", defaultPort, `http://127.0.0.1:${defaultPort}`)
  }

  const siblingPortFile = path.join(path.dirname(dataDir), "port")
  if (path.basename(dataDir) === "data" && existsSync(siblingPortFile)) {
    try {
      const copyPort = Number(readFileSync(siblingPortFile, "utf8").trim())
      if (Number.isInteger(copyPort) && copyPort > 0) {
        addTarget("127.0.0.1", copyPort, `http://127.0.0.1:${copyPort}`)
      }
    } catch {}
  }

  const rawUrl = (process.env.BENCH_URL || `http://127.0.0.1:${defaultPort}`).replace(/\/$/, "")
  let parsed
  try {
    parsed = new URL(rawUrl)
  } catch {
    console.error(`BENCH_URL 不是合法地址：${rawUrl}`)
    process.exit(2)
  }
  const urlPort = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80))
  const urlHost = parsed.hostname || "127.0.0.1"
  addTarget(urlHost, urlPort, rawUrl)

  for (const t of targets.values()) {
    const isLocal =
      t.host === "127.0.0.1" || t.host === "localhost" || t.host === "::1" || t.host === "0.0.0.0"
    if (isLocal && hasSystemPortListener(t.port)) {
      return { running: true, detail: `${t.label} 端口 ${t.port} 有人监听` }
    }
    if (await probeTcpConnect(t.host, t.port)) {
      return { running: true, detail: `${t.label} 端口 ${t.port} 有人监听` }
    }
  }
  return { running: false, detail: "" }
}

function inspectDbFile(filePath) {
  let st
  try {
    st = statSync(filePath)
  } catch {
    return { ok: false, why: "文件不存在" }
  }
  if (!st.isFile() || st.size === 0) {
    return { ok: false, why: "文件是空的" }
  }
  let ro
  try {
    ro = new DatabaseSync(filePath, { readOnly: true })
    const rows = ro.prepare("PRAGMA quick_check").all()
    const firstVal = rows.length === 1 ? String(Object.values(rows[0] ?? {})[0] ?? "").toLowerCase() : ""
    if (firstVal !== "ok") {
      return { ok: false, why: "完整性检查（quick_check）没通过" }
    }
    const projects = Number(ro.prepare("SELECT COUNT(*) AS c FROM projects").get()?.c ?? 0)
    const messages = Number(ro.prepare("SELECT COUNT(*) AS c FROM messages").get()?.c ?? 0)
    const tasks = Number(ro.prepare("SELECT COUNT(*) AS c FROM tasks").get()?.c ?? 0)
    return { ok: true, size: st.size, mtimeMs: st.mtimeMs, projects, messages, tasks }
  } catch (err) {
    return { ok: false, why: `打不开或缺少数据表（${err instanceof Error ? err.message : String(err)}）` }
  } finally {
    try {
      ro?.close()
    } catch {}
  }
}

function scanBackups() {
  if (!existsSync(backupsDir)) return []
  const out = []
  for (const name of readdirSync(backupsDir)) {
    const at = parseBackupName(name)
    if (at === null) continue
    const file = path.join(backupsDir, name)
    let st
    try {
      st = statSync(file)
    } catch {
      continue
    }
    if (!st.isFile()) continue
    const info = inspectDbFile(file)
    out.push({
      name,
      file,
      at,
      size: st.size,
      ...info,
    })
  }
  // Newest first for interactive display.
  return out.sort((a, b) => b.name.localeCompare(a.name))
}

function printBackupList(items) {
  if (items.length === 0) return
  console.log(`现有备份（共 ${items.length} 份，目录 ${backupsDir}）：`)
  items.forEach((item, idx) => {
    const prefix = `  [${idx + 1}] ${formatHumanTime(item.at)}  (${formatSize(item.size)})`
    if (item.ok) {
      console.log(
        `${prefix} · ${item.projects} 个项目 · ${item.messages} 条消息 · ${item.tasks} 条待办  [${item.name}]`,
      )
    } else {
      console.log(`${prefix} · 不可用：${item.why}  [${item.name}]`)
    }
  })
}

function nextBeforeRestorePrefix(baseDbPath) {
  const base = `${baseDbPath}.before-restore-${formatStampSec()}`
  if (!existsSync(base) && !existsSync(`${base}-wal`) && !existsSync(`${base}-shm`)) {
    return base
  }
  let seq = 2
  while (
    existsSync(`${base}-${seq}`) ||
    existsSync(`${base}-${seq}-wal`) ||
    existsSync(`${base}-${seq}-shm`)
  ) {
    seq += 1
  }
  return `${base}-${seq}`
}

function saveExistingDbBeforeRestore(liveDb) {
  const suffixes = ["", "-wal", "-shm"]
  const existing = suffixes.filter((sfx) => existsSync(`${liveDb}${sfx}`))
  if (existing.length === 0) return null

  const saveBase = nextBeforeRestorePrefix(liveDb)
  const moved = []
  for (const sfx of existing) {
    const from = `${liveDb}${sfx}`
    const to = `${saveBase}${sfx}`
    renameSync(from, to)
    try {
      chmodSync(to, 0o600)
    } catch {}
    moved.push({ from, to })
  }
  return { saveBase, moved }
}

function rollbackSavedDb(liveDb, saved) {
  try {
    rmSync(liveDb, { force: true })
    rmSync(`${liveDb}-wal`, { force: true })
    rmSync(`${liveDb}-shm`, { force: true })
  } catch {}
  if (!saved) return
  for (const item of saved.moved) {
    try {
      if (existsSync(item.to)) renameSync(item.to, item.from)
    } catch {}
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) {
    console.log("用法：npm run restore [-- --latest | --file <备份文件路径>]")
    console.log("说明：先停掉并坐（npm run stop），再从备份找回 data/bench.db；恢复前会自动把当前数据库另存一份。")
    return
  }

  const status = await isRoomRunning()
  if (status.running) {
    console.error(`并坐还在运行（${status.detail}），不能在开着时找回数据。`)
    console.error("请先运行 npm run stop 停掉服务（Windows 请关闭启动窗口或按 Ctrl+C），再重新运行 npm run restore。")
    process.exit(1)
  }

  const items = scanBackups()
  printBackupList(items)

  let chosen = null

  if (opts.file) {
    const resolved = path.resolve(opts.file)
    const info = inspectDbFile(resolved)
    if (!info.ok) {
      console.error(`指定的备份文件不可用（${resolved}）：${info.why}`)
      process.exit(1)
    }
    const parsedAt = parseBackupName(path.basename(resolved)) ?? info.mtimeMs
    chosen = {
      name: path.basename(resolved),
      file: resolved,
      at: parsedAt,
      ...info,
    }
    console.log(
      `将使用指定文件：${resolved}（${formatHumanTime(chosen.at)} · ${formatSize(chosen.size)} · ${chosen.projects} 个项目 · ${chosen.messages} 条消息 · ${chosen.tasks} 条待办）`,
    )
  } else if (opts.latest) {
    chosen = items.find((item) => item.ok) ?? null
    if (!chosen) {
      console.error(`在 ${backupsDir} 里没有找到可用的备份文件。`)
      process.exit(1)
    }
  } else {
    if (items.length === 0) {
      console.error(`在 ${backupsDir} 里还没有备份文件。也可以用 npm run restore -- --file <路径> 指定备份。`)
      process.exit(1)
    }
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      console.error("当前不是交互式终端，无法询问要找回哪一份。")
      console.error("请加上 -- --latest（最新一份）或 -- --file <路径> 再运行。")
      process.exit(1)
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    let answer = ""
    try {
      answer = (await rl.question(`要找回哪一份？输入编号 1-${items.length}（直接回车取消）：`)).trim()
    } finally {
      rl.close()
    }
    if (!answer || answer.toLowerCase() === "q") {
      console.log("已取消，未改动任何数据。")
      return
    }
    const num = Number(answer)
    if (!Number.isInteger(num) || num < 1 || num > items.length) {
      console.error(`输入的编号超出范围（1-${items.length}），已停手。`)
      process.exit(1)
    }
    const picked = items[num - 1]
    if (!picked.ok) {
      console.error(`第 ${num} 份备份已损坏（${picked.why}），不能用来恢复。`)
      process.exit(1)
    }
    chosen = picked
  }

  mkdirSync(dataDir, { recursive: true })
  const liveDb = path.join(dataDir, "bench.db")
  if (path.resolve(chosen.file) === path.resolve(liveDb)) {
    console.error("指定的备份文件就是当前的 bench.db 本身，无需恢复。")
    process.exit(1)
  }

  const stageFile = path.join(dataDir, `.bench.db.restoring-${process.pid}-${Date.now()}`)
  try {
    copyFileSync(chosen.file, stageFile)
    try {
      chmodSync(stageFile, 0o600)
    } catch {}
    const stagedCheck = inspectDbFile(stageFile)
    if (!stagedCheck.ok) {
      rmSync(stageFile, { force: true })
      console.error(`准备恢复文件时校验没过：${stagedCheck.why}，未改动当前数据库。`)
      process.exit(1)
    }
  } catch (err) {
    try {
      rmSync(stageFile, { force: true })
    } catch {}
    console.error(`复制备份文件失败：${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }

  const saved = saveExistingDbBeforeRestore(liveDb)

  try {
    renameSync(stageFile, liveDb)
    try {
      chmodSync(liveDb, 0o600)
    } catch {}
  } catch (err) {
    try {
      rmSync(stageFile, { force: true })
    } catch {}
    rollbackSavedDb(liveDb, saved)
    console.error(`替换数据库文件失败，已还原原文件：${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }

  const afterCheck = inspectDbFile(liveDb)
  if (!afterCheck.ok) {
    rollbackSavedDb(liveDb, saved)
    console.error(`换入后完整性检查（quick_check）没通过（${afterCheck.why}），已还原原文件。`)
    process.exit(1)
  }

  console.log(
    `已找回数据：${chosen.name}（${afterCheck.projects} 个项目 · ${afterCheck.messages} 条消息 · ${afterCheck.tasks} 条待办，quick_check 通过）。`,
  )
  if (saved) {
    console.log(`恢复前的数据库已另存为：${saved.saveBase}*`)
  }
  console.log("现在可以重新启动并坐（Linux/macOS 运行 ./start.sh 或 npm run dev；Windows 双击 start.bat）。")
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
