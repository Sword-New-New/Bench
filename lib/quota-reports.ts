import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"

import { ApiError } from "@/lib/http"
import { KINDS } from "@/lib/kinds"
import type { Quota, QuotaWindow } from "@/lib/quota"

// Usage sent in from outside: a plugin, hook or script that can see a
// client's allowance the room can't read itself (CodeBuddy, Qoder, Copilot…)
// posts it to POST /api/v1/quota (scripts/quota-push.mjs is the ready-made
// sender). Kept in data/quota-reports.json so a restart keeps it, and dropped
// once its `ttl` runs out so a dead plugin doesn't leave an old number up.
// What the room reads itself wins: a report only fills in a client the room
// has no numbers for.

type Report = {
  kind: string
  source: string
  plan: string | null
  windows: QuotaWindow[]
  at: number
  until: number
}

const DEFAULT_TTL = 6 * 3600 // seconds
const MAX_TTL = 31 * 86400

function file() {
  return path.join(process.cwd(), "data", "quota-reports.json")
}

let reports: Record<string, Report> | null = null

function load(): Record<string, Report> {
  if (reports) return reports
  try {
    reports = JSON.parse(readFileSync(file(), "utf8")) as Record<string, Report>
  } catch {
    reports = {}
  }
  return reports
}

function save() {
  const target = file()
  mkdirSync(path.dirname(target), { recursive: true })
  const tmp = `${target}.tmp`
  writeFileSync(tmp, JSON.stringify(load(), null, 2))
  renameSync(tmp, target)
}

function text(value: unknown, name: string, max: number, required = false): string | undefined {
  if (value === undefined || value === null || value === "") {
    if (required) throw new ApiError(400, `缺少 ${name}`)
    return undefined
  }
  if (typeof value !== "string") throw new ApiError(400, `${name} 要是字符串`)
  const trimmed = value.trim()
  if (trimmed.length > max) throw new ApiError(400, `${name} 最多 ${max} 个字`)
  return trimmed || undefined
}

function number(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null) return undefined
  const parsed = typeof value === "number" ? value : Number(value)
  if (!Number.isFinite(parsed)) throw new ApiError(400, `${name} 要是数字`)
  return parsed
}

const SPANS = new Set(["5h", "day", "week", "month", "other"])

function windowOf(raw: unknown, index: number): QuotaWindow {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new ApiError(400, `windows[${index}] 要是对象`)
  const item = raw as Record<string, unknown>
  const label = text(item.label, `windows[${index}].label`, 16, true)!
  // Either a percent used, or used and limit (credits, requests…), or the
  // percent left — whichever the plugin has.
  let percent = number(item.percent, `windows[${index}].percent`)
  const left = number(item.percentLeft, `windows[${index}].percentLeft`)
  const used = number(item.used, `windows[${index}].used`)
  const limit = number(item.limit, `windows[${index}].limit`)
  if (percent === undefined && left !== undefined) percent = 100 - left
  if (percent === undefined && used !== undefined && limit !== undefined && limit > 0) percent = (used / limit) * 100
  if (percent === undefined) throw new ApiError(400, `windows[${index}] 要给 percent，或 percentLeft，或 used 加 limit`)
  const reset = text(item.resetsAt, `windows[${index}].resetsAt`, 40)
  if (reset && Number.isNaN(Date.parse(reset))) throw new ApiError(400, `windows[${index}].resetsAt 不是能认的时间`)
  const span = text(item.span, `windows[${index}].span`, 8) ?? "other"
  if (!SPANS.has(span)) throw new ApiError(400, `windows[${index}].span 只能是 5h、day、week、month、other`)
  const group = text(item.group, `windows[${index}].group`, 16)
  return {
    span,
    label,
    percent: Math.max(0, Math.min(100, Math.round(percent))),
    resetsAt: reset ? new Date(reset).toISOString() : null,
    ...(group ? { group } : {}),
  }
}

// Validates and keeps one report; an empty `windows` takes the kind's report down.
export function report(body: Record<string, unknown>) {
  const kind = text(body.kind, "kind", 32, true)!
  if (!KINDS.some((item) => item.id === kind)) {
    throw new ApiError(400, `不认识的 kind：${kind}。可用的有 ${KINDS.map((item) => item.id).join("、")}`)
  }
  if (!Array.isArray(body.windows)) throw new ApiError(400, "windows 要是数组")
  if (body.windows.length > 8) throw new ApiError(400, "windows 最多 8 条")
  const windows = body.windows.map(windowOf)
  const all = load()
  if (windows.length === 0) {
    delete all[kind]
    save()
    return null
  }
  const ttl = Math.max(60, Math.min(MAX_TTL, number(body.ttl, "ttl") ?? DEFAULT_TTL))
  const at = Date.now()
  const entry: Report = {
    kind,
    source: text(body.source, "source", 40) ?? "插件",
    plan: text(body.plan, "plan", 32) ?? null,
    windows,
    at,
    until: at + ttl * 1000,
  }
  all[kind] = entry
  save()
  return entry
}

// The room's own readings, with live reports filling in kinds it has no numbers for.
export function withReports(list: Quota[]): Quota[] {
  const now = Date.now()
  const live = Object.values(load()).filter((entry) => entry.until > now)
  if (live.length === 0) return list
  const out = [...list]
  for (const entry of live) {
    const own = out.findIndex((item) => item.kind === entry.kind)
    if (own >= 0 && out[own].windows.length > 0) continue
    const quota: Quota = {
      kind: entry.kind,
      account: true,
      plan: entry.plan,
      windows: entry.windows,
      blocked: entry.windows.some((window) => window.percent >= 100),
      error: null,
      source: entry.source,
      reportedAt: entry.at,
    }
    if (own >= 0) out[own] = quota
    else out.push(quota)
  }
  return out
}
