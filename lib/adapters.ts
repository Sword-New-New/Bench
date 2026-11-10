import { accessSync, constants, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import { ApiError } from "@/lib/http"
import { KINDS, wakeModel } from "@/lib/kinds"
import { withEffort, withModel } from "@/lib/models"
import { commandNames, extraBins, pathDelimiter } from "@/lib/platform"

export type Adapter = {
  name: string
  command: string
  reply: "stdout" | "none"
}

const NAME_RE = /^[\p{L}\p{N}_-]{1,24}$/u
const DEFAULT_HELP =
  "每种 agent 写一次，不用按席位改。name 是他入座时报的 agent 名（claude、dsh、codex、cursor、antigravity 等，全部见 lib/kinds.ts）。{uuid} 换成他报的 uuid，{text} 换成点到他的那句话，已经带上引号。reply 为 stdout 时，命令的输出会作为他的回复贴回房间。"

let cached: { mtimeMs: number; adapters: Adapter[] } | null = null

function configFile() {
  return path.join(process.cwd(), "agents.json")
}

function defaults(): Adapter[] {
  return KINDS.map((kind) => ({ name: kind.id, command: kind.command, reply: kind.reply }))
}

function replyOf(value: unknown): Adapter["reply"] {
  return value === "stdout" ? "stdout" : "none"
}

function normalize(value: unknown): Adapter | null {
  if (!value || typeof value !== "object") return null
  const record = value as { name?: unknown; command?: unknown; reply?: unknown }
  const name = typeof record.name === "string" ? record.name.trim() : ""
  const command = typeof record.command === "string" ? record.command.trim() : ""
  if (!name || !command || command.length > 2000) return null
  return { name, command, reply: replyOf(record.reply) }
}

export function adapters(): Adapter[] {
  try {
    const mtimeMs = statSync(configFile()).mtimeMs
    if (cached && cached.mtimeMs === mtimeMs) return cached.adapters
    const parsed = JSON.parse(readFileSync(configFile(), "utf8")) as { agents?: unknown }
    const list = Array.isArray(parsed.agents) ? parsed.agents : []
    const saved = list.flatMap((item) => {
      const adapter = normalize(item)
      if (!adapter) return []
      // Still the default from before: move it to the current default.
      const kind = KINDS.find((entry) => entry.id === adapter.name)
      return [kind?.was?.includes(adapter.command) ? { ...adapter, command: kind.command } : adapter]
    })
    // A kind added to lib/kinds.ts after the file was written still gets its
    // default command.
    const next = [...saved, ...defaults().filter((kind) => !saved.some((adapter) => adapter.name === kind.name))]
    cached = { mtimeMs, adapters: next }
    return next
  } catch {
    return defaults()
  }
}

export function adapterFor(name: string) {
  return adapters().find((adapter) => adapter.name === name) ?? null
}

export function hasAdapter(name: string) {
  return adapterFor(name) !== null
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

export function commandFor(name: string, uuid: string, text = "", model?: string | null, effort?: string | null) {
  const adapter = adapterFor(name)
  if (!adapter) return null
  return withEffort(name, withModel(name, adapter.command, model), effort)
    .replaceAll("{uuid}", shellQuote(uuid))
    .replaceAll("{session}", shellQuote(uuid))
    .replaceAll("{text}", shellQuote(text))
}

// The PATH a woken command runs with. A room started from the desktop entry
// often lacks the user's own bin directories.
export function summonPath() {
  const parts = (process.env.PATH ?? "").split(pathDelimiter()).filter(Boolean)
  for (const dir of extraBins()) if (!parts.includes(dir)) parts.push(dir)
  return parts.join(pathDelimiter())
}

function executable(file: string) {
  try {
    accessSync(file, constants.X_OK)
    return statSync(file).isFile()
  } catch {
    return false
  }
}

// Whether the first word of a command resolves to something runnable.
export function installed(command: string) {
  const first = command.trim().match(/^(?:'([^']*)'|"([^"]*)"|(\S+))/)
  const bin = first?.[1] ?? first?.[2] ?? first?.[3]
  if (!bin) return false
  const expanded = bin.replace(/^~(?=[\\/])/, os.homedir())
  if (/[\\/]/.test(expanded)) return executable(path.resolve(process.cwd(), expanded))
  const names = commandNames(expanded)
  return summonPath()
    .split(pathDelimiter())
    .some((dir) => names.some((name) => executable(path.join(dir, name))))
}

function readHelp() {
  try {
    const parsed = JSON.parse(readFileSync(configFile(), "utf8")) as { _help?: unknown }
    if (typeof parsed._help === "string" && parsed._help.trim()) return parsed._help
  } catch {
    return DEFAULT_HELP
  }
  return DEFAULT_HELP
}

export function replaceAdapters(input: unknown) {
  if (!Array.isArray(input)) throw new ApiError(400, "agents 要是一个列表")
  const next: Adapter[] = []
  const seen = new Set<string>()
  for (const item of input) {
    if (!item || typeof item !== "object") throw new ApiError(400, "每一条都要有 agent 名和命令")
    const record = item as { name?: unknown; command?: unknown; reply?: unknown }
    const name = typeof record.name === "string" ? record.name.trim() : ""
    const command = typeof record.command === "string" ? record.command.trim() : ""
    if (!name || !command) throw new ApiError(400, "每一条都要有 agent 名和命令")
    if (!NAME_RE.test(name)) {
      throw new ApiError(400, "agent 名用 1 到 24 个字母、数字或中文，不要空格，比如 claude")
    }
    if (command.length > 2000 || /[\0\r\n]/.test(command)) {
      throw new ApiError(400, "命令写成一行，最长 2000 个字符")
    }
    if (seen.has(name)) throw new ApiError(400, `${name} 写了两条`)
    seen.add(name)
    next.push({ name, command, reply: replyOf(record.reply) })
  }
  const file = configFile()
  const body = `${JSON.stringify({ _help: readHelp(), agents: next }, null, 2)}\n`
  const tmp = `${file}.tmp`
  writeFileSync(tmp, body)
  renameSync(tmp, file)
  cached = { mtimeMs: statSync(file).mtimeMs, adapters: next }
  return next
}

export function tomlString(file: string, key: string, table = "") {
  try {
    // The keys of one table: top level by default, else that [table].
    const text = readFileSync(file, "utf8")
    // A header on a line of its own; comments can mention "[table]" too.
    const header = table ? new RegExp(`^\\[${table}\\][ \\t]*$`, "m").exec(text) : null
    if (table && !header) return null
    const body = text.slice(header ? header.index + header[0].length : 0).split(/^\[/m)[0]
    return body.match(new RegExp(`^${key}\\s*=\\s*"([^"]+)"`, "m"))?.[1] ?? null
  } catch {
    return null
  }
}

// The model a client falls back to when its wake command names none, where
// its config says so plainly.
function clientDefault(name: string) {
  const home = os.homedir()
  if (name === "codex") return tomlString(path.join(process.env.CODEX_HOME || path.join(home, ".codex"), "config.toml"), "model")
  if (name === "dsh") {
    const model = tomlString(path.join(process.env.DSH_HOME || path.join(home, ".dsh"), "dsh-agent.toml"), "model", "defaults")
    // "cn:deepseek-v4.1-flash": drop the provider prefix.
    return model?.replace(/^[\w-]+:/, "") ?? null
  }
  return null
}

// What a wake for this adapter runs on: the model in its command, else the
// client's configured default; null when neither says.
export function modelOf(adapter: Adapter) {
  return wakeModel(adapter.command) ?? clientDefault(adapter.name)
}
