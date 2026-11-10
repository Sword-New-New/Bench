"use client"

import { useEffect, useState } from "react"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/components/room/api"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { PublicAgent } from "@/lib/types"

// Which model a seat's wakes run on (lib/models.ts): the client's default, one
// the room lists for its kind, or any id typed in.

type Choice = { id: string; label: string; note?: string }

const DEFAULT = "__default"
const OTHER = "__other"

type Found = { models: Choice[]; fallback: string | null; efforts?: string[] }

const EFFORT_LABEL: Record<string, string> = {
  minimal: "minimal · 几乎不想",
  low: "low · 少想，快",
  medium: "medium · 适中",
  high: "high · 多想",
  xhigh: "xhigh · 想得很深",
  max: "max · 想到底，最慢",
}

// How much context a seat may hold and at what share of it it compacts by
// itself (lib/context.ts). `window` "" is the model's own, `pct` null the
// client's own setting. Claude Code won't compact under 10 万.
const WINDOW_KINDS = ["claude", "codex"]
const WINDOWS = [100_000, 200_000, 300_000, 400_000, 500_000, 1_000_000]
export type Limits = { window: string; pct: number | null }
export const NO_LIMITS: Limits = { window: "", pct: null }
export function limitsOf(agent: { windowPick?: number; compactPct?: number } | null | undefined): Limits {
  return { window: agent?.windowPick ? String(agent.windowPick) : "", pct: agent?.compactPct ?? null }
}
// Shown where nothing is picked yet; Claude Code's own default sits near it.
const PCT_SHOWN = 90

function wan(tokens: number) {
  return `${Number((tokens / 10_000).toFixed(1))} 万`
}

function useChoices(kind: string | null) {
  const [found, setFound] = useState<Found | null>(null)
  useEffect(() => {
    if (!kind) return
    let stop = false
    api<Found>(`/api/v1/models?kind=${encodeURIComponent(kind)}`)
      .then((data) => !stop && setFound(data))
      .catch(() => !stop && setFound({ models: [], fallback: null }))
    return () => {
      stop = true
    }
  }, [kind])
  return found
}

// `value` "" is the default; so is `effort` "". The effort menu shows only for
// kinds whose CLI takes one (lib/models.ts EFFORTS), the context ones only for
// Claude Code and Codex.
export function ModelField({
  kind,
  value,
  onChange,
  effort = "",
  onEffort,
  limits = NO_LIMITS,
  onLimits,
  id = "model-field",
}: {
  kind: string | null
  value: string
  onChange: (value: string) => void
  effort?: string
  onEffort?: (value: string) => void
  limits?: Limits
  onLimits?: (value: Limits) => void
  id?: string
}) {
  const found = useChoices(kind)
  const efforts = found?.efforts ?? []
  const effortItems = [
    { value: DEFAULT, label: "默认（跟客户端设置走）" },
    ...efforts.map((level) => ({ value: level, label: EFFORT_LABEL[level] ?? level })),
  ]
  const windowItems = [
    { value: DEFAULT, label: "默认（模型自带的）" },
    ...WINDOWS.map((tokens) => ({ value: String(tokens), label: `${wan(tokens)} tokens` })),
  ]
  const pct = limits.pct ?? PCT_SHOWN
  const point = limits.window ? Math.round((Number(limits.window) * pct) / 100) : null
  const choices = found?.models ?? null
  // What the default is, when the room can tell.
  const fallback = found?.fallback?.replace(/^[\w-]+:/, "")
  const listed = choices?.some((choice) => choice.id === value) ?? false
  // Typing one in: chosen from the menu, or a value the list doesn't have.
  const [typing, setTyping] = useState(false)
  const other = typing || (Boolean(value) && choices !== null && !listed)
  const selected = other ? OTHER : value || DEFAULT

  const items = [
    { value: DEFAULT, label: fallback ? `默认（${fallback}）` : "默认" },
    ...(choices ?? []).map((choice) => ({ value: choice.id, label: choice.note ? `${choice.label} · ${choice.note}` : choice.label })),
    { value: OTHER, label: "其他，自己填…" },
  ]

  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>模型</Label>
      {choices === null ? (
        <p className="flex items-center gap-1.5 py-1 text-xs text-muted-foreground">
          <Loader2 className="size-3 animate-spin" />
          正在看有哪些模型…
        </p>
      ) : (
        <Select
          items={items}
          value={selected}
          onValueChange={(next) => {
            if (next === OTHER) {
              setTyping(true)
              if (listed) onChange("")
              return
            }
            setTyping(false)
            onChange(next === DEFAULT || !next ? "" : next)
          }}
        >
          <SelectTrigger id={id} className="w-full min-w-0 text-sm">
            <SelectValue className="truncate" />
          </SelectTrigger>
          <SelectContent>
            {items.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {other ? (
        <Input
          value={value}
          onChange={(event) => onChange(event.target.value.trim())}
          placeholder={kind === "claude" ? "比如 claude-opus-5-5 或 opus" : "模型 id"}
          aria-label="模型 id"
          className="font-mono text-xs"
          maxLength={80}
          autoFocus
        />
      ) : null}
      {onEffort && efforts.length ? (
        <div className="space-y-1.5 pt-2">
          <Label htmlFor={`${id}-effort`}>思考强度</Label>
          <Select items={effortItems} value={effort || DEFAULT} onValueChange={(next) => onEffort(next === DEFAULT || !next ? "" : next)}>
            <SelectTrigger id={`${id}-effort`} className="w-full min-w-0 text-sm">
              <SelectValue className="truncate" />
            </SelectTrigger>
            <SelectContent>
              {effortItems.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}
      {onLimits && kind && WINDOW_KINDS.includes(kind) ? (
        <div className="space-y-1.5 pt-2">
          <Label htmlFor={`${id}-window`}>最大上下文窗口</Label>
          <Select
            items={windowItems}
            value={limits.window || DEFAULT}
            onValueChange={(next) => onLimits({ ...limits, window: next === DEFAULT || !next ? "" : next })}
          >
            <SelectTrigger id={`${id}-window`} className="w-full min-w-0 text-sm">
              <SelectValue className="truncate" />
            </SelectTrigger>
            <SelectContent>
              {windowItems.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="flex items-baseline justify-between gap-2 pt-2">
            <Label htmlFor={`${id}-pct`}>用到多少自动压缩</Label>
            <span className="text-sm tabular-nums">
              {limits.pct === null ? (
                <span className="text-muted-foreground">默认（跟客户端设置走）</span>
              ) : (
                <>
                  {limits.pct}%
                  <button
                    type="button"
                    className="ml-2 text-xs text-muted-foreground underline-offset-2 hover:underline"
                    onClick={() => onLimits({ ...limits, pct: null })}
                  >
                    恢复默认
                  </button>
                </>
              )}
            </span>
          </div>
          <input
            id={`${id}-pct`}
            type="range"
            min={10}
            max={100}
            step={5}
            value={pct}
            onChange={(event) => onLimits({ ...limits, pct: Number(event.target.value) })}
            className={`w-full accent-primary ${limits.pct === null ? "opacity-50" : ""}`}
            aria-valuetext={limits.pct === null ? "默认" : `${limits.pct}%`}
          />
          <p className="text-xs text-muted-foreground">
            {limits.pct === null && !limits.window
              ? "都不设就按客户端自己的设置压缩。"
              : point
                ? `用到约 ${wan(Math.max(kind === "claude" ? 100_000 : 0, point))} 时自动压缩。`
                : `用到模型窗口的 ${pct}% 时自动压缩。`}
            越早压越省钱、回得越快，但记得的细节越少。
            {kind === "claude" ? "Claude Code 最低 10 万。" : ""}
          </p>
        </div>
      ) : null}
    </div>
  )
}

// 「换模型…」 from a seat's menu. Takes effect from its next wake.
export function ModelDialog({ agent, onClose }: { agent: PublicAgent | null; onClose: () => void }) {
  const [value, setValue] = useState("")
  const [effort, setEffort] = useState("")
  const [limits, setLimits] = useState<Limits>(NO_LIMITS)
  const [sending, setSending] = useState(false)
  const [shown, setShown] = useState<string | null>(null)
  if ((agent?.id ?? null) !== shown) {
    setShown(agent?.id ?? null)
    setValue(agent?.modelPick ?? "")
    setEffort(agent?.effortPick ?? "")
    setLimits(limitsOf(agent))
  }
  const unchanged =
    value === (agent?.modelPick ?? "") &&
    effort === (agent?.effortPick ?? "") &&
    limits.window === limitsOf(agent).window &&
    limits.pct === limitsOf(agent).pct

  const save = async () => {
    if (!agent || sending) return
    setSending(true)
    try {
      await api(`/api/v1/agents/${agent.id}`, {
        method: "POST",
        body: JSON.stringify({
          as: "human",
          action: "model",
          model: value || null,
          effort: effort || null,
          window: limits.window ? Number(limits.window) : null,
          compactPct: limits.pct,
        }),
      })
      toast.success(
        `${agent.name} 下次被叫醒时用 ${value || "默认模型"}${effort ? `，思考强度 ${effort}` : ""}${
          limits.window ? `，最大上下文 ${wan(Number(limits.window))}` : ""
        }${limits.pct ? `，用到 ${limits.pct}% 自动压缩` : ""
        }`,
      )
      onClose()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "没改成")
    } finally {
      setSending(false)
    }
  }

  return (
    <Dialog open={agent !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{agent?.name} 用哪个模型</DialogTitle>
          <DialogDescription>
            从它下一次被叫醒开始生效，正在跑的这次不变。同一个会话换模型，之前的对话都还在。
          </DialogDescription>
        </DialogHeader>
        <form
          className="min-w-0 space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}
        >
          <ModelField
            kind={agent?.agentName ?? null}
            value={value}
            onChange={setValue}
            effort={effort}
            onEffort={setEffort}
            limits={limits}
            onLimits={setLimits}
            id="seat-model"
          />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              取消
            </Button>
            <Button type="submit" disabled={sending || unchanged}>
              {sending ? <Loader2 className="animate-spin" /> : null}
              好
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
