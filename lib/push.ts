import { createHmac } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import http from "node:http"
import https from "node:https"
import net from "node:net"
import path from "node:path"
import tls from "node:tls"

import { ApiError, asRecord, asString } from "@/lib/http"

// Optional mobile / webhook notifications when something in any project waits
// on the user while they are away from the page.
//
// Security boundaries:
// - Credentials live ONLY in `data/push.json` with mode 0o600.
// - No API response, room snapshot, chat message, or error string ever echoes
//   back a target URL, token, or chat id — only boolean `filled` flags.
// - Off by default; never sends anything unless enabled and configured.

export type PushChannelId = "ntfy" | "bark" | "wecom" | "feishu" | "telegram" | "webhook"

export type PushEventKind = "ask" | "review" | "permit" | "end" | "test"

export type PushCredentials = {
  target: string
  token: string
  extra: string
}

export type PushFieldSpec = {
  label: string
  placeholder: string
  required?: boolean
  secret?: boolean
}

export type PushChannelSpec = {
  id: PushChannelId
  label: string
  hint: string
  fields: {
    target?: PushFieldSpec
    token?: PushFieldSpec
    extra?: PushFieldSpec
  }
}

export type PublicPushState = {
  enabled: boolean
  channel: PushChannelId
  configured: boolean
  filled: {
    target: boolean
    token: boolean
    extra: boolean
  }
  onEnd: boolean
  titleOnly: boolean
  lastError: { at: number; message: string } | null
  lastOkAt: number | null
  channels: PushChannelSpec[]
}

type StoredPushConfig = {
  enabled: boolean
  channel: PushChannelId
  target: string
  token: string
  extra: string
  onEnd: boolean
  titleOnly: boolean
  lastError: { at: number; message: string } | null
  lastOkAt: number | null
}

type FormattedPush = {
  project: string
  headerTitle: string
  headerBody: string
  fullText: string
  webhookJson: Record<string, unknown>
}

type BuiltRequest = {
  url: string
  method: "POST"
  headers: Record<string, string>
  body: string
}

type ChannelDef = PushChannelSpec & {
  validate: (cred: PushCredentials) => string | null
  buildRequest: (cred: PushCredentials, msg: FormattedPush) => BuiltRequest
  checkResponse?: (status: number, bodyText: string) => string | null
}

const SNIPPET_LIMIT = 60
const FOREGROUND_WINDOW_MS = 60_000
const DEFAULT_MERGE_WINDOW_MS = 20_000
const DEFAULT_PERMIT_WAIT_MS = 30_000
const PERMIT_MICRO_BATCH_MS = 400
const REQUEST_TIMEOUT_MS = 10_000
const RETRY_DELAY_MS = 1_200

function envPositiveMs(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const num = Number(raw)
  return Number.isFinite(num) && num >= 50 ? Math.round(num) : fallback
}

function mergeWindowMs(): number {
  return envPositiveMs("BENCH_PUSH_MERGE_MS", DEFAULT_MERGE_WINDOW_MS)
}

function permitWaitMs(): number {
  return envPositiveMs("BENCH_PUSH_PERMIT_MS", DEFAULT_PERMIT_WAIT_MS)
}

function parseHttpUrl(raw: string): URL | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  try {
    const parsed = new URL(trimmed)
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null
    if (!parsed.hostname) return null
    return parsed
  } catch {
    return null
  }
}

function encodeRfc2047(text: string): string {
  const clean = text.replace(/[\r\n]+/g, " ").trim()
  if (!clean) return "Bench"
  if (/^[\x20-\x7e]+$/.test(clean)) return clean
  return `=?UTF-8?B?${Buffer.from(clean, "utf8").toString("base64")}?=`
}

function bearerHeader(token: string): string {
  const trimmed = token.trim()
  return /^Bearer\s+/i.test(trimmed) ? trimmed : `Bearer ${trimmed}`
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {}
  return null
}

// Table of supported notification channels. Adding a new provider only takes
// appending an entry here.
const CHANNEL_TABLE: ChannelDef[] = [
  {
    id: "ntfy",
    label: "ntfy",
    hint: "填完整主题地址（如 https://ntfy.sh/你的主题，或自建地址）；私有主题可填访问口令。",
    fields: {
      target: { label: "主题地址", placeholder: "https://ntfy.sh/my-topic", required: true, secret: true },
      token: { label: "访问口令（可选）", placeholder: "tk_…（公开主题留空）", secret: true },
    },
    validate(cred) {
      const url = parseHttpUrl(cred.target)
      if (!url) return "请填 http:// 或 https:// 开头的 ntfy 主题地址"
      if (!url.pathname || url.pathname === "/") return "ntfy 地址末尾要带上主题名（例如 /my-topic）"
      return null
    },
    buildRequest(cred, msg) {
      const headers: Record<string, string> = {
        "Content-Type": "text/plain; charset=utf-8",
        Title: encodeRfc2047(msg.headerTitle),
      }
      if (cred.token.trim()) headers.Authorization = bearerHeader(cred.token)
      return {
        url: cred.target.trim(),
        method: "POST",
        headers,
        body: msg.headerBody || msg.headerTitle,
      }
    },
  },
  {
    id: "bark",
    label: "Bark",
    hint: "填 Bark App 里的推送地址（如 https://api.day.app/你的Key，或自建地址）。",
    fields: {
      target: { label: "Bark 地址", placeholder: "https://api.day.app/你的Key", required: true, secret: true },
    },
    validate(cred) {
      const url = parseHttpUrl(cred.target)
      if (!url) return "请填 http:// 或 https:// 开头的 Bark 地址"
      if (!url.pathname || url.pathname === "/") return "Bark 地址里要带上设备 Key（例如 https://api.day.app/你的Key）"
      return null
    },
    buildRequest(cred, msg) {
      return {
        url: cred.target.trim().replace(/\/+$/, ""),
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          title: msg.headerTitle,
          body: msg.headerBody || msg.headerTitle,
          group: "并坐",
        }),
      }
    },
    checkResponse(_status, bodyText) {
      const data = parseJsonObject(bodyText)
      if (data && typeof data.code === "number" && data.code !== 200) {
        return `Bark 返回错误 (${data.code})`
      }
      return null
    },
  },
  {
    id: "wecom",
    label: "企业微信群机器人",
    hint: "在企业微信群添加「群机器人」，复制它的 Webhook 地址。",
    fields: {
      target: {
        label: "Webhook 地址",
        placeholder: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…",
        required: true,
        secret: true,
      },
    },
    validate(cred) {
      if (!parseHttpUrl(cred.target)) return "请填 http:// 或 https:// 开头的企业微信 Webhook 地址"
      return null
    },
    buildRequest(cred, msg) {
      return {
        url: cred.target.trim(),
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          msgtype: "text",
          text: { content: msg.fullText },
        }),
      }
    },
    checkResponse(_status, bodyText) {
      const data = parseJsonObject(bodyText)
      if (data && typeof data.errcode === "number" && data.errcode !== 0) {
        return `企业微信返回错误 (${data.errcode})`
      }
      return null
    },
  },
  {
    id: "feishu",
    label: "飞书群机器人",
    hint: "在飞书群添加「自定义机器人」，复制 Webhook 地址；若开了签名校验可填密钥。",
    fields: {
      target: {
        label: "Webhook 地址",
        placeholder: "https://open.feishu.cn/open-apis/bot/v2/hook/…",
        required: true,
        secret: true,
      },
      token: { label: "签名密钥（可选）", placeholder: "没开签名校验就留空", secret: true },
    },
    validate(cred) {
      if (!parseHttpUrl(cred.target)) return "请填 http:// 或 https:// 开头的飞书 Webhook 地址"
      return null
    },
    buildRequest(cred, msg) {
      const secret = cred.token.trim()
      let authFields: { timestamp?: string; sign?: string } = {}
      if (secret) {
        const timestamp = String(Math.floor(Date.now() / 1000))
        const sign = createHmac("sha256", `${timestamp}\n${secret}`).update("").digest("base64")
        authFields = { timestamp, sign }
      }
      return {
        url: cred.target.trim(),
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          ...authFields,
          msg_type: "text",
          content: { text: msg.fullText },
        }),
      }
    },
    checkResponse(_status, bodyText) {
      const data = parseJsonObject(bodyText)
      if (data && typeof data.code === "number" && data.code !== 0) {
        return `飞书返回错误 (${data.code})`
      }
      if (data && typeof data.StatusCode === "number" && data.StatusCode !== 0) {
        return `飞书返回错误 (${data.StatusCode})`
      }
      return null
    },
  },
  {
    id: "telegram",
    label: "Telegram 机器人",
    hint: "填 @BotFather 给的 Bot Token 和接收消息的 Chat ID；自建反代可填 API 地址。",
    fields: {
      token: { label: "Bot Token", placeholder: "123456789:AAH…", required: true, secret: true },
      extra: { label: "Chat ID", placeholder: "12345678 或 -100…", required: true, secret: true },
      target: { label: "API 地址（可选）", placeholder: "默认 https://api.telegram.org", secret: true },
    },
    validate(cred) {
      if (!cred.token.trim() || /\s/.test(cred.token.trim())) return "请填有效的 Telegram Bot Token"
      if (!cred.extra.trim()) return "请填接收消息的 Chat ID"
      if (cred.target.trim() && !parseHttpUrl(cred.target)) {
        return "API 地址要以 http:// 或 https:// 开头（留空则用官方地址）"
      }
      return null
    },
    buildRequest(cred, msg) {
      const base = (cred.target.trim() || "https://api.telegram.org").replace(/\/+$/, "")
      const encodedToken = encodeURIComponent(cred.token.trim()).replace(/%3A/gi, ":")
      return {
        url: `${base}/bot${encodedToken}/sendMessage`,
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          chat_id: cred.extra.trim(),
          text: msg.fullText,
        }),
      }
    },
    checkResponse(status, bodyText) {
      const data = parseJsonObject(bodyText)
      if (data && data.ok === false) {
        return `Telegram 返回错误 (${typeof data.error_code === "number" ? data.error_code : status})`
      }
      return null
    },
  },
  {
    id: "webhook",
    label: "自定义 Webhook",
    hint: "向你填的地址 POST JSON（含 project、title、body、text、items）；可选填 Bearer 口令。",
    fields: {
      target: { label: "Webhook 地址", placeholder: "https://example.com/hook", required: true, secret: true },
      token: { label: "Bearer 口令（可选）", placeholder: "留空则不带 Authorization 头", secret: true },
    },
    validate(cred) {
      if (!parseHttpUrl(cred.target)) return "请填 http:// 或 https:// 开头的 Webhook 地址"
      return null
    },
    buildRequest(cred, msg) {
      const headers: Record<string, string> = { "Content-Type": "application/json; charset=utf-8" }
      if (cred.token.trim()) headers.Authorization = bearerHeader(cred.token)
      return {
        url: cred.target.trim(),
        method: "POST",
        headers,
        body: JSON.stringify(msg.webhookJson),
      }
    },
  },
]

const CHANNEL_SPECS: PushChannelSpec[] = CHANNEL_TABLE.map(({ id, label, hint, fields }) => ({
  id,
  label,
  hint,
  fields,
}))

function channelById(id: string): ChannelDef | undefined {
  return CHANNEL_TABLE.find((item) => item.id === id)
}

export type PendingPushItem = {
  projectId: string
  getProjectName: () => string
  kind: Exclude<PushEventKind, "test">
  actor: string
  what: string
  snippet: string
  at: number
  stillValid?: () => boolean
}

type ProjectBatch = {
  timer: ReturnType<typeof setTimeout>
  items: PendingPushItem[]
}

type PushRuntime = {
  dataDir: string
  loaded: boolean
  config: StoredPushConfig
  lastForegroundAt: number
  batches: Map<string, ProjectBatch>
  permitTimers: Map<string, ReturnType<typeof setTimeout>>
}

const globalStore = globalThis as typeof globalThis & { __benchPush?: PushRuntime }

function dataDirPath(): string {
  return process.env.BENCH_DATA_DIR || path.join(process.cwd(), "data")
}

function pushFilePath(): string {
  return path.join(dataDirPath(), "push.json")
}

function defaultConfig(): StoredPushConfig {
  return {
    enabled: false,
    channel: "ntfy",
    target: "",
    token: "",
    extra: "",
    onEnd: false,
    titleOnly: false,
    lastError: null,
    lastOkAt: null,
  }
}

function loadFromDisk(file: string): StoredPushConfig {
  const base = defaultConfig()
  if (!existsSync(file)) return base
  try {
    try {
      chmodSync(file, 0o600)
    } catch {}
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<StoredPushConfig>
    if (typeof raw !== "object" || raw === null) return base
    const channel = typeof raw.channel === "string" && channelById(raw.channel) ? (raw.channel as PushChannelId) : "ntfy"
    const lastError =
      raw.lastError &&
      typeof raw.lastError === "object" &&
      typeof raw.lastError.at === "number" &&
      typeof raw.lastError.message === "string"
        ? { at: raw.lastError.at, message: raw.lastError.message.slice(0, 200) }
        : null
    return {
      enabled: raw.enabled === true,
      channel,
      target: typeof raw.target === "string" ? raw.target : "",
      token: typeof raw.token === "string" ? raw.token : "",
      extra: typeof raw.extra === "string" ? raw.extra : "",
      onEnd: raw.onEnd === true,
      titleOnly: raw.titleOnly === true,
      lastError,
      lastOkAt: typeof raw.lastOkAt === "number" ? raw.lastOkAt : null,
    }
  } catch {
    return base
  }
}

function saveToDisk(cfg: StoredPushConfig) {
  const file = pushFilePath()
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp.${process.pid}`
  writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 })
  try {
    chmodSync(tmp, 0o600)
  } catch {}
  renameSync(tmp, file)
  try {
    chmodSync(file, 0o600)
  } catch {}
}

function state(): PushRuntime {
  const dir = dataDirPath()
  if (!globalStore.__benchPush || globalStore.__benchPush.dataDir !== dir) {
    if (globalStore.__benchPush) {
      for (const batch of globalStore.__benchPush.batches.values()) clearTimeout(batch.timer)
      for (const timer of globalStore.__benchPush.permitTimers.values()) clearTimeout(timer)
    }
    globalStore.__benchPush = {
      dataDir: dir,
      loaded: true,
      config: loadFromDisk(path.join(dir, "push.json")),
      lastForegroundAt: 0,
      batches: new Map(),
      permitTimers: new Map(),
    }
  } else if (!globalStore.__benchPush.loaded) {
    globalStore.__benchPush.config = loadFromDisk(path.join(dir, "push.json"))
    globalStore.__benchPush.loaded = true
  }
  return globalStore.__benchPush
}

function credentialsOf(cfg: StoredPushConfig): PushCredentials {
  return { target: cfg.target, token: cfg.token, extra: cfg.extra }
}

function isChannelConfigured(cfg: StoredPushConfig): boolean {
  const def = channelById(cfg.channel)
  if (!def) return false
  return def.validate(credentialsOf(cfg)) === null
}

function canSendAuto(cfg: StoredPushConfig): boolean {
  return cfg.enabled && isChannelConfigured(cfg)
}

export function getPublicPushState(): PublicPushState {
  const cfg = state().config
  return {
    enabled: cfg.enabled,
    channel: cfg.channel,
    configured: isChannelConfigured(cfg),
    filled: {
      target: Boolean(cfg.target.trim()),
      token: Boolean(cfg.token.trim()),
      extra: Boolean(cfg.extra.trim()),
    },
    onEnd: cfg.onEnd,
    titleOnly: cfg.titleOnly,
    lastError: cfg.lastError,
    lastOkAt: cfg.lastOkAt,
    channels: CHANNEL_SPECS,
  }
}

export function noteClientPresence(front = true) {
  const rt = state()
  if (front) {
    rt.lastForegroundAt = Date.now()
  } else {
    rt.lastForegroundAt = 0
  }
}

export function isClientInForeground(now = Date.now()): boolean {
  const last = state().lastForegroundAt
  return last > 0 && now - last < FOREGROUND_WINDOW_MS
}

// Update settings from the page. Unchanged secret inputs may be omitted (`undefined`)
// when staying on the same channel so the user can toggle options without re-typing
// their URL/token; switching channels without providing new values clears old secrets
// so credentials for one service are never sent to another.
export function updatePushSettings(input: unknown): PublicPushState {
  const body = asRecord(input)
  const rt = state()
  const prev = rt.config

  if (body.action === "clear") {
    for (const batch of rt.batches.values()) clearTimeout(batch.timer)
    rt.batches.clear()
    for (const timer of rt.permitTimers.values()) clearTimeout(timer)
    rt.permitTimers.clear()
    rt.config = defaultConfig()
    saveToDisk(rt.config)
    return getPublicPushState()
  }

  const nextChannelRaw = asString(body.channel) ?? prev.channel
  const def = channelById(nextChannelRaw)
  if (!def) throw new ApiError(400, "不支持这种推送方式")
  const sameChannel = def.id === prev.channel

  const pickSecret = (key: "target" | "token" | "extra"): string => {
    if (key in body && body[key] !== undefined && body[key] !== null) {
      if (typeof body[key] !== "string") throw new ApiError(400, `${key} 要是字符串`)
      return (body[key] as string).trim()
    }
    return sameChannel ? prev[key] : ""
  }

  const target = pickSecret("target")
  const token = pickSecret("token")
  const extra = pickSecret("extra")
  const enabled = typeof body.enabled === "boolean" ? body.enabled : prev.enabled
  const onEnd = typeof body.onEnd === "boolean" ? body.onEnd : prev.onEnd
  const titleOnly = typeof body.titleOnly === "boolean" ? body.titleOnly : prev.titleOnly

  if (enabled) {
    const problem = def.validate({ target, token, extra })
    if (problem) throw new ApiError(400, problem)
  } else {
    // Even while disabled, validate any non-empty fields so typos are caught early.
    const anyTyped = Boolean(target || token || extra)
    if (anyTyped && ("target" in body || "token" in body || "extra" in body)) {
      const problem = def.validate({ target, token, extra })
      if (problem) throw new ApiError(400, problem)
    }
  }

  const credsChanged = target !== prev.target || token !== prev.token || extra !== prev.extra || def.id !== prev.channel
  rt.config = {
    enabled,
    channel: def.id,
    target,
    token,
    extra,
    onEnd,
    titleOnly,
    lastError: credsChanged ? null : prev.lastError,
    lastOkAt: credsChanged ? null : prev.lastOkAt,
  }
  saveToDisk(rt.config)

  if (!canSendAuto(rt.config)) {
    for (const batch of rt.batches.values()) clearTimeout(batch.timer)
    rt.batches.clear()
  }

  return getPublicPushState()
}

function cleanSnippet(raw: string): string {
  const withoutEnd = raw.replace(/^【本轮结束】\s*/, "")
  const singleLine = withoutEnd.replace(/\s+/g, " ").trim()
  if (!singleLine) return ""
  const chars = [...singleLine]
  return chars.length > SNIPPET_LIMIT ? `${chars.slice(0, SNIPPET_LIMIT).join("")}…` : singleLine
}

function formatBatch(
  projectName: string,
  items: Array<{ kind: PushEventKind; actor: string; what: string; snippet: string; at: number }>,
  titleOnly: boolean,
): FormattedPush {
  const project = projectName.trim() || "并坐"
  if (items.length === 1) {
    const only = items[0]
    const snippet = titleOnly ? "" : cleanSnippet(only.snippet)
    const headline = `「${project}」${only.actor} ${only.what}`
    const headerTitle = titleOnly ? `并坐 · ${project}` : headline
    const headerBody = titleOnly ? `${only.actor} ${only.what}` : snippet || `${only.actor} ${only.what}`
    const fullText = snippet ? `${headline}\n${snippet}` : headline
    return {
      project,
      headerTitle,
      headerBody,
      fullText,
      webhookJson: {
        source: "bench",
        project,
        title: headline,
        body: snippet,
        text: fullText,
        count: 1,
        items: [
          {
            kind: only.kind,
            actor: only.actor,
            what: only.what,
            ...(titleOnly ? {} : { snippet }),
            at: only.at,
          },
        ],
        at: Date.now(),
      },
    }
  }

  const lines = items.map((item) => {
    const snippet = titleOnly ? "" : cleanSnippet(item.snippet)
    return snippet ? `· ${item.actor} ${item.what}：${snippet}` : `· ${item.actor} ${item.what}`
  })
  const headerTitle = `「${project}」有 ${items.length} 件事等你`
  const headerBody = lines.join("\n")
  const fullText = `${headerTitle}\n${headerBody}`
  return {
    project,
    headerTitle,
    headerBody,
    fullText,
    webhookJson: {
      source: "bench",
      project,
      title: headerTitle,
      body: titleOnly ? "" : headerBody,
      text: fullText,
      count: items.length,
      items: items.map((item) => ({
        kind: item.kind,
        actor: item.actor,
        what: item.what,
        ...(titleOnly ? {} : { snippet: cleanSnippet(item.snippet) }),
        at: item.at,
      })),
      at: Date.now(),
    },
  }
}

// ---- Proxy-aware zero-dependency HTTP/HTTPS sender ----

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".")
  if (parts.length !== 4) return null
  let acc = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const num = Number(part)
    if (num < 0 || num > 255) return null
    acc = ((acc << 8) | num) >>> 0
  }
  return acc
}

function matchesCidr(hostIp: string, cidr: string): boolean {
  const slash = cidr.indexOf("/")
  if (slash <= 0) return false
  const netInt = ipv4ToInt(cidr.slice(0, slash))
  const hostInt = ipv4ToInt(hostIp)
  const bits = Number(cidr.slice(slash + 1))
  if (netInt === null || hostInt === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false
  if (bits === 0) return true
  const mask = (0xffffffff << (32 - bits)) >>> 0
  return (hostInt & mask) >>> 0 === (netInt & mask) >>> 0
}

function shouldBypassProxy(hostname: string, port: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase()
  const rawNoProxy = process.env.NO_PROXY ?? process.env.no_proxy ?? "localhost,127.0.0.1,::1"
  const entries = rawNoProxy
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
  if (entries.length === 0) return false
  for (const entry of entries) {
    if (entry === "*") return true
    if (entry.includes("/") && matchesCidr(host, entry)) return true
    const [entryHostRaw, entryPort] = entry.startsWith("[")
      ? (() => {
          const close = entry.indexOf("]")
          if (close < 0) return [entry, ""]
          const rest = entry.slice(close + 1)
          return [entry.slice(1, close), rest.startsWith(":") ? rest.slice(1) : ""]
        })()
      : entry.split(":")
    if (entryPort && port && entryPort !== port) continue
    const entryHost = entryHostRaw.replace(/^\.+/, "")
    if (!entryHost) continue
    if (host === entryHost || host.endsWith(`.${entryHost}`)) return true
  }
  return false
}

function pickProxyUrl(target: URL): URL | null {
  const defaultPort = target.protocol === "https:" ? "443" : "80"
  if (shouldBypassProxy(target.hostname, target.port || defaultPort)) return null
  const candidates =
    target.protocol === "https:"
      ? [process.env.HTTPS_PROXY, process.env.https_proxy, process.env.ALL_PROXY, process.env.all_proxy]
      : [process.env.HTTP_PROXY, process.env.http_proxy, process.env.ALL_PROXY, process.env.all_proxy]
  for (const candidate of candidates) {
    if (!candidate?.trim()) continue
    try {
      const parsed = new URL(candidate.trim())
      if (
        parsed.protocol === "http:" ||
        parsed.protocol === "https:" ||
        parsed.protocol === "socks5:" ||
        parsed.protocol === "socks5h:"
      ) {
        return parsed
      }
    } catch {}
  }
  return null
}

function proxyAuthHeader(proxy: URL): string | undefined {
  if (!proxy.username && !proxy.password) return undefined
  const decoded = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`
  return `Basic ${Buffer.from(decoded, "utf8").toString("base64")}`
}

function openHttpConnectTunnel(proxy: URL, targetHost: string, targetPort: number, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const proxyMod = proxy.protocol === "https:" ? https : http
    const proxyPort = Number(proxy.port) || (proxy.protocol === "https:" ? 443 : 80)
    const headers: Record<string, string> = {
      Host: `${targetHost}:${targetPort}`,
    }
    const auth = proxyAuthHeader(proxy)
    if (auth) headers["Proxy-Authorization"] = auth

    const req = proxyMod.request({
      host: proxy.hostname,
      port: proxyPort,
      method: "CONNECT",
      path: `${targetHost}:${targetPort}`,
      headers,
      timeout: timeoutMs,
    })

    let settled = false
    const fail = (err: Error) => {
      if (settled) return
      settled = true
      req.destroy()
      reject(err)
    }

    req.once("connect", (res, socket) => {
      if (settled) {
        socket.destroy()
        return
      }
      if (res.statusCode !== 200) {
        socket.destroy()
        fail(new Error(`代理拒绝连接 (HTTP ${res.statusCode ?? 0})`))
        return
      }
      settled = true
      resolve(socket)
    })
    req.once("timeout", () => fail(Object.assign(new Error("连接代理超时"), { code: "ETIMEDOUT" })))
    req.once("error", fail)
    req.end()
  })
}

function openSocks5Tunnel(proxy: URL, targetHost: string, targetPort: number, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const proxyPort = Number(proxy.port) || 1080
    const socket = net.connect({ host: proxy.hostname, port: proxyPort })
    let settled = false
    const timer = setTimeout(() => {
      fail(Object.assign(new Error("连接代理超时"), { code: "ETIMEDOUT" }))
    }, timeoutMs)

    const fail = (err: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      reject(err)
    }

    let stage: "greeting" | "connect" = "greeting"
    let buf = Buffer.alloc(0)

    socket.once("error", fail)
    socket.once("close", () => {
      if (!settled) fail(Object.assign(new Error("代理连接关闭"), { code: "ECONNRESET" }))
    })

    socket.once("connect", () => {
      socket.write(Buffer.from([0x05, 0x01, 0x00]))
    })

    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk])
      if (stage === "greeting") {
        if (buf.length < 2) return
        if (buf[0] !== 0x05 || buf[1] !== 0x00) {
          fail(new Error("SOCKS5 代理需要认证或协议不兼容"))
          return
        }
        buf = buf.subarray(2)
        stage = "connect"
        const hostBytes = Buffer.from(targetHost, "utf8")
        const req = Buffer.alloc(4 + 1 + hostBytes.length + 2)
        req[0] = 0x05
        req[1] = 0x01
        req[2] = 0x00
        req[3] = 0x03
        req[4] = hostBytes.length
        hostBytes.copy(req, 5)
        req.writeUInt16BE(targetPort, 5 + hostBytes.length)
        socket.write(req)
      }
      if (stage === "connect") {
        if (buf.length < 4) return
        if (buf[1] !== 0x00) {
          fail(new Error(`SOCKS5 代理连接目标失败 (${buf[1]})`))
          return
        }
        const atyp = buf[3]
        let need = 4
        if (atyp === 0x01) need += 4 + 2
        else if (atyp === 0x04) need += 16 + 2
        else if (atyp === 0x03) {
          if (buf.length < 5) return
          need += 1 + buf[4] + 2
        } else {
          fail(new Error("SOCKS5 代理响应异常"))
          return
        }
        if (buf.length < need) return
        socket.off("data", onData)
        clearTimeout(timer)
        settled = true
        const leftover = buf.subarray(need)
        if (leftover.length > 0) socket.unshift(leftover)
        resolve(socket)
      }
    }

    socket.on("data", onData)
  })
}

async function sendOnce(built: BuiltRequest, timeoutMs: number): Promise<{ status: number; body: string }> {
  const target = new URL(built.url)
  const isHttps = target.protocol === "https:"
  const targetPort = Number(target.port) || (isHttps ? 443 : 80)
  const bodyBuf = Buffer.from(built.body, "utf8")
  const headers: Record<string, string | number> = {
    ...built.headers,
    "Content-Length": bodyBuf.length,
    "User-Agent": "bench-room-push",
  }

  const proxy = pickProxyUrl(target)

  // Plain HTTP via an HTTP(S) proxy uses forward-proxy request form.
  if (proxy && !isHttps && (proxy.protocol === "http:" || proxy.protocol === "https:")) {
    const proxyMod = proxy.protocol === "https:" ? https : http
    const proxyPort = Number(proxy.port) || (proxy.protocol === "https:" ? 443 : 80)
    const auth = proxyAuthHeader(proxy)
    if (auth) headers["Proxy-Authorization"] = auth
    headers.Host = target.host
    return new Promise((resolve, reject) => {
      const req = proxyMod.request(
        {
          host: proxy.hostname,
          port: proxyPort,
          method: built.method,
          path: target.toString(),
          headers,
          timeout: timeoutMs,
        },
        (res) => collectResponse(res, resolve, reject),
      )
      req.once("timeout", () => {
        req.destroy(Object.assign(new Error("请求超时"), { code: "ETIMEDOUT" }))
      })
      req.once("error", reject)
      req.end(bodyBuf)
    })
  }

  let tunnelSocket: net.Socket | undefined
  if (proxy) {
    tunnelSocket =
      proxy.protocol === "socks5:" || proxy.protocol === "socks5h:"
        ? await openSocks5Tunnel(proxy, target.hostname, targetPort, timeoutMs)
        : await openHttpConnectTunnel(proxy, target.hostname, targetPort, timeoutMs)
  }

  return new Promise((resolve, reject) => {
    const mod = isHttps ? https : http
    const options: https.RequestOptions = {
      protocol: target.protocol,
      hostname: target.hostname,
      port: targetPort,
      method: built.method,
      path: `${target.pathname}${target.search}`,
      headers,
      timeout: timeoutMs,
    }
    if (tunnelSocket) {
      if (isHttps) {
        const tlsSocket = tls.connect({
          socket: tunnelSocket,
          servername: net.isIP(target.hostname) ? undefined : target.hostname,
        })
        options.createConnection = () => tlsSocket
      } else {
        options.createConnection = () => tunnelSocket!
      }
    }
    const req = mod.request(options, (res) => collectResponse(res, resolve, reject))
    req.once("timeout", () => {
      req.destroy(Object.assign(new Error("请求超时"), { code: "ETIMEDOUT" }))
    })
    req.once("error", (err) => {
      tunnelSocket?.destroy()
      reject(err)
    })
    req.end(bodyBuf)
  })
}

function collectResponse(
  res: http.IncomingMessage,
  resolve: (out: { status: number; body: string }) => void,
  reject: (err: Error) => void,
) {
  const chunks: Buffer[] = []
  let total = 0
  res.on("data", (chunk: Buffer) => {
    if (total < 16_384) {
      chunks.push(chunk)
      total += chunk.length
    }
  })
  res.once("end", () => {
    resolve({
      status: res.statusCode ?? 0,
      body: Buffer.concat(chunks).toString("utf8"),
    })
  })
  res.once("error", reject)
}

function sanitizeError(err: unknown, cred: PushCredentials): string {
  const code =
    typeof err === "object" && err !== null && "code" in err && typeof (err as { code?: unknown }).code === "string"
      ? ((err as { code: string }).code ?? "")
      : ""
  if (code === "ECONNREFUSED") return "连接被拒绝（请确认接收端地址和端口可访问）"
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "找不到服务器域名（DNS 解析失败）"
  if (code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT") return "请求超时"
  if (code === "ECONNRESET" || code === "EPIPE") return "连接中途断开"
  if (code.startsWith("ERR_TLS") || code.includes("CERT")) return "TLS 证书校验失败"

  let message = err instanceof Error ? err.message : String(err ?? "发送失败")

  // Strip every secret fragment, URL query, and URL path segment from the message.
  const secrets = [cred.target, cred.token, cred.extra]
    .map((item) => item.trim())
    .filter((item) => item.length >= 2)
  for (const secret of secrets) {
    message = message.split(secret).join("[已隐藏]")
    const encoded = encodeURIComponent(secret)
    if (encoded.length >= 2) message = message.split(encoded).join("[已隐藏]")
    const parsed = parseHttpUrl(secret)
    if (parsed) {
      message = message.split(parsed.toString()).join("[已隐藏]")
      if (parsed.pathname && parsed.pathname !== "/") message = message.split(parsed.pathname).join("[已隐藏]")
      if (parsed.search) message = message.split(parsed.search).join("[已隐藏]")
      if (parsed.host) message = message.split(parsed.host).join("[已隐藏]")
    }
  }
  message = message.replace(/https?:\/\/\S+/gi, "[地址已隐藏]")
  message = message.replace(/\s+/g, " ").trim()
  return message.slice(0, 140) || "发送失败"
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

// Delivers a formatted payload using the active channel, retrying at most ONCE on failure.
async function deliverFormatted(
  cfg: StoredPushConfig,
  formatted: FormattedPush,
  retryGapMs = RETRY_DELAY_MS,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const def = channelById(cfg.channel)
  if (!def) return { ok: false, error: "不支持这种推送方式" }
  const cred = credentialsOf(cfg)
  const invalid = def.validate(cred)
  if (invalid) return { ok: false, error: invalid }

  const built = def.buildRequest(cred, formatted)
  let lastProblem = "发送失败"

  // Initial attempt + at most 1 retry = 2 attempts total.
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await delay(retryGapMs)
    try {
      const res = await sendOnce(built, REQUEST_TIMEOUT_MS)
      if (res.status < 200 || res.status >= 300) {
        lastProblem = `对方服务器回了 HTTP ${res.status}`
        continue
      }
      const businessProblem = def.checkResponse?.(res.status, res.body)
      if (businessProblem) {
        lastProblem = sanitizeError(businessProblem, cred)
        continue
      }
      const rt = state()
      rt.config.lastOkAt = Date.now()
      rt.config.lastError = null
      saveToDisk(rt.config)
      return { ok: true }
    } catch (err) {
      lastProblem = sanitizeError(err, cred)
    }
  }

  const rt = state()
  rt.config.lastError = { at: Date.now(), message: lastProblem }
  saveToDisk(rt.config)
  return { ok: false, error: lastProblem }
}

// Manual "测一下" from the settings dialog. Ignores foreground suppression so
// the user can test right from the page; optionally accepts unsaved draft fields
// by saving or testing against the stored config.
export async function sendTestPush(projectName = "并坐"): Promise<{ ok: boolean; state: PublicPushState; error?: string }> {
  const cfg = state().config
  const def = channelById(cfg.channel)
  if (!def) throw new ApiError(400, "不支持这种推送方式")
  const problem = def.validate(credentialsOf(cfg))
  if (problem) throw new ApiError(400, `还没填好：${problem}`)

  const formatted = formatBatch(
    projectName,
    [
      {
        kind: "test",
        actor: "并坐",
        what: "发来一条测试推送",
        snippet: "看到这条说明手机推送已经通了，有提问、待验收或权限等你时会发到这里。",
        at: Date.now(),
      },
    ],
    cfg.titleOnly,
  )
  const outcome = await deliverFormatted(cfg, formatted, 400)
  return {
    ok: outcome.ok,
    state: getPublicPushState(),
    ...(outcome.ok ? {} : { error: outcome.error }),
  }
}

// ---- Event intake, 20s per-project merging, 30s permit delay & foreground suppression ----

async function flushProjectBatch(projectId: string) {
  const rt = state()
  const batch = rt.batches.get(projectId)
  if (!batch) return
  rt.batches.delete(projectId)
  clearTimeout(batch.timer)

  if (!canSendAuto(rt.config)) return
  if (isClientInForeground()) return

  const valid = batch.items.filter((item) => (item.stillValid ? item.stillValid() : true))
  if (valid.length === 0) return

  const projectName = valid[valid.length - 1].getProjectName()
  const formatted = formatBatch(projectName, valid, rt.config.titleOnly)
  await deliverFormatted(rt.config, formatted)
}

export function enqueuePushEvent(item: Omit<PendingPushItem, "at">, customDelayMs?: number) {
  const rt = state()
  if (!canSendAuto(rt.config)) return
  if (item.kind === "end" && !rt.config.onEnd) return
  if (isClientInForeground()) return

  const fullItem: PendingPushItem = { ...item, at: Date.now() }
  const existing = rt.batches.get(item.projectId)
  if (existing) {
    existing.items.push(fullItem)
    return
  }

  const waitMs = customDelayMs ?? mergeWindowMs()
  const timer = setTimeout(() => {
    void flushProjectBatch(item.projectId)
  }, waitMs)
  timer.unref?.()
  rt.batches.set(item.projectId, { timer, items: [fullItem] })
}

export function schedulePermitPush(input: {
  permitId: string
  projectId: string
  getProjectName: () => string
  actor: string
  what: string
  snippet: string
  stillValid: () => boolean
}) {
  const rt = state()
  // Always arm the 30s timer if configured (even if the user is on the page at t=0,
  // or only check foreground when firing; if not configured at all, skip).
  if (!canSendAuto(rt.config)) return
  cancelPermitPush(input.permitId)

  const timer = setTimeout(() => {
    rt.permitTimers.delete(input.permitId)
    if (!canSendAuto(rt.config)) return
    if (isClientInForeground()) return
    if (!input.stillValid()) return

    // If this project already has a 20s merge batch counting down, Piggyback on it;
    // otherwise send after a tiny micro-batch (400ms) so simultaneous permits coalesce
    // without making a 30s permit wait another full 20s.
    const existing = rt.batches.get(input.projectId)
    if (existing) {
      existing.items.push({
        projectId: input.projectId,
        getProjectName: input.getProjectName,
        kind: "permit",
        actor: input.actor,
        what: input.what,
        snippet: input.snippet,
        at: Date.now(),
        stillValid: input.stillValid,
      })
      return
    }
    enqueuePushEvent(
      {
        projectId: input.projectId,
        getProjectName: input.getProjectName,
        kind: "permit",
        actor: input.actor,
        what: input.what,
        snippet: input.snippet,
        stillValid: input.stillValid,
      },
      Math.min(PERMIT_MICRO_BATCH_MS, Math.max(50, Math.floor(permitWaitMs() / 5))),
    )
  }, permitWaitMs())
  timer.unref?.()
  rt.permitTimers.set(input.permitId, timer)
}

export function cancelPermitPush(permitId: string) {
  const rt = state()
  const timer = rt.permitTimers.get(permitId)
  if (!timer) return
  clearTimeout(timer)
  rt.permitTimers.delete(permitId)
}
