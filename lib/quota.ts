import { execFile, spawn } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import { installed, summonPath } from "@/lib/adapters"
import { cliCommand } from "@/lib/platform"
import { withReports } from "@/lib/quota-reports"

// How much of each client's account allowance is used: the 5-hour window and
// the week, for the clients signed in with an account (not an API key). Read
// from where the client itself reads it, with the login it already has on
// this computer; the login never leaves the computer except to its own
// provider, and is never sent to the page. Cached for five minutes, and kept
// across HMR and restarts so background tabs don't trip upstream rate limits.

export type QuotaWindow = {
  // "5h", "week", "month" (a billing cycle), or another window (label says which).
  span: string
  label: string
  percent: number // used, 0–100
  resetsAt: string | null // ISO time
  // Which models it covers, when a client keeps separate allowances.
  group?: string
}

export type Quota = {
  kind: string
  // false: this client isn't signed in with an account here (API key, or no login).
  account: boolean
  plan: string | null
  windows: QuotaWindow[]
  // Out of allowance right now (the client says so).
  blocked: boolean
  error: string | null
  // Set when a plugin sent it in (POST /api/v1/quota) instead of the room
  // reading it: who sent it, and when (ms).
  source?: string
  reportedAt?: number
  // Set when a fresh read was rate-limited or failed and an earlier reading is shown instead (ms).
  staleAt?: number
}

const TTL = 5 * 60_000
// Anthropic's /api/oauth/usage rate-limits tightly and answers 429 with
// `Retry-After: 0`. Match Claude Code's own fetchUtilization guard: back off
// 5 minutes on the first 429 (doubling up to 1 hour), and never hit the
// endpoint faster than once a minute even on ?fresh=1.
const CLAUDE_MIN_GAP = 60_000
const CLAUDE_BACKOFF_BASE = 5 * 60_000
const CLAUDE_BACKOFF_MAX = 60 * 60_000
const STALE_MAX_AGE = 6 * 3600_000

type ClaudeGuard = {
  good: { at: number; quota: Quota } | null
  cooldownUntil: number
  strikes: number
  lastAskedAt: number
}

type QuotaState = {
  loaded: boolean
  cached: { at: number; quotas: Quota[] } | null
  pending: Promise<Quota[]> | null
  claude: ClaudeGuard
}

const globalStore = globalThis as typeof globalThis & { __benchQuotas?: QuotaState }

function cacheFile() {
  return path.join(process.cwd(), "data", "quota-cache.json")
}

function state(): QuotaState {
  const current = (globalStore.__benchQuotas ??= {
    loaded: false,
    cached: null,
    pending: null,
    claude: { good: null, cooldownUntil: 0, strikes: 0, lastAskedAt: 0 },
  })
  if (!current.loaded) {
    current.loaded = true
    try {
      const raw = JSON.parse(readFileSync(cacheFile(), "utf8")) as {
        at?: number
        quotas?: Quota[]
        claude?: Partial<ClaudeGuard>
      }
      if (typeof raw.at === "number" && Array.isArray(raw.quotas)) {
        current.cached = { at: raw.at, quotas: raw.quotas }
      }
      if (raw.claude && typeof raw.claude === "object") {
        current.claude = {
          good: raw.claude.good && Array.isArray(raw.claude.good.quota?.windows) ? raw.claude.good : null,
          cooldownUntil: typeof raw.claude.cooldownUntil === "number" ? raw.claude.cooldownUntil : 0,
          strikes: typeof raw.claude.strikes === "number" ? raw.claude.strikes : 0,
          lastAskedAt: typeof raw.claude.lastAskedAt === "number" ? raw.claude.lastAskedAt : 0,
        }
      }
    } catch {}
  }
  return current
}

function saveState(current: QuotaState) {
  try {
    const target = cacheFile()
    mkdirSync(path.dirname(target), { recursive: true })
    const tmp = `${target}.tmp`
    writeFileSync(
      tmp,
      JSON.stringify({
        at: current.cached?.at ?? 0,
        quotas: current.cached?.quotas ?? [],
        claude: current.claude,
      }),
    )
    renameSync(tmp, target)
  } catch {}
}

function cooldownText(until: number, now: number) {
  const minutes = Math.max(1, Math.ceil((until - now) / 60_000))
  return `额度接口限流（429），约 ${minutes} 分钟后再试`
}

function withLiveCooldown(list: Quota[], guard: ClaudeGuard, now: number): Quota[] {
  if (guard.cooldownUntil <= now) return list
  return list.map((item) =>
    item.kind === "claude" && item.error?.includes("429")
      ? { ...item, error: cooldownText(guard.cooldownUntil, now) }
      : item,
  )
}

export async function quotas(fresh = false): Promise<{ at: number; quotas: Quota[] }> {
  const current = state()
  const now = Date.now()
  const claudeReadyToRetry = current.claude.cooldownUntil > 0 && now >= current.claude.cooldownUntil
  if (!fresh && !claudeReadyToRetry && current.cached && now - current.cached.at < TTL) {
    return {
      at: current.cached.at,
      quotas: withReports(withLiveCooldown(current.cached.quotas, current.claude, now)),
    }
  }
  current.pending ??= Promise.all([
    claudeQuota(current.claude),
    codexQuota(),
    antigravityQuota(),
    cursorQuota(),
  ]).finally(() => {
    current.pending = null
  })
  const list = await current.pending
  current.cached = { at: Date.now(), quotas: list }
  saveState(current)
  return { at: current.cached.at, quotas: withReports(current.cached.quotas) }
}

function empty(kind: string, patch: Partial<Quota>): Quota {
  return { kind, account: false, plan: null, windows: [], blocked: false, error: null, ...patch }
}

function clampPercent(value: unknown) {
  const number = typeof value === "number" ? value : Number(value)
  return Number.isFinite(number) ? Math.max(0, Math.min(100, Math.round(number))) : 0
}

function retryAfterMs(header: string | null): number {
  if (!header) return 0
  const seconds = Number(header)
  if (Number.isFinite(seconds)) return seconds > 0 ? Math.round(seconds * 1000) : 0
  const at = Date.parse(header)
  return Number.isFinite(at) && at > Date.now() ? at - Date.now() : 0
}

function fallbackClaude(guard: ClaudeGuard, plan: string | null, error: string, now: number): Quota {
  const prev = guard.good
  if (prev && prev.quota.windows.length > 0 && now - prev.at < STALE_MAX_AGE) {
    return {
      ...prev.quota,
      plan: plan ?? prev.quota.plan,
      error,
      staleAt: prev.at,
    }
  }
  return empty("claude", { account: true, plan, error })
}

// ---- Claude Code: the OAuth login in ~/.claude/.credentials.json and the
// same usage endpoint its /usage screen reads.
async function claudeQuota(guard: ClaudeGuard): Promise<Quota> {
  const file = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), ".credentials.json")
  let oauth: { accessToken?: string; expiresAt?: number; subscriptionType?: string } | undefined
  try {
    oauth = JSON.parse(readFileSync(file, "utf8")).claudeAiOauth
  } catch {}
  if (!oauth?.accessToken) return empty("claude", { error: "没用账号登录" })
  const plan = oauth.subscriptionType ?? null
  const now = Date.now()
  // Refreshing the login here would rotate it under Claude Code's feet; it
  // renews itself the next time it runs.
  if (oauth.expiresAt && oauth.expiresAt < now) {
    return empty("claude", { account: true, plan, error: "登录过期了，Claude Code 下次运行会自己续上" })
  }
  if (guard.cooldownUntil > now) {
    return fallbackClaude(guard, plan, cooldownText(guard.cooldownUntil, now), now)
  }
  if (guard.lastAskedAt > 0 && now - guard.lastAskedAt < CLAUDE_MIN_GAP && guard.good && now - guard.good.at < STALE_MAX_AGE) {
    return { ...guard.good.quota, plan: plan ?? guard.good.quota.plan }
  }
  guard.lastAskedAt = now
  try {
    const response = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: {
        Authorization: `Bearer ${oauth.accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": "bench-room",
      },
      signal: AbortSignal.timeout(15_000),
    })
    if (response.status === 429) {
      const current = Date.now()
      guard.strikes += 1
      const hinted = retryAfterMs(response.headers.get("retry-after"))
      const backoff = Math.min(CLAUDE_BACKOFF_MAX, hinted > 0 ? hinted : CLAUDE_BACKOFF_BASE * 2 ** (guard.strikes - 1))
      guard.cooldownUntil = current + backoff
      return fallbackClaude(guard, plan, cooldownText(guard.cooldownUntil, current), current)
    }
    if (response.status === 401) {
      return empty("claude", { account: true, plan, error: "登录已失效，Claude Code 下次运行会自己续上" })
    }
    if (!response.ok) {
      const message = `额度接口回了 ${response.status}`
      return response.status >= 500 ? fallbackClaude(guard, plan, message, Date.now()) : empty("claude", { account: true, plan, error: message })
    }
    const data = (await response.json()) as {
      five_hour?: { utilization?: number; resets_at?: string } | null
      seven_day?: { utilization?: number; resets_at?: string } | null
      limits?: { kind?: string; percent?: number; resets_at?: string; scope?: { model?: { display_name?: string } } | null }[]
    }
    const windows: QuotaWindow[] = []
    if (Array.isArray(data.limits) && data.limits.length > 0) {
      for (const limit of data.limits) {
        const at = limit.resets_at ?? null
        if (limit.kind === "session") windows.push({ span: "5h", label: "5 小时", percent: clampPercent(limit.percent), resetsAt: at })
        else if (limit.kind === "weekly_all") windows.push({ span: "week", label: "每周", percent: clampPercent(limit.percent), resetsAt: at })
        else if (limit.kind === "weekly_scoped") {
          const model = limit.scope?.model?.display_name
          windows.push({ span: "week", label: model ? `${model} 周` : "单列周", percent: clampPercent(limit.percent), resetsAt: at })
        }
      }
    } else {
      if (data.five_hour) windows.push({ span: "5h", label: "5 小时", percent: clampPercent(data.five_hour.utilization), resetsAt: data.five_hour.resets_at ?? null })
      if (data.seven_day) windows.push({ span: "week", label: "每周", percent: clampPercent(data.seven_day.utilization), resetsAt: data.seven_day.resets_at ?? null })
    }
    const result = empty("claude", { account: true, plan, windows, blocked: windows.some((window) => window.percent >= 100) })
    guard.strikes = 0
    guard.cooldownUntil = 0
    if (windows.length > 0) guard.good = { at: Date.now(), quota: result }
    return result
  } catch (error) {
    return fallbackClaude(guard, plan, `读不到额度：${(error as Error).message}`, Date.now())
  }
}

// ---- Codex: ask its own app-server (account/rateLimits/read), which uses the
// ChatGPT login in ~/.codex/auth.json.
function codexBin() {
  if (installed("codex")) return "codex"
  const bundled = "/usr/lib/chatgpt/resources/codex"
  return existsSync(bundled) ? bundled : null
}

function spanOf(minutes: number | null | undefined): { span: string; label: string } {
  if (minutes === 300) return { span: "5h", label: "5 小时" }
  if (minutes === 10080) return { span: "week", label: "每周" }
  if (!minutes) return { span: "other", label: "额度" }
  if (minutes % 1440 === 0) return { span: "other", label: `${minutes / 1440} 天` }
  return { span: "other", label: `${Math.round(minutes / 60)} 小时` }
}

type CodexWindow = { usedPercent?: number; windowDurationMins?: number | null; resetsAt?: number | null } | null

async function codexQuota(): Promise<Quota> {
  const home = process.env.CODEX_HOME || path.join(os.homedir(), ".codex")
  let mode: string | undefined
  try {
    mode = JSON.parse(readFileSync(path.join(home, "auth.json"), "utf8")).auth_mode
  } catch {}
  if (mode !== "chatgpt") return empty("codex", { error: mode ? "用的是 API key，不是账号" : "没用账号登录" })
  const bin = codexBin()
  if (!bin) return empty("codex", { account: true, error: "没找到 codex" })
  try {
    const result = (await codexAsk(bin, "account/rateLimits/read")) as {
      ordinaryUsageAllowed?: boolean
      rateLimits?: { primary?: CodexWindow; secondary?: CodexWindow; planType?: string | null; rateLimitReachedType?: string | null }
    }
    const limits = result.rateLimits ?? {}
    const windows: QuotaWindow[] = []
    for (const window of [limits.primary, limits.secondary]) {
      if (!window) continue
      windows.push({
        ...spanOf(window.windowDurationMins),
        percent: clampPercent(window.usedPercent),
        resetsAt: window.resetsAt ? new Date(window.resetsAt * 1000).toISOString() : null,
      })
    }
    windows.sort((a, b) => (a.span === "5h" ? -1 : b.span === "5h" ? 1 : 0))
    return empty("codex", {
      account: true,
      plan: limits.planType ?? null,
      windows,
      blocked: result.ordinaryUsageAllowed === false || Boolean(limits.rateLimitReachedType),
    })
  } catch (error) {
    return empty("codex", { account: true, error: `读不到额度：${(error as Error).message}` })
  }
}

// One request to a short-lived `codex app-server` over stdio JSON-RPC.
function codexAsk(bin: string, method: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const [program, programArgs] = cliCommand(bin, ["app-server"])
    const child = spawn(program, programArgs, { stdio: ["pipe", "pipe", "ignore"], windowsHide: true })
    let buffer = ""
    const finish = (error: Error | null, value?: unknown) => {
      clearTimeout(timer)
      child.kill()
      if (error) reject(error)
      else resolve(value)
    }
    const timer = setTimeout(() => finish(new Error("codex 没在 20 秒内回话")), 20_000)
    const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`)
    child.on("error", (error) => finish(error))
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk
      let end
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 1)
        let message: { id?: number; result?: unknown; error?: { message?: string } }
        try {
          message = JSON.parse(line)
        } catch {
          continue
        }
        if (message.id === 1) {
          send({ method: "initialized" })
          send({ id: 2, method })
        } else if (message.id === 2) {
          if (message.error) finish(new Error(message.error.message ?? "codex 回了错误"))
          else finish(null, message.result)
        }
      }
    })
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "bench", version: "1" } } })
  })
}

// ---- Antigravity: its CLI answers `agy -p /quota` locally (no model turn, no
// new conversation) with tab-separated lines per model group:
//   Gemini Models	Five Hour Limit Remaining	99%	2026-11-10T02:47:20Z
// It says what is left; the room shows what is used, like the others.
async function antigravityQuota(): Promise<Quota> {
  const env = { ...process.env, PATH: summonPath() }
  if (!installed("agy")) return empty("antigravity", { error: "没找到 agy" })
  let stdout = ""
  try {
    stdout = await new Promise<string>((resolve, reject) =>
      execFile(...cliCommand("agy", ["-p", "/quota"]), { cwd: os.tmpdir(), env, timeout: 30_000, windowsHide: true }, (error, out) =>
        error ? reject(error) : resolve(out),
      ),
    )
  } catch (error) {
    return empty("antigravity", { error: `读不到额度：${(error as Error).message.split("\n")[0]}` })
  }
  const windows: QuotaWindow[] = []
  for (const line of stdout.split("\n")) {
    const [group, name, left, at] = line.split("\t").map((part) => part?.trim())
    if (!group || !name || !left) continue
    const remaining = Number.parseFloat(left)
    if (!Number.isFinite(remaining)) continue
    const who = /gemini/i.test(group) ? "Gemini" : /claude|gpt/i.test(group) ? "Claude/GPT" : group.replace(/\s*models?$/i, "")
    const span = /five hour|5.?hour/i.test(name) ? "5h" : /week/i.test(name) ? "week" : "other"
    const label = span === "5h" ? "5 小时" : span === "week" ? "每周" : name.replace(/\s*limit remaining$/i, "")
    windows.push({ span, label, group: who, percent: clampPercent(100 - remaining), resetsAt: at || null })
  }
  if (windows.length === 0) return empty("antigravity", { error: "agy /quota 没给出额度（可能没用账号登录）" })
  // Gemini first, and the 5-hour window before the week within a group.
  const rank = (window: QuotaWindow) => (window.group === "Gemini" ? 0 : 2) + (window.span === "5h" ? 0 : 1)
  windows.sort((a, b) => rank(a) - rank(b))
  return empty("antigravity", { account: true, windows, blocked: windows.some((window) => window.percent >= 100) })
}

// ---- Cursor: no 5-hour or weekly window; its allowance runs per monthly
// billing cycle, split into Auto (Cursor picks the model) and API (a named
// model). Read from the same dashboard calls its CLI's /usage makes, with the
// login in ~/.config/cursor/auth.json. Paid plans can also have a rolling
// window (GetSandUsageStatus); shown when there is one.
async function cursorQuota(): Promise<Quota> {
  let token: string | undefined
  try {
    token = JSON.parse(readFileSync(path.join(os.homedir(), ".config", "cursor", "auth.json"), "utf8")).accessToken
  } catch {}
  if (!token) return empty("cursor", { error: "没用账号登录" })
  const call = async (method: string) => {
    const response = await fetch(`https://api2.cursor.sh/aiserver.v1.DashboardService/${method}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Connect-Protocol-Version": "1" },
      body: "{}",
      signal: AbortSignal.timeout(15_000),
    })
    if (response.status === 401) throw new Error("登录过期了，cursor-agent 下次运行会自己续上")
    if (!response.ok) throw new Error(`额度接口回了 ${response.status}`)
    return response.json()
  }
  try {
    const [period, plan, sand] = await Promise.all([
      call("GetCurrentPeriodUsage") as Promise<{
        billingCycleEnd?: string
        planUsage?: { totalPercentUsed?: number; autoPercentUsed?: number; apiPercentUsed?: number }
      }>,
      (call("GetPlanInfo") as Promise<{ planInfo?: { planName?: string } }>).catch(() => null),
      (call("GetSandUsageStatus") as Promise<{ usagePercent?: number; nextResetTimestampUtc?: string; includedLimitZero?: boolean }>).catch(() => null),
    ])
    const end = Number(period.billingCycleEnd)
    const resetsAt = Number.isFinite(end) && end > 0 ? new Date(end).toISOString() : null
    const usage = period.planUsage ?? {}
    const windows: QuotaWindow[] = []
    if (sand && !sand.includedLimitZero && typeof sand.usagePercent === "number") {
      windows.push({ span: "other", label: "滚动额度", percent: clampPercent(sand.usagePercent), resetsAt: sand.nextResetTimestampUtc ?? null })
    }
    windows.push({ span: "month", label: "本月合计", percent: clampPercent(usage.totalPercentUsed), resetsAt })
    if (typeof usage.autoPercentUsed === "number") windows.push({ span: "month", label: "Auto", percent: clampPercent(usage.autoPercentUsed), resetsAt })
    if (typeof usage.apiPercentUsed === "number") windows.push({ span: "month", label: "API", percent: clampPercent(usage.apiPercentUsed), resetsAt })
    return empty("cursor", {
      account: true,
      plan: plan?.planInfo?.planName ?? null,
      windows,
      blocked: windows.some((window) => window.percent >= 100),
    })
  } catch (error) {
    return empty("cursor", { account: true, error: (error as Error).message })
  }
}
