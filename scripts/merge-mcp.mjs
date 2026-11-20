#!/usr/bin/env node
// Usage:
//   merge-mcp.mjs FILE STYLE KIND [TOP_JSON] [SERVER_JSON]
//   merge-mcp.mjs --backup FILE
// Adds the bench server to an agent's JSON config, keeping everything else.
// STYLE is the config's shape:
//   mcpServers  {"mcpServers":{"bench":{"command","args"}}}  (most clients)
//   opencode    {"mcp":{"bench":{"type":"local","command":[...]}}}  (OpenCode, Kilo)
//   crush       {"mcp":{"bench":{"type":"stdio","command","args"}}}
// TOP_JSON is merged into the top level one level deep (lists are unioned),
// SERVER_JSON into the bench entry. A file that isn't plain JSON (comments,
// say) is left alone rather than overwritten.
// Backups keep original file permissions, skip creating a duplicate when
// identical to the latest backup, and prune older backups beyond 5 files.

import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const MAX_BACKUPS = 5

function timestampNow() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, "0")
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function listBackups(file) {
  const dir = path.dirname(file)
  const base = path.basename(file)
  if (!existsSync(dir)) return []
  const re = new RegExp(`^${escapeRegex(base)}\\.bak-bench-(\\d{14})(?:-(\\d+))?$`)
  const found = []
  for (const name of readdirSync(dir)) {
    const m = name.match(re)
    if (!m) continue
    found.push({
      path: path.join(dir, name),
      ts: m[1],
      seq: m[2] ? Number(m[2]) : 0,
    })
  }
  found.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.seq - b.seq))
  return found
}

function nextBackupPath(file, backups) {
  const ts = timestampNow()
  const sameTs = backups.filter((b) => b.ts === ts)
  if (sameTs.length === 0) {
    const candidate = `${file}.bak-bench-${ts}`
    if (!existsSync(candidate)) return candidate
  }
  let seq = sameTs.reduce((max, b) => Math.max(max, b.seq), -1) + 1
  while (existsSync(`${file}.bak-bench-${ts}-${seq}`)) seq++
  return `${file}.bak-bench-${ts}-${seq}`
}

function backupConfig(file) {
  if (!existsSync(file)) return
  const raw = readFileSync(file)
  const mode = statSync(file).mode & 0o777
  const backups = listBackups(file)
  const latest = backups.at(-1)
  if (latest) {
    try {
      if (readFileSync(latest.path).equals(raw)) {
        while (backups.length > MAX_BACKUPS) rmSync(backups.shift().path, { force: true })
        return
      }
    } catch {}
  }
  const backup = nextBackupPath(file, backups)
  writeFileSync(backup, raw, { mode })
  chmodSync(backup, mode)
  backups.push({ path: backup })
  while (backups.length > MAX_BACKUPS) rmSync(backups.shift().path, { force: true })
  console.log(`已备份原配置：${backup}`)
}

if (process.argv[2] === "--backup") {
  const target = process.argv[3]
  if (!target) {
    console.error("用法：merge-mcp.mjs --backup FILE")
    process.exit(2)
  }
  backupConfig(target)
  process.exit(0)
}

const [file, style, kind, top = "{}", server = "{}"] = process.argv.slice(2)
const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "bench-mcp.mjs")
const node = process.execPath

let config = {}
let before = ""
const hadFile = existsSync(file)
if (hadFile) {
  before = readFileSync(file, "utf8")
  if (before.trim()) {
    let parsed
    try {
      parsed = JSON.parse(before)
    } catch {
      console.error(`${file} 不是纯 JSON（可能带注释或格式有误），没有改它。请手动把 bench 加进去：`)
      console.error(`  命令 ${node}，参数 ${script} --agent ${kind}`)
      process.exit(1)
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      console.error(`${file} 顶层不是 JSON 对象，读不懂它的结构，没有改它。请手动把 bench 加进去：`)
      console.error(`  命令 ${node}，参数 ${script} --agent ${kind}`)
      process.exit(1)
    }
    config = parsed
  }
}

const args = [script, "--agent", kind]
const entry = {
  mcpServers: { command: node, args },
  opencode: { type: "local", command: [node, ...args], enabled: true },
  crush: { type: "stdio", command: node, args },
}[style]
if (!entry) {
  console.error(`不认识的格式 ${style}`)
  process.exit(2)
}
const key = { mcpServers: "mcpServers", opencode: "mcp", crush: "mcp" }[style]
const prevSection = config[key]
if (prevSection !== undefined && (!prevSection || typeof prevSection !== "object" || Array.isArray(prevSection))) {
  console.error(`${file} 里的 ${key} 不是对象结构，读不懂，没有改它。请手动加入 bench。`)
  process.exit(1)
}
config[key] = { ...(prevSection || {}), bench: { ...entry, ...JSON.parse(server) } }

for (const [name, value] of Object.entries(JSON.parse(top))) {
  if (typeof value !== "object" || Array.isArray(value)) {
    config[name] = value
    continue
  }
  // A plain value already there (OpenCode's "permission": "allow") covers more
  // than we would add; keep it.
  if (config[name] !== undefined && typeof config[name] !== "object") continue
  const old = config[name] ?? {}
  for (const [k, v] of Object.entries(value)) {
    old[k] = Array.isArray(v) ? [...new Set([...(Array.isArray(old[k]) ? old[k] : []), ...v])] : v
  }
  config[name] = old
}

const after = `${JSON.stringify(config, null, 2)}\n`
if (after === before) {
  console.log(`${file} 里已经有 bench，不用改`)
  process.exit(0)
}
mkdirSync(path.dirname(file), { recursive: true })
if (hadFile) backupConfig(file)
writeFileSync(file, after)
console.log(`已写入 ${file}`)
