#!/usr/bin/env node
// Usage: merge-mcp.mjs FILE STYLE KIND [TOP_JSON] [SERVER_JSON]
// Adds the bench server to an agent's JSON config, keeping everything else.
// STYLE is the config's shape:
//   mcpServers  {"mcpServers":{"bench":{"command","args"}}}  (most clients)
//   opencode    {"mcp":{"bench":{"type":"local","command":[...]}}}  (OpenCode, Kilo)
//   crush       {"mcp":{"bench":{"type":"stdio","command","args"}}}
// TOP_JSON is merged into the top level one level deep (lists are unioned),
// SERVER_JSON into the bench entry. A file that isn't plain JSON (comments,
// say) is left alone rather than overwritten.

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

const [file, style, kind, top = "{}", server = "{}"] = process.argv.slice(2)
const script = path.join(path.dirname(new URL(import.meta.url).pathname), "bench-mcp.mjs")
const node = process.execPath

let config = {}
let before = ""
if (existsSync(file)) {
  before = readFileSync(file, "utf8")
  try {
    config = JSON.parse(before)
  } catch {
    console.error(`${file} 不是纯 JSON（可能带注释），没有改它。请手动把 bench 加进去：`)
    console.error(`  命令 ${node}，参数 ${script} --agent ${kind}`)
    process.exit(1)
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
config[key] = { ...(config[key] || {}), bench: { ...entry, ...JSON.parse(server) } }

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
if (before) copyFileSync(file, `${file}.bak-bench-${Date.now()}`)
writeFileSync(file, after)
console.log(`已写入 ${file}`)
