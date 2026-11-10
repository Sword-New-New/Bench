"use client"

import { useEffect, useState, type ReactNode } from "react"
import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip"

import { api } from "@/components/room/api"
import { ago } from "@/lib/status"
import type { Quota, QuotaWindow } from "@/lib/quota"

// The account allowance of each client signed in with one (lib/quota.ts),
// shown under its entry in the roster. Read every five minutes while the tab
// is visible, and again when a quiet tab comes back into view.
const EVERY = 5 * 60_000

export function useQuotas() {
  const [list, setList] = useState<Quota[]>([])
  useEffect(() => {
    let alive = true
    let last = 0
    const load = (initial = false) => {
      if (!initial && document.visibilityState !== "visible") return
      last = Date.now()
      api<{ quotas: Quota[] }>("/api/v1/quota")
        .then((data) => alive && setList(data.quotas))
        .catch(() => {})
    }
    load(true)
    const timer = window.setInterval(() => load(), EVERY)
    const back = () => {
      if (document.visibilityState === "visible" && Date.now() - last >= EVERY) load()
    }
    document.addEventListener("visibilitychange", back)
    return () => {
      alive = false
      window.clearInterval(timer)
      document.removeEventListener("visibilitychange", back)
    }
  }, [])
  return list
}

// When it resets: short on the line ("07:30" today, "11/11" later), in full on hover.
function resetText(at: string | null, now: number) {
  if (!at) return { short: "", full: "" }
  const date = new Date(at)
  const left = date.getTime() - now
  if (!Number.isFinite(left)) return { short: "", full: "" }
  if (left <= 0) return { short: "该重置了", full: "该重置了" }
  const time = date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })
  const day = `${date.getMonth() + 1}/${date.getDate()}`
  const hours = Math.floor(left / 3600_000)
  const span = hours >= 24 ? `${Math.floor(hours / 24)} 天 ${hours % 24} 小时` : `${hours} 小时 ${Math.floor((left % 3600_000) / 60_000)} 分`
  return { short: left < 24 * 3600_000 ? time : day, full: `${day} ${time} 重置，还有 ${span}` }
}

function tone(percent: number) {
  if (percent >= 100) return "bg-red-500"
  if (percent >= 80) return "bg-amber-500"
  return "bg-emerald-500"
}

export function QuotaLines({ quota, now }: { quota: Quota | undefined; now: number }) {
  if (!quota?.account) return null
  if (quota.windows.length === 0) {
    return quota.error ? (
      <span className="mt-1 block truncate text-[11px] text-muted-foreground" title={quota.error}>
        额度：{quota.error}
      </span>
    ) : null
  }
  return (
    <span className="mt-1 block space-y-0.5">
      {quota.windows.map((window, index) => (
        <span key={`${window.group ?? ""}${window.label}`} className="block">
          {window.group && window.group !== quota.windows[index - 1]?.group ? (
            <span className="block text-[11px] leading-4 font-medium text-muted-foreground/80">{window.group}</span>
          ) : null}
          <Line window={window} now={now} />
        </span>
      ))}
      {quota.source ? (
        <span className="block truncate text-[10px] leading-4 text-muted-foreground/70" title="插件递交的用量，不是房间自己读的">
          {quota.source} 递交{quota.reportedAt ? ` · ${ago(quota.reportedAt, now)}` : ""}
        </span>
      ) : quota.staleAt ? (
        <span
          className="block truncate text-[10px] leading-4 text-muted-foreground/70"
          title={quota.error ? `${quota.error}；先显示上次读到的数` : "先显示上次读到的数"}
        >
          上次读数 · {ago(quota.staleAt, now)}
        </span>
      ) : null}
    </span>
  )
}

function Line({ window, now }: { window: QuotaWindow; now: number }) {
  const full = window.percent >= 100
  const reset = resetText(window.resetsAt, now)
  return (
    <span
      className="flex items-center gap-1.5 text-[11px] leading-4 text-muted-foreground"
      title={`${window.group ? `${window.group} ` : ""}${window.label}已用 ${window.percent}%${reset.full ? `，${reset.full}` : ""}`}
    >
      <span className="w-[3.25rem] shrink-0 truncate">{window.label}</span>
      <span
        className="relative h-1 w-8 shrink-0 overflow-hidden rounded-full bg-muted"
        role="meter"
        aria-label={`${window.label}已用`}
        aria-valuenow={window.percent}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <span className={`absolute inset-y-0 left-0 rounded-full ${tone(window.percent)}`} style={{ width: `${window.percent}%` }} />
      </span>
      <span className={`shrink-0 tabular-nums ${full ? "text-red-600 dark:text-red-400" : ""}`}>
        {full ? "用完" : `${window.percent}%`}
      </span>
      <span className="min-w-0 truncate">{reset.short}</span>
    </span>
  )
}

// The allowance that is closest to running out; it stands for the whole client.
export function topWindow(quota: Quota | undefined) {
  if (!quota?.account) return null
  return quota.windows.reduce<QuotaWindow | null>((top, window) => (!top || window.percent > top.percent ? window : top), null)
}

const RING = { ok: "text-emerald-500", warn: "text-amber-500", full: "text-red-500" }

// A client's entry in the roster, folded: one ring for the most-used
// allowance, green until 80%, then amber with its name and number, red once
// used up. A short amber word when the allowance can't be read. Hover floats
// every allowance out (`card` adds whatever else belongs there) without
// moving anything; a click is the caller's, usually unfolding the entry.
export function QuotaRing({
  quota,
  now,
  heading,
  card,
  expanded,
  onClick,
}: {
  quota: Quota | undefined
  now: number
  heading: string
  card?: ReactNode
  expanded: boolean
  onClick: () => void
}) {
  if (!quota?.account) return null
  const top = topWindow(quota)
  if (!top && !quota.error) return null
  const full = Boolean(top && (top.percent >= 100 || quota.blocked))
  const state = !top ? "warn" : full ? "full" : top.percent >= 80 ? "warn" : "ok"
  const label = !top ? "读不到额度" : full ? "用完" : top.percent >= 80 ? `${top.label} ${top.percent}%` : ""
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger
        className="flex h-7 min-w-0 shrink items-center gap-1 rounded-lg px-1 text-[11px] transition-colors hover:bg-sidebar-accent"
        aria-expanded={expanded}
        aria-label={`${heading} 的额度${label ? `：${label}` : ""}，点开看详情`}
        onClick={onClick}
      >
        {label ? (
          <span
            className={`min-w-0 truncate tabular-nums ${
              state === "full" ? "text-red-600 dark:text-red-400" : "text-amber-700 dark:text-amber-400"
            }`}
          >
            {label}
          </span>
        ) : null}
        {top ? (
          <svg viewBox="0 0 16 16" className={`size-4 shrink-0 -rotate-90 ${RING[state]}`} aria-hidden="true">
            <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeOpacity={0.14} strokeWidth={2.6} />
            <circle
              cx="8"
              cy="8"
              r="6"
              fill="none"
              stroke="currentColor"
              strokeWidth={2.6}
              strokeLinecap="round"
              pathLength={100}
              strokeDasharray={`${Math.max(2, Math.min(100, top.percent))} 100`}
            />
          </svg>
        ) : null}
      </TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Positioner side="right" align="start" sideOffset={10} className="isolate z-50">
          <TooltipPrimitive.Popup className="w-60 origin-(--transform-origin) rounded-xl border bg-popover/95 px-3 py-2 text-popover-foreground shadow-lg backdrop-blur-xl transition-[opacity,scale] data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0">
            <span className="block text-xs font-semibold">{heading}</span>
            {top ? (
              <>
                <QuotaLines quota={quota} now={now} />
                {top.resetsAt ? (
                  <span className="mt-1 block text-[11px] leading-4 text-muted-foreground">
                    {top.group ? `${top.group} ` : ""}
                    {top.label}：{resetText(top.resetsAt, now).full}
                  </span>
                ) : null}
              </>
            ) : (
              <span className="mt-1 block text-[11px] text-muted-foreground">额度读不到：{quota.error}</span>
            )}
            {card}
          </TooltipPrimitive.Popup>
        </TooltipPrimitive.Positioner>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  )
}
