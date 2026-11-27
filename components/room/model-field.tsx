"use client"

import { useCallback, useEffect, useState } from "react"
import { Loader2, RefreshCw } from "lucide-react"
import { toast } from "sonner"

import { AdvancedSection } from "@/components/room/advanced"
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

type Found = { models: Choice[]; fallback: string | null; efforts?: string[] }

const EFFORT_LABEL: Record<string, string> = {
  minimal: "minimal · 极简",
  low: "low · 少想",
  medium: "medium · 适中",
  high: "high · 多想",
  xhigh: "xhigh · 深想",
  max: "max · 最深",
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

export function useModelChoices(kind: string | null) {
  const [found, setFound] = useState<Found | null>(null)
  const [refreshing, setRefreshing] = useState(false)
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

  const refresh = useCallback(() => {
    if (!kind || refreshing) return
    setRefreshing(true)
    api<Found>(`/api/v1/models?kind=${encodeURIComponent(kind)}&refresh=1`)
      .then((data) => setFound(data))
      .catch(() => toast.error("刷新模型列表失败"))
      .finally(() => setRefreshing(false))
  }, [kind, refreshing])

  return { found, refreshing, refresh }
}

// Developer knobs for model picking: custom model id, reasoning effort, and
// context window / auto-compact threshold. Rendered inside 「高级」 when
// collapsible, or inline when already inside a parent 「高级」 section.
export function ModelAdvancedFields({
  kind,
  value,
  onChange,
  customActive,
  onCustomChange,
  effort = "",
  onEffort,
  limits = NO_LIMITS,
  onLimits,
  found: givenFound,
  id = "model-field",
}: {
  kind: string | null
  value: string
  onChange: (value: string) => void
  customActive?: boolean
  onCustomChange?: (value: string) => void
  effort?: string
  onEffort?: (value: string) => void
  limits?: Limits
  onLimits?: (value: Limits) => void
  found?: Found | null
  id?: string
}) {
  const { found: fetched } = useModelChoices(givenFound === undefined ? kind : null)
  const found = givenFound === undefined ? fetched : givenFound
  const choices = found?.models ?? null
  const listed = choices?.some((choice) => choice.id === value) ?? false
  const efforts = found?.efforts ?? []
  const effortItems = [
    { value: DEFAULT, label: "默认（随客户端）" },
    ...efforts.map((level) => ({ value: level, label: EFFORT_LABEL[level] ?? level })),
  ]
  const windowItems = [
    { value: DEFAULT, label: "默认（随模型）" },
    ...WINDOWS.map((tokens) => ({ value: String(tokens), label: `${wan(tokens)} tokens` })),
  ]
  const pct = limits.pct ?? PCT_SHOWN
  const point = limits.window ? Math.round((Number(limits.window) * pct) / 100) : null
  const shownCustom = customActive || (Boolean(value) && choices !== null && !listed) ? value : ""

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-custom`}>自定义模型 id</Label>
        <Input
          id={`${id}-custom`}
          value={shownCustom}
          onChange={(event) => {
            const next = event.target.value.trim()
            if (onCustomChange) onCustomChange(next)
            else onChange(next)
          }}
          placeholder={kind === "claude" ? "留空用上方所选；如 claude-opus-5-5" : "留空用上方所选；手填模型 id"}
          className="font-mono text-xs"
          maxLength={80}
        />
      </div>
      {onEffort && efforts.length ? (
        <div className="space-y-1.5">
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
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-window`}>最大上下文</Label>
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
            <Label htmlFor={`${id}-pct`}>自动压缩阈值</Label>
            <span className="text-sm tabular-nums">
              {limits.pct === null ? (
                <span className="text-muted-foreground">默认</span>
              ) : (
                <>
                  {limits.pct}%
                  <button
                    type="button"
                    className="ml-2 text-xs text-muted-foreground underline-offset-2 hover:underline"
                    onClick={() => onLimits({ ...limits, pct: null })}
                  >
                    重置
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
              ? "随客户端默认设置压缩"
              : point
                ? `约 ${wan(Math.max(kind === "claude" ? 100_000 : 0, point))} 时自动压缩`
                : `用到 ${pct}% 时自动压缩`}
            （越早压越省额度，保留细节越少{kind === "claude" ? "；Claude 最低 10 万" : ""}）。
          </p>
        </div>
      ) : null}
    </div>
  )
}

// `value` "" is the default; so is `effort` "". By default keeps only the model
// picker outside and tucks custom id, effort, and context limits under 「高级」.
export function ModelField({
  kind,
  value,
  onChange,
  effort = "",
  onEffort,
  limits = NO_LIMITS,
  onLimits,
  id = "model-field",
  advancedMode = "collapsible",
}: {
  kind: string | null
  value: string
  onChange: (value: string) => void
  effort?: string
  onEffort?: (value: string) => void
  limits?: Limits
  onLimits?: (value: Limits) => void
  id?: string
  advancedMode?: "collapsible" | "inline" | "external"
}) {
  const { found, refreshing, refresh } = useModelChoices(kind)
  const choices = found?.models ?? null
  const fallback = found?.fallback?.replace(/^[\w-]+:/, "")
  const listed = choices?.some((choice) => choice.id === value) ?? false
  const [typingCustom, setTypingCustom] = useState(false)
  const [advOpen, setAdvOpen] = useState(false)

  const items = [
    { value: DEFAULT, label: fallback ? `默认（${fallback}）` : "默认" },
    ...(choices ?? []).map((choice) => ({ value: choice.id, label: choice.note ? `${choice.label} · ${choice.note}` : choice.label })),
    ...(value && choices !== null && !listed ? [{ value, label: `自定义：${value}` }] : []),
  ]

  const advanced = (
    <ModelAdvancedFields
      kind={kind}
      value={value}
      onChange={onChange}
      customActive={typingCustom}
      onCustomChange={(next) => {
        setTypingCustom(Boolean(next))
        onChange(next)
      }}
      effort={effort}
      onEffort={onEffort}
      limits={limits}
      onLimits={onLimits}
      found={found}
      id={id}
    />
  )

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor={id}>模型</Label>
          {choices !== null ? (
            <button
              type="button"
              onClick={refresh}
              disabled={refreshing}
              className="inline-flex items-center gap-1 text-[0.6875rem] text-muted-foreground hover:text-foreground disabled:opacity-50"
              title="重新读取当前客户端可用模型"
            >
              <RefreshCw className={`size-3 ${refreshing ? "animate-spin" : ""}`} />
              {refreshing ? "刷新中…" : "刷新"}
            </button>
          ) : null}
        </div>
        {choices === null ? (
          <p className="flex items-center gap-1.5 py-1 text-xs text-muted-foreground">
            <Loader2 className="size-3 animate-spin" />
            读取模型…
          </p>
        ) : (
          <Select
            items={items}
            value={value || DEFAULT}
            onValueChange={(next) => {
              setTypingCustom(false)
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
      </div>
      {advancedMode === "inline" ? advanced : null}
      {advancedMode === "collapsible" ? (
        <AdvancedSection open={advOpen} onToggle={() => setAdvOpen((v) => !v)}>
          {advanced}
        </AdvancedSection>
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
  const { found } = useModelChoices(agent?.agentName ?? null)
  const fallback = found?.fallback?.replace(/^[\w-]+:/, "") ?? null
  if ((agent?.id ?? null) !== shown) {
    setShown(agent?.id ?? null)
    setValue(agent?.modelPick ?? "")
    setEffort(agent?.effortPick ?? "")
    setLimits(limitsOf(agent))
  }
  const effectiveShown = value || fallback || (agent?.model ?? "")
  const unchanged =
    value === (agent?.modelPick ?? "") &&
    effectiveShown === (agent?.model ?? "") &&
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
      toast.success("已保存，下次叫醒生效")
      onClose()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "修改失败")
    } finally {
      setSending(false)
    }
  }

  return (
    <Dialog open={agent !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span>换模型</span>
            <span className="text-xs font-normal text-muted-foreground">{agent?.name}</span>
          </DialogTitle>
          <DialogDescription>下次叫醒生效，原会话对话保留。</DialogDescription>
        </DialogHeader>
        <form
          className="min-w-0 space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}
        >
          <ModelField
            key={agent?.id ?? "closed"}
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
              保存
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
