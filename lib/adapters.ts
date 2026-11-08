import { readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"

import { ApiError } from "@/lib/http"

export type Adapter = {
  name: string
  command: string
}

const NAME_RE = /^[\p{L}\p{N}_-]{1,24}$/u
const DEFAULT_HELP =
  "每种 agent 写一次，不用按席位改。name 是他入座时报的 agent 名，比如 cursor。command 里的 {uuid} 会换成他报的 uuid。页面里的「配置唤起」写的也是这个文件。"

let cached: { mtimeMs: number; adapters: Adapter[] } | null = null

function configFile() {
  return path.join(process.cwd(), "agents.json")
}

function normalize(value: unknown): Adapter | null {
  if (!value || typeof value !== "object") return null
  const record = value as { name?: unknown; command?: unknown }
  const name = typeof record.name === "string" ? record.name.trim() : ""
  const command = typeof record.command === "string" ? record.command.trim() : ""
  if (!name || !command || command.length > 2000) return null
  return { name, command }
}

export function adapters(): Adapter[] {
  try {
    const mtimeMs = statSync(configFile()).mtimeMs
    if (cached && cached.mtimeMs === mtimeMs) return cached.adapters
    const parsed = JSON.parse(readFileSync(configFile(), "utf8")) as { agents?: unknown }
    const list = Array.isArray(parsed.agents) ? parsed.agents : []
    const next = list.flatMap((item) => {
      const adapter = normalize(item)
      return adapter ? [adapter] : []
    })
    cached = { mtimeMs, adapters: next }
    return next
  } catch {
    return []
  }
}

export function hasAdapter(name: string) {
  return adapters().some((adapter) => adapter.name === name)
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

export function commandFor(name: string, uuid: string, text = "") {
  const adapter = adapters().find((item) => item.name === name)
  if (!adapter) return null
  return adapter.command
    .replaceAll("{uuid}", uuid)
    .replaceAll("{session}", uuid)
    .replaceAll("{text}", shellQuote(text))
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
    const record = item as { name?: unknown; command?: unknown }
    const name = typeof record.name === "string" ? record.name.trim() : ""
    const command = typeof record.command === "string" ? record.command.trim() : ""
    if (!name || !command) throw new ApiError(400, "每一条都要有 agent 名和命令")
    if (!NAME_RE.test(name)) {
      throw new ApiError(400, "agent 名用 1 到 24 个字母、数字或中文，不要空格，比如 cursor")
    }
    if (command.length > 2000 || /[\0\r\n]/.test(command)) {
      throw new ApiError(400, "命令写成一行，最长 2000 个字符")
    }
    if (seen.has(name)) throw new ApiError(400, `${name} 写了两条`)
    seen.add(name)
    next.push({ name, command })
  }
  const file = configFile()
  const body = `${JSON.stringify({ _help: readHelp(), agents: next }, null, 2)}\n`
  const tmp = `${file}.tmp`
  writeFileSync(tmp, body)
  renameSync(tmp, file)
  cached = { mtimeMs: statSync(file).mtimeMs, adapters: next }
  return next
}
