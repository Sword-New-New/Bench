"use client"

import { useEffect, useState } from "react"

import { api } from "@/components/room/api"
import { ago } from "@/lib/status"
import type { SeatContext } from "@/lib/context"

// How full each seat's own conversation is (lib/context.ts), under its row in
// the roster. Read once a minute while the tab is visible, and again whenever
// a seat starts or ends a wake (`runs` changes), since that is when it moves.
const EVERY = 60_000

export function useContexts(runs: string) {
  const [contexts, setContexts] = useState<Record<string, SeatContext>>({})
  useEffect(() => {
    let alive = true
    const load = (initial = false) => {
      if (!initial && document.visibilityState !== "visible") return
      api<{ contexts: Record<string, SeatContext> }>("/api/v1/context")
        .then((data) => alive && setContexts(data.contexts))
        .catch(() => {})
    }
    load(true)
    const timer = window.setInterval(() => load(), EVERY)
    const back = () => document.visibilityState === "visible" && load()
    document.addEventListener("visibilitychange", back)
    return () => {
      alive = false
      window.clearInterval(timer)
      document.removeEventListener("visibilitychange", back)
    }
  }, [runs])
  return contexts
}

// 162073 -> "16.2万"; small ones as they are.
export function tokensShort(tokens: number) {
  if (tokens >= 10_000) return `${Number((tokens / 10_000).toFixed(tokens >= 100_000 ? 0 : 1))}万`
  if (tokens >= 1000) return `${Number((tokens / 1000).toFixed(1))}千`
  return `${tokens}`
}

// How close it is to compacting (or, where that isn't known, to full).
function tone(near: number) {
  if (near >= 90) return "bg-red-500"
  if (near >= 70) return "bg-amber-500"
  return "bg-sky-500"
}

export function ContextLine({ context, now }: { context: SeatContext | undefined; now: number }) {
  if (!context) return null
  const { tokens, window, percent, compacted, compactAt } = context
  const mark = compactAt ? Math.min(100, Math.round((compactAt / window) * 100)) : null
  const near = tokens !== null && compactAt ? Math.round((tokens / compactAt) * 100) : (percent ?? 0)
  const when = compactAt ? `用到约 ${tokensShort(compactAt)}（${mark}%）会自己压缩` : "什么时候自己压缩按客户端自己的设置"
  const title = [
    tokens === null
      ? `刚压缩过，现在多大要等它下一轮才知道。最大 ${tokensShort(window)}，${when}`
      : `上下文 ${tokens.toLocaleString()} / 最大 ${window.toLocaleString()} tokens（${percent}%），${when}`,
    context.model ? `模型 ${context.model}` : "",
    compacted
      ? `上次压缩：${now ? ago(compacted.at, now) : ""}${compacted.auto ? "（自动）" : "（手动）"}${
          compacted.before && compacted.after ? `，${tokensShort(compacted.before)} → ${tokensShort(compacted.after)}` : ""
        }`
      : "",
  ]
    .filter(Boolean)
    .join("\n")
  return (
    <span className="mt-0.5 flex items-center gap-1.5 text-[11px] leading-4 text-muted-foreground" title={title}>
      <span className="shrink-0">上下文</span>
      <span
        className="relative h-1.5 w-14 shrink-0 overflow-hidden rounded-full bg-muted"
        role="meter"
        aria-label="上下文已用"
        aria-valuenow={percent ?? 0}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        {percent !== null ? (
          <span className={`absolute inset-y-0 left-0 rounded-full ${tone(near)}`} style={{ width: `${Math.max(percent, 2)}%` }} />
        ) : null}
        {/* Where it compacts by itself. */}
        {mark !== null && mark < 100 ? (
          <span className="absolute inset-y-[-1px] w-px bg-foreground/60" style={{ left: `${mark}%` }} />
        ) : null}
      </span>
      <span className="min-w-0 truncate tabular-nums">
        {tokens === null ? `刚压缩 / ${tokensShort(window)}` : `${tokensShort(tokens)} / ${tokensShort(window)}`}
      </span>
    </span>
  )
}
