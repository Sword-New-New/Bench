"use client"

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import { useTheme } from "next-themes"
import { Loader2, Moon, RotateCw, Sun } from "lucide-react"

import { Button } from "@/components/ui/button"
import type { SpeedBoardData, SpeedBoardRow } from "@/lib/speed"

// Native Token Speed & Usage Board — ported from ai_speed.py into React + Canvas.
// Reads from /api/v1/speed/board with no external Python process or port 8765.

type AgentKey = "claude" | "codex" | "antigravity" | "dsh"
type RangeKey = "1h" | "24h" | "7d" | "30d" | "all"
type UsageMode = "in" | "out"

type AgentMeta = {
  key: AgentKey
  name: string
  color: string
  exactTtft: boolean
  ttftLabel: string
}

const AGENTS: AgentMeta[] = [
  { key: "claude", name: "Claude Code", color: "#d97757", exactTtft: false, ttftLabel: "首块中位" },
  { key: "codex", name: "Codex", color: "#10a37f", exactTtft: true, ttftLabel: "首 token 中位" },
  { key: "antigravity", name: "Antigravity", color: "#7c6cf0", exactTtft: false, ttftLabel: "首块中位" },
  { key: "dsh", name: "DeepSeek Harness", color: "#4d6bfe", exactTtft: true, ttftLabel: "首 token 中位" },
]

const RANGE_OPTIONS: { value: RangeKey; label: string }[] = [
  { value: "1h", label: "1 小时" },
  { value: "24h", label: "24 小时" },
  { value: "7d", label: "7 天" },
  { value: "30d", label: "30 天" },
  { value: "all", label: "全部" },
]

const MIN_OPTIONS: { value: string; label: string }[] = [
  { value: "0", label: "计入全部请求" },
  { value: "50", label: "忽略 < 50 tokens" },
  { value: "100", label: "忽略 < 100 tokens" },
  { value: "300", label: "忽略 < 300 tokens" },
  { value: "1000", label: "只看 ≥ 1000 tokens" },
]

const BUCKET_SECONDS: Record<RangeKey, number> = {
  "1h": 120,
  "24h": 3600,
  "7d": 6 * 3600,
  "30d": 86400,
  all: 86400,
}

const USAGE_PARTS = {
  in: [
    { key: "cread" as const, name: "缓存读取", light: "#4d948b", dark: "#6fb3aa" },
    { key: "cwrite" as const, name: "缓存写入", light: "#cc922b", dark: "#e0ac4c" },
    { key: "fresh" as const, name: "未缓存", light: "#c25b57", dark: "#de726d" },
  ],
  out: [
    { key: "reasoning" as const, name: "思考 / 推理", light: "#8564c7", dark: "#a487e0" },
    { key: "text" as const, name: "正文与工具调用", light: "#46966b", dark: "#62b98a" },
  ],
}

type ParsedRow = {
  agent: AgentKey
  start: number | null
  end: number
  out: number
  dur: number
  tps: number
  model: string
  project: string
  reasoning: number
  ttft: number | null
  inp: number
  cread: number
  cwrite: number
}

// ---- Preferences persisted in localStorage via useSyncExternalStore ----

const PREF_EVENT = "bench-speed-pref"

function subscribePref(cb: () => void) {
  window.addEventListener(PREF_EVENT, cb)
  return () => window.removeEventListener(PREF_EVENT, cb)
}

function usePref<T extends string>(key: string, fallback: T, allowed?: readonly T[]): [T, (next: T) => void] {
  const storageKey = `bench-speed:${key}`
  const value = useSyncExternalStore(
    subscribePref,
    () => {
      try {
        const raw = localStorage.getItem(storageKey) as T | null
        if (raw && (!allowed || allowed.includes(raw))) return raw
      } catch {}
      return fallback
    },
    () => fallback,
  )
  const update = useCallback(
    (next: T) => {
      try {
        localStorage.setItem(storageKey, next)
      } catch {}
      window.dispatchEvent(new Event(PREF_EVENT))
    },
    [storageKey],
  )
  return [value, update]
}

// ---- Formatting & math helpers ----

function fmt(n: number | null | undefined, digits = 1) {
  return n == null || !Number.isFinite(n) ? "—" : n.toFixed(digits)
}

function fmtInt(n: number) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`
  if (n >= 1e4) return `${(n / 1e3).toFixed(1)}k`
  return n.toLocaleString()
}

function pct(a: number, b: number) {
  if (!b) return "—"
  const ratio = a / b
  return `${(ratio * 100).toFixed(ratio > 0.995 && a < b ? 1 : 0)}%`
}

function quant(sorted: number[], p: number) {
  if (sorted.length === 0) return Number.NaN
  const k = (sorted.length - 1) * p
  const lo = Math.floor(k)
  const hi = Math.min(lo + 1, sorted.length - 1)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (k - lo)
}

function agoSec(endSec: number, nowMs: number) {
  if (!nowMs) return ""
  const s = Math.max(0, nowMs / 1000 - endSec)
  if (s < 60) return `${Math.floor(s)} 秒前`
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`
  return `${Math.floor(s / 86400)} 天前`
}

function pad2(n: number) {
  return String(n).padStart(2, "0")
}

function fmtClock(sec: number, withDate: boolean) {
  const d = new Date(sec * 1000)
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
  return withDate ? `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${hm}` : hm
}

function fmtTtft(v: number | null | undefined, agent: AgentKey) {
  if (v == null || v < 0 || !Number.isFinite(v)) return "—"
  const meta = AGENTS.find((a) => a.key === agent)
  const prefix = meta?.exactTtft ? "" : "≤"
  return `${prefix}${v.toFixed(v < 10 ? 1 : 0)} 秒`
}

function summarizeSpeed(rows: ParsedRow[]) {
  const tps = rows.map((r) => r.tps).sort((a, b) => a - b)
  const out = rows.reduce((s, r) => s + r.out, 0)
  const dur = rows.reduce((s, r) => s + r.dur, 0)
  return {
    n: rows.length,
    out,
    weighted: dur > 0 ? out / dur : Number.NaN,
    med: quant(tps, 0.5),
    p10: quant(tps, 0.1),
    p90: quant(tps, 0.9),
    p99: quant(tps, 0.99),
  }
}

function usageSum(rows: ParsedRow[]) {
  let inp = 0
  let cread = 0
  let cwrite = 0
  let out = 0
  let reasoning = 0
  for (const r of rows) {
    inp += r.inp
    cread += r.cread
    cwrite += r.cwrite
    out += r.out
    reasoning += r.reasoning
  }
  return {
    n: rows.length,
    inp,
    cread,
    cwrite,
    fresh: Math.max(0, inp - cread - cwrite),
    out,
    reasoning,
  }
}

function niceStep(max: number, count: number) {
  if (!(max > 0)) return 1
  const raw = max / count
  const mag = 10 ** Math.floor(Math.log10(raw))
  const f = raw / mag
  return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * mag
}

function rollingMedian(vals: number[], windowSize: number) {
  const half = Math.floor(windowSize / 2)
  return vals.map((_, i) => {
    const slice = vals.slice(Math.max(0, i - half), i + half + 1).sort((a, b) => a - b)
    return slice[Math.floor(slice.length / 2)]
  })
}

function bucketOf(sec: number, size: number) {
  if (size >= 3600) {
    const d = new Date(sec * 1000)
    d.setMinutes(0, 0, 0)
    if (size >= 86400) d.setHours(0)
    else d.setHours(Math.floor(d.getHours() / (size / 3600)) * (size / 3600))
    return d.getTime() / 1000
  }
  return Math.floor(sec / size) * size
}

function unpackRows(models: string[], projects: string[], rawRows: SpeedBoardRow[]): ParsedRow[] {
  return rawRows.map(([a, start, end, out, mi, pi, rs, tt, inp, cread, cwrite]) => {
    const agent = AGENTS[a]?.key ?? "claude"
    const dur = start == null ? Number.NaN : end - start
    return {
      agent,
      start,
      end,
      out,
      dur,
      tps: start == null || !(dur > 0) ? Number.NaN : out / dur,
      model: models[mi] ?? "?",
      project: projects[pi] ?? "",
      reasoning: rs,
      ttft: tt,
      inp,
      cread,
      cwrite,
    }
  })
}

// ---- Sub-components ----

function Sparkline({ rows, color }: { rows: ParsedRow[]; color: string }) {
  const pts = rows.slice(-40)
  if (pts.length < 2) return <div className="h-12 w-36 shrink-0" />
  const vals = pts.map((r) => r.tps)
  const max = Math.max(...vals) * 1.1 || 1
  const W = 148
  const H = 48
  const xy = vals.map((v, i) => [(i / (vals.length - 1)) * W, H - 4 - (v / max) * (H - 8)] as const)
  const d = xy.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" ")
  const last = xy[xy.length - 1]
  return (
    <svg className="h-12 w-36 shrink-0 overflow-visible" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      <path d={`${d} L${W} ${H} L0 ${H} Z`} fill={color} fillOpacity={0.12} />
      <path d={d} fill="none" stroke={color} strokeWidth={1.8} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      <circle cx={last[0]} cy={last[1]} r={2.8} fill={color} />
    </svg>
  )
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
  small = false,
}: {
  value: T
  options: { value: T; label: string }[]
  onChange: (next: T) => void
  small?: boolean
}) {
  return (
    <div className="inline-flex flex-wrap items-center gap-0.5 rounded-lg border bg-muted/40 p-0.5">
      {options.map((opt) => {
        const active = opt.value === value
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            className={`cursor-pointer rounded-md font-medium whitespace-nowrap transition-colors ${
              small ? "px-2.5 py-1 text-xs" : "px-2.5 py-1 text-xs sm:text-[13px]"
            } ${active ? "bg-foreground text-background shadow-xs" : "text-muted-foreground hover:text-foreground"}`}
          >
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}

export type SpeedBoardProps = {
  // Embedded inside the room dialog (header already rendered by DialogHeader).
  embedded?: boolean
  // Incremented by parent when the user clicks manual refresh.
  refreshSignal?: number
}

export function SpeedBoard({ embedded = false, refreshSignal = 0 }: SpeedBoardProps) {
  const { resolvedTheme, setTheme } = useTheme()
  const isDark = resolvedTheme === "dark"

  const [range, setRange] = usePref<RangeKey>("range", "24h", ["1h", "24h", "7d", "30d", "all"] as const)
  const [agent, setAgent] = usePref<"all" | AgentKey>("agent", "all", ["all", "claude", "codex", "antigravity", "dsh"] as const)
  const [minStr, setMinStr] = usePref<string>("min", "100", ["0", "50", "100", "300", "1000"] as const)
  const [umode, setUmode] = usePref<UsageMode>("umode", "in", ["in", "out"] as const)

  const minTokens = Number(minStr) || 0

  const [board, setBoard] = useState<{
    range: RangeKey
    now: number
    since: number | null
    all: ParsedRow[]
  } | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [lastOkMs, setLastOkMs] = useState(0)
  const [nowMs, setNowMs] = useState(0)

  const versionRef = useRef("")
  const rangeRef = useRef(range)

  const fetchBoard = useCallback((targetRange: RangeKey, forceFresh = false) => {
    const params = new URLSearchParams({ range: targetRange })
    if (!forceFresh && versionRef.current) params.set("v", versionRef.current)
    if (forceFresh) params.set("fresh", "1")
    fetch(`/api/v1/speed/board?${params.toString()}`, { cache: "no-store" })
      .then((res) => (res.ok ? (res.json() as Promise<SpeedBoardData>) : null))
      .then((data) => {
        if (!data || rangeRef.current !== targetRange) return
        const stamp = Date.now()
        setLastOkMs(stamp)
        setNowMs(stamp)
        if (!data.unchanged) {
          versionRef.current = data.v
          setBoard({
            range: targetRange,
            now: data.now,
            since: data.since,
            all: unpackRows(data.models, data.projects, data.rows),
          })
        }
      })
      .catch(() => {})
      .finally(() => {
        if (forceFresh) setRefreshing(false)
      })
  }, [])

  // Reload whenever range changes, and poll every 3s while visible.
  useEffect(() => {
    rangeRef.current = range
    versionRef.current = ""
    void fetchBoard(range, false)
    const poll = window.setInterval(() => {
      if (document.visibilityState === "visible") void fetchBoard(range, false)
    }, 3000)
    const tick = window.setInterval(() => {
      if (document.visibilityState === "visible") setNowMs(Date.now())
    }, 1000)
    return () => {
      window.clearInterval(poll)
      window.clearInterval(tick)
    }
  }, [range, fetchBoard])

  const loading = refreshing || board?.range !== range

  // Parent-triggered manual refresh.
  const prevSignal = useRef(refreshSignal)
  useEffect(() => {
    if (refreshSignal !== prevSignal.current) {
      prevSignal.current = refreshSignal
      void fetchBoard(range, true)
    }
  }, [refreshSignal, range, fetchBoard])

  const allRows = useMemo(() => board?.all ?? [], [board])
  const timedRows = useMemo(
    () => allRows.filter((r) => r.start != null && Number.isFinite(r.tps) && r.out >= minTokens),
    [allRows, minTokens],
  )
  const visibleTimed = useMemo(
    () => (agent === "all" ? timedRows : timedRows.filter((r) => r.agent === agent)),
    [timedRows, agent],
  )
  const visibleAll = useMemo(
    () => (agent === "all" ? allRows : allRows.filter((r) => r.agent === agent)),
    [allRows, agent],
  )
  const activeAgents = useMemo(
    () => AGENTS.filter((a) => agent === "all" || a.key === agent),
    [agent],
  )

  const ttftMedianFor = useCallback(
    (agentKey: AgentKey, modelName?: string) => {
      const vals = allRows
        .filter((r) => r.ttft != null && r.agent === agentKey && (!modelName || r.model === modelName))
        .map((r) => r.ttft as number)
        .sort((a, b) => a - b)
      return vals.length ? quant(vals, 0.5) : Number.NaN
    },
    [allRows],
  )

  // ---- Canvas 1: Speed Trend Scatter + Rolling Median ----
  const speedWrapRef = useRef<HTMLDivElement | null>(null)
  const speedCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const speedPtsRef = useRef<{ x: number; y: number; r: ParsedRow; meta: AgentMeta }[]>([])
  const [speedTip, setSpeedTip] = useState<{ left: number; top: number; r: ParsedRow; meta: AgentMeta } | null>(null)
  const [resizeTick, setResizeTick] = useState(0)

  useEffect(() => {
    const el = speedWrapRef.current
    if (!el || typeof ResizeObserver === "undefined") return
    const ro = new ResizeObserver(() => setResizeTick((n) => n + 1))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const cv = speedCanvasRef.current
    if (!cv) return
    const rect = cv.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return
    const dpr = window.devicePixelRatio || 1
    cv.width = Math.round(rect.width * dpr)
    cv.height = Math.round(rect.height * dpr)
    const ctx = cv.getContext("2d")
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const W = rect.width
    const H = rect.height
    ctx.clearRect(0, 0, W, H)
    speedPtsRef.current = []

    const ink = isDark ? "#7c7972" : "#9a958c"
    const grid = isDark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.07)"

    if (!board || visibleTimed.length === 0) {
      ctx.fillStyle = ink
      ctx.font = "13px system-ui, sans-serif"
      ctx.textAlign = "center"
      ctx.textBaseline = "middle"
      ctx.fillText(loading ? "正在读取本机会话记录…" : "这个时间范围内没有记录", W / 2, H / 2)
      return
    }

    const pad = { l: 44, r: 14, t: 10, b: 26 }
    const x0 = board.since ?? visibleTimed[0].end
    const x1 = Math.max(board.now, visibleTimed[visibleTimed.length - 1].end)
    const yMax = Math.max(20, summarizeSpeed(visibleTimed).p99 * 1.12)
    const step = niceStep(yMax, 4)
    const X = (t: number) => pad.l + ((t - x0) / Math.max(1, x1 - x0)) * (W - pad.l - pad.r)
    const Y = (v: number) => pad.t + (1 - Math.min(v, yMax) / yMax) * (H - pad.t - pad.b)

    ctx.font = "11px system-ui, sans-serif"
    ctx.fillStyle = ink
    ctx.strokeStyle = grid
    ctx.lineWidth = 1
    ctx.textAlign = "right"
    ctx.textBaseline = "middle"
    for (let v = 0; v <= yMax; v += step) {
      const y = Math.round(Y(v)) + 0.5
      ctx.beginPath()
      ctx.moveTo(pad.l, y)
      ctx.lineTo(W - pad.r, y)
      ctx.stroke()
      ctx.fillText(String(Math.round(v)), pad.l - 8, y)
    }

    ctx.textAlign = "center"
    ctx.textBaseline = "top"
    const span = x1 - x0
    const ticks = Math.max(2, Math.floor((W - pad.l - pad.r) / 110))
    for (let i = 0; i <= ticks; i++) {
      const t = x0 + (span * i) / ticks
      const d = new Date(t * 1000)
      const label = span > 2 * 86400 ? `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` : `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
      ctx.fillText(label, Math.min(W - pad.r - 14, Math.max(pad.l + 14, X(t))), H - pad.b + 8)
    }

    const pts: { x: number; y: number; r: ParsedRow; meta: AgentMeta }[] = []
    for (const meta of activeAgents) {
      const rs = visibleTimed.filter((r) => r.agent === meta.key)
      if (rs.length === 0) continue
      const radius = rs.length > 3000 ? 1.6 : rs.length > 600 ? 2.2 : 3
      ctx.fillStyle = meta.color
      ctx.globalAlpha = rs.length > 3000 ? 0.24 : 0.4
      for (const r of rs) {
        const x = X(r.end)
        const y = Y(r.tps)
        ctx.beginPath()
        ctx.arc(x, y, radius, 0, Math.PI * 2)
        ctx.fill()
        pts.push({ x, y, r, meta })
      }
      ctx.globalAlpha = 1
      if (rs.length >= 5) {
        const w = rs.length > 2000 ? 61 : rs.length > 400 ? 25 : rs.length > 60 ? 11 : 5
        const med = rollingMedian(
          rs.map((r) => r.tps),
          w,
        )
        ctx.strokeStyle = meta.color
        ctx.lineWidth = 2.2
        ctx.lineJoin = "round"
        ctx.beginPath()
        let lastX = -1e9
        let prevT: number | null = null
        rs.forEach((r, idx) => {
          const x = X(r.end)
          const y = Y(med[idx])
          const gap = prevT != null && r.end - prevT > Math.max(1800, span / 30)
          if (idx === 0 || gap) ctx.moveTo(x, y)
          else if (x - lastX > 0.5 || idx === rs.length - 1) ctx.lineTo(x, y)
          lastX = x
          prevT = r.end
        })
        ctx.stroke()
      }
    }
    speedPtsRef.current = pts
  }, [board, visibleTimed, activeAgents, isDark, loading, resizeTick])

  // ---- Canvas 2: Stacked Token Usage Histogram by Time Bucket ----
  const usageCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const usageBarsRef = useRef<{ x: number; w: number; label: string; n: number; values: number[] }[]>([])
  const [usageTip, setUsageTip] = useState<{ left: number; label: string; n: number; values: number[] } | null>(null)

  useEffect(() => {
    const cv = usageCanvasRef.current
    if (!cv) return
    const rect = cv.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return
    const dpr = window.devicePixelRatio || 1
    cv.width = Math.round(rect.width * dpr)
    cv.height = Math.round(rect.height * dpr)
    const ctx = cv.getContext("2d")
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const W = rect.width
    const H = rect.height
    ctx.clearRect(0, 0, W, H)
    usageBarsRef.current = []

    const ink = isDark ? "#7c7972" : "#9a958c"
    const grid = isDark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.07)"

    if (!board || visibleAll.length === 0) {
      ctx.fillStyle = ink
      ctx.font = "13px system-ui, sans-serif"
      ctx.textAlign = "center"
      ctx.textBaseline = "middle"
      ctx.fillText(loading ? "正在读取本机会话记录…" : "这个时间范围内没有记录", W / 2, H / 2)
      return
    }

    const parts = USAGE_PARTS[umode]
    const size = BUCKET_SECONDS[range]
    const b0 = bucketOf(board.since ?? visibleAll[0].end, size)
    const b1 = bucketOf(board.now, size)
    const buckets = new Map<number, { t: number; n: number; v: number[] }>()
    for (let b = b0; b <= b1; ) {
      buckets.set(b, { t: b, n: 0, v: parts.map(() => 0) })
      let next = bucketOf(b + size * 1.5, size)
      for (let k = 2.5; next <= b; k++) next = bucketOf(b + size * k, size)
      b = next
    }
    for (const r of visibleAll) {
      const bk = buckets.get(bucketOf(r.end, size))
      if (!bk) continue
      bk.n += 1
      parts.forEach((p, idx) => {
        const val =
          p.key === "fresh"
            ? Math.max(0, r.inp - r.cread - r.cwrite)
            : p.key === "text"
              ? Math.max(0, r.out - r.reasoning)
              : r[p.key]
        bk.v[idx] += val
      })
    }

    const list = [...buckets.values()]
    const yMax = Math.max(1, ...list.map((b) => b.v.reduce((a, x) => a + x, 0))) * 1.08
    const pad = { l: 52, r: 10, t: 10, b: 26 }
    const bw = (W - pad.l - pad.r) / Math.max(1, list.length)
    const Y = (v: number) => pad.t + (1 - v / yMax) * (H - pad.t - pad.b)

    ctx.font = "11px system-ui, sans-serif"
    ctx.fillStyle = ink
    ctx.strokeStyle = grid
    ctx.lineWidth = 1
    ctx.textAlign = "right"
    ctx.textBaseline = "middle"
    const step = niceStep(yMax, 4)
    for (let v = 0; v <= yMax; v += step) {
      const y = Math.round(Y(v)) + 0.5
      ctx.beginPath()
      ctx.moveTo(pad.l, y)
      ctx.lineTo(W - pad.r, y)
      ctx.stroke()
      ctx.fillText(fmtInt(Math.round(v)), pad.l - 8, y)
    }

    const bucketLabel = (t: number) => {
      const d = new Date(t * 1000)
      if (size >= 86400) return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
      const prefix = size >= 6 * 3600 ? `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` : ""
      return `${prefix}${pad2(d.getHours())}:${pad2(d.getMinutes())}`
    }

    ctx.textAlign = "center"
    ctx.textBaseline = "top"
    const every = Math.max(1, Math.ceil(list.length / Math.max(1, Math.floor((W - pad.l) / (size >= 6 * 3600 && size < 86400 ? 96 : 60)))))
    const colors = parts.map((p) => (isDark ? p.dark : p.light))
    const bars: { x: number; w: number; label: string; n: number; values: number[] }[] = []

    list.forEach((b, i) => {
      const x = pad.l + i * bw
      const w = Math.max(1, bw - Math.max(1, bw * 0.22))
      let acc = 0
      b.v.forEach((v, k) => {
        if (!v) return
        const y0 = Y(acc)
        const y1 = Y(acc + v)
        ctx.fillStyle = colors[k]
        ctx.fillRect(x + (bw - w) / 2, y1, w, y0 - y1)
        acc += v
      })
      const lbl = bucketLabel(b.t)
      bars.push({ x, w: bw, label: lbl, n: b.n, values: b.v })
      if (i % every === 0) {
        ctx.fillStyle = ink
        ctx.fillText(lbl, x + bw / 2, H - pad.b + 8)
      }
    })
    usageBarsRef.current = bars
  }, [board, visibleAll, umode, range, isDark, loading, resizeTick])

  // ---- Canvas 3: Speed Distribution Histogram ----
  const histCanvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const cv = histCanvasRef.current
    if (!cv) return
    const rect = cv.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return
    const dpr = window.devicePixelRatio || 1
    cv.width = Math.round(rect.width * dpr)
    cv.height = Math.round(rect.height * dpr)
    const ctx = cv.getContext("2d")
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const W = rect.width
    const H = rect.height
    ctx.clearRect(0, 0, W, H)

    if (visibleTimed.length === 0) return
    const ink = isDark ? "#7c7972" : "#9a958c"
    const grid = isDark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.07)"
    const pad = { l: 38, r: 10, t: 8, b: 24 }
    const xMax = Math.max(40, summarizeSpeed(visibleTimed).p99 * 1.05)
    const bw = niceStep(xMax, 14)
    const nb = Math.max(1, Math.ceil(xMax / bw))

    const series = activeAgents
      .map((meta) => {
        const rs = visibleTimed.filter((r) => r.agent === meta.key)
        const bins = new Array<number>(nb).fill(0)
        for (const r of rs) {
          bins[Math.min(nb - 1, Math.floor(r.tps / bw))] += 1
        }
        return {
          meta,
          bins: bins.map((b) => (rs.length ? b / rs.length : 0)),
          n: rs.length,
        }
      })
      .filter((s) => s.n > 0)

    if (series.length === 0) return
    const yMax = Math.max(0.05, ...series.flatMap((s) => s.bins)) * 1.1
    const X = (v: number) => pad.l + (v / (nb * bw)) * (W - pad.l - pad.r)
    const Y = (f: number) => pad.t + (1 - f / yMax) * (H - pad.t - pad.b)

    ctx.font = "11px system-ui, sans-serif"
    ctx.fillStyle = ink
    ctx.strokeStyle = grid
    ctx.lineWidth = 1
    ctx.textAlign = "right"
    ctx.textBaseline = "middle"
    const ys = niceStep(yMax, 3)
    for (let f = 0; f <= yMax; f += ys) {
      const y = Math.round(Y(f)) + 0.5
      ctx.beginPath()
      ctx.moveTo(pad.l, y)
      ctx.lineTo(W - pad.r, y)
      ctx.stroke()
      ctx.fillText(`${Math.round(f * 100)}%`, pad.l - 6, y)
    }

    ctx.textAlign = "center"
    ctx.textBaseline = "top"
    const lstep = Math.max(1, Math.ceil(nb / Math.max(1, Math.floor((W - pad.l) / 44))))
    for (let i = 0; i <= nb; i += lstep) {
      ctx.fillText(String(Math.round(i * bw)), X(i * bw), H - pad.b + 7)
    }

    const gw = X(bw) - X(0) - 2
    const each = gw / series.length
    series.forEach((s, si) => {
      ctx.fillStyle = s.meta.color
      ctx.globalAlpha = 0.85
      s.bins.forEach((f, i) => {
        if (!f) return
        const x = X(i * bw) + 1 + si * each
        const y = Y(f)
        ctx.beginPath()
        ctx.roundRect(x, y, Math.max(1, each - 1), Y(0) - y, [3, 3, 0, 0])
        ctx.fill()
      })
    })
    ctx.globalAlpha = 1
  }, [visibleTimed, activeAgents, isDark, resizeTick])

  // ---- Derived table data ----
  const usageTotals = useMemo(() => usageSum(visibleAll), [visibleAll])

  const usageByModel = useMemo(() => {
    const groups = new Map<string, ParsedRow[]>()
    for (const r of visibleAll) {
      const k = `${r.agent}|${r.model}`
      const list = groups.get(k)
      if (list) list.push(r)
      else groups.set(k, [r])
    }
    return [...groups.values()]
      .map((rs) => ({
        meta: AGENTS.find((a) => a.key === rs[0].agent)!,
        model: rs[0].model,
        sum: usageSum(rs),
      }))
      .sort((a, b) => b.sum.inp - a.sum.inp)
      .slice(0, 50)
  }, [visibleAll])

  const usageByProject = useMemo(() => {
    const groups = new Map<string, ParsedRow[]>()
    for (const r of visibleAll) {
      const k = r.project || "—"
      const list = groups.get(k)
      if (list) list.push(r)
      else groups.set(k, [r])
    }
    return [...groups.entries()]
      .map(([project, rs]) => ({
        project,
        agents: AGENTS.filter((a) => rs.some((r) => r.agent === a.key)),
        sum: usageSum(rs),
      }))
      .sort((a, b) => b.sum.inp - a.sum.inp)
      .slice(0, 12)
  }, [visibleAll])

  const speedByModel = useMemo(() => {
    const groups = new Map<string, ParsedRow[]>()
    for (const r of visibleTimed) {
      const k = `${r.agent}|${r.model}`
      const list = groups.get(k)
      if (list) list.push(r)
      else groups.set(k, [r])
    }
    return [...groups.values()]
      .map((rs) => ({
        meta: AGENTS.find((a) => a.key === rs[0].agent)!,
        model: rs[0].model,
        stats: summarizeSpeed(rs),
      }))
      .sort((a, b) => b.stats.out - a.stats.out)
  }, [visibleTimed])

  const recentRows = useMemo(() => visibleAll.slice(-150).reverse(), [visibleAll])
  const recentMaxTps = useMemo(() => {
    let max = 1
    for (const r of recentRows) {
      if (r.out >= minTokens && Number.isFinite(r.tps) && r.tps > max) max = r.tps
    }
    return max
  }, [recentRows, minTokens])
  const recentWithDate = useMemo(() => {
    if (recentRows.length === 0) return false
    const newest = recentRows[0].end
    const oldest = recentRows[recentRows.length - 1].end
    return newest - oldest > 20 * 3600 || new Date(newest * 1000).toDateString() !== new Date().toDateString()
  }, [recentRows])

  const liveOk = lastOkMs > 0 && nowMs - lastOkMs < 10_000
  const activeUsageParts = USAGE_PARTS[umode]

  return (
    <div ref={speedWrapRef} className={embedded ? "space-y-4 p-4 sm:p-5" : "mx-auto max-w-[1260px] space-y-4 px-4 py-6 sm:px-6"}>
      {/* Controls bar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          {!embedded ? <h1 className="text-xl font-semibold tracking-tight">Token 测速台</h1> : null}
          <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
            <span className={`size-2 rounded-full ${liveOk ? "bg-emerald-500 animate-pulse" : "bg-muted-foreground/40"}`} />
            {loading && !board ? "正在读取记录…" : liveOk ? "实时 · 每 3 秒刷新" : "等待刷新"}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Segmented value={range} options={RANGE_OPTIONS} onChange={setRange} />
          <Segmented
            value={agent}
            options={[
              { value: "all", label: "全部" },
              { value: "claude", label: "Claude" },
              { value: "codex", label: "Codex" },
              { value: "antigravity", label: "Antigravity" },
              { value: "dsh", label: "DeepSeek" },
            ]}
            onChange={setAgent}
          />
          <select
            value={minStr}
            onChange={(e) => setMinStr(e.target.value)}
            title="输出太短的请求主要是等待时间，算出来的速度不准"
            className="h-8 rounded-lg border bg-background px-2.5 text-xs text-foreground outline-none focus:ring-2 focus:ring-ring/40"
          >
            {MIN_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          {!embedded ? (
            <>
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                aria-label="刷新"
                title="立即重新扫描"
                onClick={() => {
                  setRefreshing(true)
                  fetchBoard(range, true)
                }}
              >
                {loading ? <Loader2 className="animate-spin" /> : <RotateCw />}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                aria-label="切换深浅色"
                title="切换深浅色"
                onClick={() => setTheme(isDark ? "light" : "dark")}
              >
                {isDark ? <Sun /> : <Moon />}
              </Button>
            </>
          ) : null}
        </div>
      </div>

      {/* Overview cards per agent */}
      <section className="grid grid-cols-1 gap-3.5 md:grid-cols-2">
        {activeAgents.map((meta) => {
          const rows = timedRows.filter((r) => r.agent === meta.key)
          const last = rows[rows.length - 1]
          const stats = rows.length > 0 ? summarizeSpeed(rows) : null
          return (
            <div key={meta.key} className="relative overflow-hidden rounded-xl border bg-card p-4 pl-5 shadow-xs">
              <span className="absolute inset-y-0 left-0 w-1" style={{ backgroundColor: meta.color }} />
              <div className="mb-3 flex items-center gap-2">
                <span className="text-sm font-semibold">{meta.name}</span>
                {last ? (
                  <span className="truncate rounded-full border bg-muted/50 px-2.5 py-0.5 text-xs text-muted-foreground">
                    {last.model}
                  </span>
                ) : null}
                {last ? <span className="ml-auto shrink-0 text-xs text-muted-foreground">{agoSec(last.end, nowMs)}</span> : null}
              </div>

              {!last || !stats ? (
                <div className="py-5 text-sm text-muted-foreground">这个时间范围内没有记录</div>
              ) : (
                <>
                  <div className="flex items-end justify-between gap-4">
                    <div className="min-w-0">
                      <div className="flex items-baseline gap-1.5">
                        <span className="text-4xl font-bold tracking-tight tabular-nums" style={{ color: meta.color }}>
                          {fmt(last.tps)}
                        </span>
                        <span className="text-sm text-muted-foreground">tok/s</span>
                      </div>
                      <div className="mt-1 truncate text-xs text-muted-foreground">
                        最近一次 · {last.out.toLocaleString()} tokens / {fmt(last.dur)} 秒{last.project ? ` · ${last.project}` : ""}
                      </div>
                    </div>
                    <Sparkline rows={rows} color={meta.color} />
                  </div>

                  <div className="mt-4 grid grid-cols-3 justify-between gap-2 border-t border-dashed pt-3 sm:grid-cols-5">
                    <div>
                      <span className="block text-[11px] text-muted-foreground">中位数</span>
                      <b className="text-sm font-semibold tabular-nums">{fmt(stats.med)}</b>
                    </div>
                    <div>
                      <span className="block text-[11px] text-muted-foreground">加权平均</span>
                      <b className="text-sm font-semibold tabular-nums">{fmt(stats.weighted)}</b>
                    </div>
                    <div>
                      <span className="block text-[11px] text-muted-foreground">P10 – P90</span>
                      <b className="text-sm font-semibold tabular-nums">
                        {fmt(stats.p10, 0)}–{fmt(stats.p90, 0)}
                      </b>
                    </div>
                    <div>
                      <span className="block text-[11px] text-muted-foreground">{meta.ttftLabel}</span>
                      <b className="text-sm font-semibold tabular-nums">{fmtTtft(ttftMedianFor(meta.key), meta.key)}</b>
                    </div>
                    <div>
                      <span className="block text-[11px] text-muted-foreground">请求 / 输出</span>
                      <b className="text-sm font-semibold tabular-nums">
                        {stats.n.toLocaleString()} / {fmtInt(stats.out)}
                      </b>
                    </div>
                  </div>
                </>
              )}
            </div>
          )
        })}
      </section>

      {/* Speed trend chart */}
      <section className="rounded-xl border bg-card p-4 shadow-xs">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">速度走势</h2>
          <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
            {activeAgents.map((a) => (
              <span key={a.key} className="inline-flex items-center gap-1.5">
                <i className="inline-block size-2.5 rounded-xs" style={{ backgroundColor: a.color }} />
                {a.name}
              </span>
            ))}
            <span className="text-muted-foreground/70">点 = 单次请求 · 线 = 滚动中位数</span>
          </div>
        </div>
        <div
          className="relative h-[280px] w-full"
          onMouseMove={(e) => {
            const rect = speedCanvasRef.current?.getBoundingClientRect()
            if (!rect) return
            const mx = e.clientX - rect.left
            const my = e.clientY - rect.top
            let best: { x: number; y: number; r: ParsedRow; meta: AgentMeta } | null = null
            let bestDist = 144
            for (const p of speedPtsRef.current) {
              const d = (p.x - mx) ** 2 + (p.y - my) ** 2
              if (d < bestDist) {
                bestDist = d
                best = p
              }
            }
            setSpeedTip(
              best
                ? {
                    left: Math.max(4, Math.min(rect.width - 210, best.x + 12)),
                    top: Math.max(4, best.y - 72),
                    r: best.r,
                    meta: best.meta,
                  }
                : null,
            )
          }}
          onMouseLeave={() => setSpeedTip(null)}
        >
          <canvas ref={speedCanvasRef} className="block size-full" />
          {speedTip ? (
            <div
              className="pointer-events-none absolute z-10 rounded-lg bg-foreground px-2.5 py-1.5 text-xs leading-relaxed whitespace-nowrap text-background shadow-md"
              style={{
                left: speedTip.left,
                top: speedTip.top,
              }}
            >
              <div>
                <b>{fmt(speedTip.r.tps)} tok/s</b> · {speedTip.meta.name}
              </div>
              <div>
                {speedTip.r.model}
                {speedTip.r.project ? ` · ${speedTip.r.project}` : ""}
              </div>
              <div>
                {speedTip.r.out.toLocaleString()} tokens / {fmt(speedTip.r.dur)} 秒 · {fmtClock(speedTip.r.end, true)}
              </div>
              {speedTip.r.ttft != null && speedTip.r.ttft >= 0 ? (
                <div>
                  {speedTip.meta.exactTtft ? "首 token" : "首块"} {fmtTtft(speedTip.r.ttft, speedTip.r.agent)}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </section>

      {/* Token usage panel */}
      <section className="rounded-xl border bg-card p-4 shadow-xs">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">用量</h2>
          <Segmented
            small
            value={umode}
            options={[
              { value: "in", label: "输入" },
              { value: "out", label: "输出" },
            ]}
            onChange={setUmode}
          />
        </div>

        <div className="mb-3.5 grid grid-cols-2 gap-2.5 sm:grid-cols-4 lg:grid-cols-8">
          <UsageTile label="请求" value={usageTotals.n.toLocaleString()} />
          <UsageTile label="输入合计" value={fmtInt(usageTotals.inp)} />
          <UsageTile
            label="缓存读取"
            value={fmtInt(usageTotals.cread)}
            sub={pct(usageTotals.cread, usageTotals.inp)}
            dot={isDark ? "#6fb3aa" : "#4d948b"}
          />
          <UsageTile
            label="缓存写入"
            value={fmtInt(usageTotals.cwrite)}
            sub={pct(usageTotals.cwrite, usageTotals.inp)}
            dot={isDark ? "#e0ac4c" : "#cc922b"}
          />
          <UsageTile
            label="未缓存"
            value={fmtInt(usageTotals.fresh)}
            sub={pct(usageTotals.fresh, usageTotals.inp)}
            dot={isDark ? "#de726d" : "#c25b57"}
          />
          <UsageTile label="输出合计" value={fmtInt(usageTotals.out)} />
          <UsageTile
            label="其中思考/推理"
            value={fmtInt(usageTotals.reasoning)}
            sub={pct(usageTotals.reasoning, usageTotals.out)}
            dot={isDark ? "#a487e0" : "#8564c7"}
          />
          <UsageTile
            label="平均每次输入"
            value={fmtInt(Math.round(usageTotals.n ? usageTotals.inp / usageTotals.n : 0))}
            sub="上下文"
          />
        </div>

        <div
          className="relative h-[230px] w-full"
          onMouseMove={(e) => {
            const rect = usageCanvasRef.current?.getBoundingClientRect()
            if (!rect) return
            const mx = e.clientX - rect.left
            const hit = usageBarsRef.current.find((b) => mx >= b.x && mx < b.x + b.w)
            if (!hit || !hit.n) {
              setUsageTip(null)
              return
            }
            setUsageTip({
              left: Math.max(4, Math.min(rect.width - 210, hit.x + hit.w + 8)),
              label: hit.label,
              n: hit.n,
              values: hit.values,
            })
          }}
          onMouseLeave={() => setUsageTip(null)}
        >
          <canvas ref={usageCanvasRef} className="block size-full" />
          {usageTip ? (
            <div
              className="pointer-events-none absolute top-2 z-10 rounded-lg bg-foreground px-2.5 py-1.5 text-xs leading-relaxed whitespace-nowrap text-background shadow-md"
              style={{
                left: usageTip.left,
              }}
            >
              <div>
                <b>{usageTip.label}</b> · {usageTip.n} 次请求
              </div>
              {activeUsageParts.map((p, i) => {
                const total = usageTip.values.reduce((a, x) => a + x, 0)
                return (
                  <div key={p.key}>
                    {p.name} {fmtInt(usageTip.values[i])} ({pct(usageTip.values[i], total)})
                  </div>
                )
              })}
              <div>合计 {fmtInt(usageTip.values.reduce((a, x) => a + x, 0))}</div>
            </div>
          ) : null}
        </div>

        <div className="mt-2.5 flex flex-wrap gap-3.5 text-xs text-muted-foreground">
          {activeUsageParts.map((p) => (
            <span key={p.key} className="inline-flex items-center gap-1.5">
              <i className="inline-block size-2.5 rounded-xs" style={{ backgroundColor: isDark ? p.dark : p.light }} />
              {p.name}
            </span>
          ))}
        </div>
      </section>

      {/* Usage by model & project */}
      <section className="grid grid-cols-1 gap-4 lg:grid-cols-[1.15fr_1fr]">
        <div className="min-w-0 rounded-xl border bg-card p-4 shadow-xs">
          <div className="mb-2.5 flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">按模型用量</h2>
            <span className="text-xs text-muted-foreground">命中率 = 缓存读取 ÷ 输入</span>
          </div>
          <div className="overflow-x-auto">
            {usageByModel.length === 0 ? (
              <div className="py-4 text-xs text-muted-foreground">没有记录</div>
            ) : (
              <table className="w-full border-collapse text-xs">
                <thead>
                  <tr className="border-b whitespace-nowrap text-muted-foreground">
                    <th className="px-2 py-1.5 text-left font-medium">模型</th>
                    <th className="px-2 py-1.5 text-right font-medium">请求</th>
                    <th className="px-2 py-1.5 text-right font-medium">输入</th>
                    <th className="px-2 py-1.5 text-right font-medium">命中率</th>
                    <th className="px-2 py-1.5 text-right font-medium">缓存写入</th>
                    <th className="px-2 py-1.5 text-right font-medium">输出</th>
                    <th className="px-2 py-1.5 text-right font-medium">思考</th>
                    <th className="px-2 py-1.5 text-right font-medium">平均输入</th>
                  </tr>
                </thead>
                <tbody>
                  {usageByModel.map(({ meta, model, sum }) => (
                    <tr key={`${meta.key}|${model}`} className="border-b last:border-0 hover:bg-muted/30">
                      <td className="px-2 py-2 whitespace-nowrap">
                        <span className="inline-flex items-center gap-1.5">
                          <i className="size-2 rounded-full" style={{ backgroundColor: meta.color }} />
                          {model}
                        </span>
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums">{sum.n.toLocaleString()}</td>
                      <td className="px-2 py-2 text-right font-semibold tabular-nums">{fmtInt(sum.inp)}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{pct(sum.cread, sum.inp)}</td>
                      <td className="px-2 py-2 text-right text-muted-foreground tabular-nums">{fmtInt(sum.cwrite)}</td>
                      <td className="px-2 py-2 text-right font-semibold tabular-nums">{fmtInt(sum.out)}</td>
                      <td className="px-2 py-2 text-right text-muted-foreground tabular-nums">{fmtInt(sum.reasoning)}</td>
                      <td className="px-2 py-2 text-right text-muted-foreground tabular-nums">
                        {fmtInt(Math.round(sum.inp / sum.n))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        <div className="min-w-0 rounded-xl border bg-card p-4 shadow-xs">
          <div className="mb-2.5 flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">按项目用量</h2>
            <span className="text-xs text-muted-foreground">按输入排序，前 12 个</span>
          </div>
          <div className="overflow-x-auto">
            {usageByProject.length === 0 ? (
              <div className="py-4 text-xs text-muted-foreground">没有记录</div>
            ) : (
              <table className="w-full border-collapse text-xs">
                <thead>
                  <tr className="border-b whitespace-nowrap text-muted-foreground">
                    <th className="px-2 py-1.5 text-left font-medium">项目</th>
                    <th className="px-2 py-1.5 text-right font-medium">请求</th>
                    <th className="px-2 py-1.5 text-right font-medium">输入</th>
                    <th className="px-2 py-1.5 text-right font-medium">命中率</th>
                    <th className="px-2 py-1.5 text-right font-medium">缓存写入</th>
                    <th className="px-2 py-1.5 text-right font-medium">输出</th>
                    <th className="px-2 py-1.5 text-right font-medium">思考</th>
                    <th className="px-2 py-1.5 text-right font-medium">平均输入</th>
                  </tr>
                </thead>
                <tbody>
                  {usageByProject.map(({ project, agents, sum }) => (
                    <tr key={project} className="border-b last:border-0 hover:bg-muted/30">
                      <td className="px-2 py-2 whitespace-nowrap">
                        <span className="mr-1.5 inline-flex items-center gap-0.5 align-middle">
                          {agents.map((a) => (
                            <i key={a.key} className="inline-block size-1.5 rounded-full" style={{ backgroundColor: a.color }} />
                          ))}
                        </span>
                        {project}
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums">{sum.n.toLocaleString()}</td>
                      <td className="px-2 py-2 text-right font-semibold tabular-nums">{fmtInt(sum.inp)}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{pct(sum.cread, sum.inp)}</td>
                      <td className="px-2 py-2 text-right text-muted-foreground tabular-nums">{fmtInt(sum.cwrite)}</td>
                      <td className="px-2 py-2 text-right font-semibold tabular-nums">{fmtInt(sum.out)}</td>
                      <td className="px-2 py-2 text-right text-muted-foreground tabular-nums">{fmtInt(sum.reasoning)}</td>
                      <td className="px-2 py-2 text-right text-muted-foreground tabular-nums">
                        {fmtInt(Math.round(sum.inp / sum.n))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </section>

      {/* Speed by model & distribution */}
      <section className="grid grid-cols-1 gap-4 lg:grid-cols-[1.15fr_1fr]">
        <div className="min-w-0 rounded-xl border bg-card p-4 shadow-xs">
          <div className="mb-2.5 flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">按模型速度</h2>
            <span className="text-xs text-muted-foreground">加权 = 总输出 ÷ 总耗时</span>
          </div>
          <div className="overflow-x-auto">
            {speedByModel.length === 0 ? (
              <div className="py-4 text-xs text-muted-foreground">没有记录</div>
            ) : (
              <table className="w-full border-collapse text-xs">
                <thead>
                  <tr className="border-b whitespace-nowrap text-muted-foreground">
                    <th className="px-2 py-1.5 text-left font-medium">模型</th>
                    <th className="px-2 py-1.5 text-right font-medium">请求</th>
                    <th className="px-2 py-1.5 text-right font-medium">输出</th>
                    <th className="px-2 py-1.5 text-right font-medium">加权</th>
                    <th className="px-2 py-1.5 text-right font-medium">中位</th>
                    <th className="px-2 py-1.5 text-right font-medium">P10–P90</th>
                    <th className="px-2 py-1.5 text-right font-medium">首 token</th>
                  </tr>
                </thead>
                <tbody>
                  {speedByModel.map(({ meta, model, stats }) => (
                    <tr key={`${meta.key}|${model}`} className="border-b last:border-0 hover:bg-muted/30">
                      <td className="px-2 py-2 whitespace-nowrap">
                        <span className="inline-flex items-center gap-1.5">
                          <i className="size-2 rounded-full" style={{ backgroundColor: meta.color }} />
                          {model}
                        </span>
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums">{stats.n.toLocaleString()}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{fmtInt(stats.out)}</td>
                      <td className="px-2 py-2 text-right font-semibold tabular-nums">{fmt(stats.weighted)}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{fmt(stats.med)}</td>
                      <td className="px-2 py-2 text-right text-muted-foreground tabular-nums">
                        {fmt(stats.p10, 0)}–{fmt(stats.p90, 0)}
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums">{fmtTtft(ttftMedianFor(meta.key, model), meta.key)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        <div className="min-w-0 rounded-xl border bg-card p-4 shadow-xs">
          <div className="mb-2.5 flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">速度分布</h2>
            <span className="text-xs text-muted-foreground">各自占比</span>
          </div>
          <div className="relative h-[220px] w-full">
            <canvas ref={histCanvasRef} className="block size-full" />
          </div>
        </div>
      </section>

      {/* Recent 150 requests */}
      <section className="rounded-xl border bg-card p-4 shadow-xs">
        <div className="mb-2.5 flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">最近请求</h2>
          <span className="text-xs text-muted-foreground">
            {recentRows.length > 0 ? `显示最近 ${recentRows.length} 条（含短请求）` : ""}
          </span>
        </div>
        <div className="max-h-[480px] overflow-auto">
          {recentRows.length === 0 ? (
            <div className="py-4 text-xs text-muted-foreground">没有记录</div>
          ) : (
            <table className="w-full border-collapse text-xs">
              <thead className="sticky top-0 bg-card">
                <tr className="border-b text-muted-foreground">
                  <th className="px-2 py-1.5 text-left font-medium">时间</th>
                  <th className="px-2 py-1.5 text-left font-medium">来源</th>
                  <th className="px-2 py-1.5 text-left font-medium">模型</th>
                  <th className="px-2 py-1.5 text-left font-medium">项目</th>
                  <th className="px-2 py-1.5 text-right font-medium">输入</th>
                  <th className="px-2 py-1.5 text-right font-medium">命中</th>
                  <th className="px-2 py-1.5 text-right font-medium">输出</th>
                  <th
                    className="px-2 py-1.5 text-right font-medium"
                    title="Codex / DeepSeek 为精确值；Claude / Antigravity 为首块耗时（首 token 上限）"
                  >
                    首 token
                  </th>
                  <th className="px-2 py-1.5 text-right font-medium">耗时</th>
                  <th className="px-2 py-1.5 text-right font-medium">速度 tok/s</th>
                </tr>
              </thead>
              <tbody>
                {recentRows.map((r, idx) => {
                  const meta = AGENTS.find((a) => a.key === r.agent)!
                  const counted = r.out >= minTokens && Number.isFinite(r.tps)
                  const barW = counted ? Math.max(2, Math.min(1, r.tps / recentMaxTps) * 84) : 0
                  return (
                    <tr key={`${r.agent}-${r.end}-${idx}`} className="border-b last:border-0 hover:bg-muted/30">
                      <td className="px-2 py-1.5 whitespace-nowrap text-muted-foreground tabular-nums">
                        {fmtClock(r.end, recentWithDate)}
                      </td>
                      <td className="px-2 py-1.5 whitespace-nowrap">
                        <span className="inline-flex items-center gap-1.5">
                          <i className="size-2 rounded-full" style={{ backgroundColor: meta.color }} />
                          {meta.name}
                        </span>
                      </td>
                      <td className="px-2 py-1.5 whitespace-nowrap">{r.model}</td>
                      <td className="px-2 py-1.5 whitespace-nowrap text-muted-foreground">{r.project || "—"}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{r.inp.toLocaleString()}</td>
                      <td className="px-2 py-1.5 text-right text-muted-foreground tabular-nums">{pct(r.cread, r.inp)}</td>
                      <td className="px-2 py-1.5 text-right whitespace-nowrap tabular-nums">
                        {r.out.toLocaleString()}
                        {r.reasoning > 0 ? (
                          <span className="ml-1 text-muted-foreground">(思考 {r.reasoning.toLocaleString()})</span>
                        ) : null}
                      </td>
                      <td className="px-2 py-1.5 text-right text-muted-foreground tabular-nums">{fmtTtft(r.ttft, r.agent)}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{fmt(r.dur)} 秒</td>
                      <td className="px-2 py-1.5 text-right whitespace-nowrap tabular-nums">
                        {!Number.isFinite(r.tps) ? (
                          <span className="text-muted-foreground">—</span>
                        ) : counted ? (
                          <span className="inline-flex items-center justify-end gap-2">
                            <span
                              className="inline-block h-1.5 rounded-xs opacity-80"
                              style={{ width: `${barW.toFixed(0)}px`, backgroundColor: meta.color }}
                            />
                            <b>{fmt(r.tps)}</b>
                          </span>
                        ) : (
                          <span className="text-muted-foreground" title="输出太短，不计入速度统计">
                            {fmt(r.tps)}
                          </span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      </section>

      <footer className="space-y-1 text-xs leading-relaxed text-muted-foreground/80">
        <p>
          每一次模型请求单独计算：速度 = 输出 tokens ÷（生成结束 − 请求发出）。输出包含思考/推理、正文和工具调用参数；耗时包含首 token 等待，不含工具执行时间。
        </p>
        <p>
          首 token：Codex 与 DeepSeek Harness 为精确值；Claude Code 与 Antigravity 只记第一块可见内容到达时间（是首 token 的上限，标 ≤）。「忽略短请求」只影响速度统计，首 token 和用量统计包含全部请求。
        </p>
        <p>
          数据由并坐直接从本机 <code className="rounded bg-muted px-1 py-0.5">~/.claude/projects</code>、
          <code className="rounded bg-muted px-1 py-0.5">~/.codex/sessions</code>、
          <code className="rounded bg-muted px-1 py-0.5">~/.gemini/antigravity/conversations</code>（含{" "}
          <code className="rounded bg-muted px-1 py-0.5">antigravity-cli</code>）与{" "}
          <code className="rounded bg-muted px-1 py-0.5">~/.dsh/sessions</code> 只读解析，不联网、不改原始会话记录。
        </p>
      </footer>
    </div>
  )
}

function UsageTile({ label, value, sub, dot }: { label: string; value: string; sub?: string; dot?: string }) {
  return (
    <div className="rounded-lg border bg-muted/25 px-3 py-2">
      <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        {dot ? <i className="inline-block size-2 rounded-xs" style={{ backgroundColor: dot }} /> : null}
        {label}
      </span>
      <div className="mt-0.5 flex items-baseline gap-1">
        <b className="text-base font-semibold tabular-nums">{value}</b>
        {sub ? <small className="text-[11px] text-muted-foreground">{sub}</small> : null}
      </div>
    </div>
  )
}
