"use client"

import { useEffect, useRef, useState } from "react"
import { AlertCircle, CheckCircle2, Send, Smartphone, Trash2 } from "lucide-react"
import { toast } from "sonner"

import { AdvancedSection } from "@/components/room/advanced"
import { api, human, storedHumanKey } from "@/components/room/api"
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
import type { PublicPushState, PushChannelId, PushFieldSpec } from "@/lib/push"

export const PUSH_OPEN = "bench-push-open"

const PRESENCE_INTERVAL_MS = 25_000
const PRESENCE_MIN_GAP_MS = 4_000

const timeFormatter = new Intl.DateTimeFormat("zh-CN", {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
})

function formatClock(at: number): string {
  try {
    return timeFormatter.format(at)
  } catch {
    return new Date(at).toLocaleTimeString()
  }
}

type FieldKey = "target" | "token" | "extra"

export function PushDialog() {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [advOpen, setAdvOpen] = useState(false)
  const [saved, setSaved] = useState<PublicPushState | null>(null)

  const [enabled, setEnabled] = useState(false)
  const [channel, setChannel] = useState<PushChannelId>("ntfy")
  const [target, setTarget] = useState("")
  const [token, setToken] = useState("")
  const [extra, setExtra] = useState("")
  const [onEnd, setOnEnd] = useState(false)
  const [titleOnly, setTitleOnly] = useState(false)
  const autoEnabledOnce = useRef(false)

  // Periodically tell the server while this tab is visible and focused so it
  // stays quiet when the user is already looking at the room.
  useEffect(() => {
    let lastSent = 0
    const ping = () => {
      if (typeof document === "undefined") return
      if (document.hidden || !document.hasFocus()) return
      if (!storedHumanKey()) return
      const now = Date.now()
      if (now - lastSent < PRESENCE_MIN_GAP_MS) return
      lastSent = now
      void fetch("/api/v1/push", {
        method: "POST",
        cache: "no-store",
        headers: {
          "content-type": "application/json",
          ...human(),
        },
        body: JSON.stringify({ as: "human", action: "presence", front: true }),
      }).catch(() => {})
    }

    ping()
    const id = window.setInterval(ping, PRESENCE_INTERVAL_MS)
    const onFocus = () => ping()
    const onVisibility = () => {
      if (!document.hidden) ping()
    }
    window.addEventListener("focus", onFocus)
    document.addEventListener("visibilitychange", onVisibility)
    return () => {
      window.clearInterval(id)
      window.removeEventListener("focus", onFocus)
      document.removeEventListener("visibilitychange", onVisibility)
    }
  }, [])

  useEffect(() => {
    const onOpen = () => {
      setAdvOpen(false)
      setLoading(true)
      setOpen(true)
    }
    window.addEventListener(PUSH_OPEN, onOpen)
    return () => window.removeEventListener(PUSH_OPEN, onOpen)
  }, [])

  function applyState(data: PublicPushState) {
    setSaved(data)
    setEnabled(data.enabled)
    setChannel(data.channel)
    setTarget("")
    setToken("")
    setExtra("")
    setOnEnd(data.onEnd)
    setTitleOnly(data.titleOnly)
    autoEnabledOnce.current = data.enabled || data.configured
  }

  useEffect(() => {
    if (!open) return
    let cancelled = false
    void api<PublicPushState>("/api/v1/push")
      .then((data) => {
        if (!cancelled) applyState(data)
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          toast.error(err instanceof Error ? err.message : "读取推送设置失败")
          setOpen(false)
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open])

  const channels = saved?.channels ?? []
  const currentSpec = channels.find((item) => item.id === channel) ?? channels[0]
  const sameAsSaved = saved?.channel === channel

  function buildPayload(extraFields?: Record<string, unknown>) {
    const payload: Record<string, unknown> = {
      as: "human",
      enabled,
      channel,
      onEnd,
      titleOnly,
      ...extraFields,
    }
    if (target.trim()) payload.target = target.trim()
    else if (!sameAsSaved) payload.target = ""

    if (token.trim()) payload.token = token.trim()
    else if (!sameAsSaved) payload.token = ""

    if (extra.trim()) payload.extra = extra.trim()
    else if (!sameAsSaved) payload.extra = ""

    return payload
  }

  function handleSecretInput(key: FieldKey, value: string) {
    if (key === "target") setTarget(value)
    else if (key === "token") setToken(value)
    else setExtra(value)

    if (value.trim() && !autoEnabledOnce.current) {
      autoEnabledOnce.current = true
      setEnabled(true)
    }
  }

  async function handleSave() {
    setSaving(true)
    try {
      const next = await api<PublicPushState>("/api/v1/push", {
        method: "POST",
        body: JSON.stringify(buildPayload({ action: "save" })),
      })
      applyState(next)
      toast.success(next.enabled ? "推送已启用" : "已保存（推送关闭）")
      setOpen(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "保存失败")
    } finally {
      setSaving(false)
    }
  }

  async function handleTest() {
    setTesting(true)
    try {
      const res = await api<{ ok: boolean; error?: string; state: PublicPushState }>("/api/v1/push", {
        method: "POST",
        body: JSON.stringify(buildPayload({ action: "test" })),
      })
      applyState(res.state)
      if (res.ok) {
        toast.success("测试推送已发出")
      } else {
        toast.error(`发送失败：${(res.error || "未知错误").slice(0, 10)}`)
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "测试发送失败")
    } finally {
      setTesting(false)
    }
  }

  async function handleClear() {
    setSaving(true)
    try {
      const next = await api<PublicPushState>("/api/v1/push", {
        method: "POST",
        body: JSON.stringify({ as: "human", action: "clear" }),
      })
      applyState(next)
      toast.success("已清空并停用")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "清空失败")
    } finally {
      setSaving(false)
    }
  }

  const fieldEntries = currentSpec
    ? (Object.entries(currentSpec.fields) as Array<[FieldKey, PushFieldSpec | undefined]>).filter(
        (entry): entry is [FieldKey, PushFieldSpec] => Boolean(entry[1]),
      )
    : []
  const requiredFields = fieldEntries.filter(([, spec]) => Boolean(spec.required))
  const optionalFields = fieldEntries.filter(([, spec]) => !spec.required)

  const fieldValues: Record<FieldKey, string> = { target, token, extra }
  const hasStoredAnything = Boolean(
    saved && (saved.enabled || saved.filled.target || saved.filled.token || saved.filled.extra),
  )
  const busy = loading || saving || testing

  const renderField = ([key, spec]: [FieldKey, PushFieldSpec]) => {
    const alreadyFilled = sameAsSaved && saved?.filled[key]
    const val = fieldValues[key]
    return (
      <div key={key} className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor={`push-field-${key}`} className="text-xs">
            {spec.label}
            {spec.required ? <span className="ml-0.5 text-destructive">*</span> : null}
          </Label>
          {alreadyFilled && !val ? (
            <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[0.625rem] text-emerald-700 dark:text-emerald-300">
              已填（留空不变）
            </span>
          ) : null}
        </div>
        <Input
          id={`push-field-${key}`}
          type="password"
          autoComplete="off"
          value={val}
          placeholder={alreadyFilled ? "留空不变，重填则覆盖" : spec.placeholder}
          className="font-mono text-xs"
          onChange={(event) => handleSecretInput(key, event.target.value)}
        />
      </div>
    )
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Smartphone className="size-4" />
            推送到手机
          </DialogTitle>
          <DialogDescription>
            页面不在前台时，提问、等你验收或权限满 30 秒未处理会外发推送（密钥只存本机 <code className="font-mono text-xs">data/push.json</code>）。
          </DialogDescription>
        </DialogHeader>

        {loading || !saved ? (
          <div className="py-6 text-center text-sm text-muted-foreground">读取中…</div>
        ) : (
          <div className="space-y-4">
            <label className="flex cursor-pointer items-center justify-between gap-3 rounded-xl border px-3 py-2.5">
              <div className="min-w-0">
                <div className="text-sm font-medium">启用手机推送</div>
                <div className="text-xs text-muted-foreground">
                  {enabled ? "不在前台时有事外发推送" : "填好地址并勾选后生效"}
                </div>
              </div>
              <input
                type="checkbox"
                className="size-4 accent-current"
                checked={enabled}
                onChange={(event) => setEnabled(event.target.checked)}
              />
            </label>

            {/* Default shows only the simplest channel (ntfy: cross-platform, no account/group needed, single required topic URL) or the currently saved one; other channels and options stay in 「高级」. */}
            <div className="space-y-3 rounded-xl border p-3">
              <div className="space-y-1">
                <div className="text-xs font-medium">
                  {currentSpec?.label ?? "ntfy"}
                  {channel === "ntfy" ? <span className="ml-1.5 font-normal text-muted-foreground">（免注册，填个主题地址就行）</span> : null}
                </div>
                {currentSpec ? <p className="text-xs text-muted-foreground">{currentSpec.hint}</p> : null}
              </div>
              {requiredFields.map(renderField)}
            </div>

            <AdvancedSection
              open={advOpen}
              onToggle={() => setAdvOpen((v) => !v)}
              note={channel !== "ntfy" ? currentSpec?.label : undefined}
            >
              <div className="space-y-2">
                <Label className="text-xs text-muted-foreground">推送方式</Label>
                <div className="flex flex-wrap gap-1.5">
                  {channels.map((item) => {
                    const active = item.id === channel
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => {
                          setChannel(item.id)
                          setTarget("")
                          setToken("")
                          setExtra("")
                        }}
                        className={`chip rounded-full border px-2.5 py-1 text-xs transition-colors ${
                          active
                            ? "border-foreground/30 bg-foreground text-background font-medium"
                            : "border-border bg-muted/40 text-foreground/80"
                        }`}
                      >
                        {item.label}
                      </button>
                    )
                  })}
                </div>
              </div>

              {optionalFields.length > 0 ? (
                <div className="space-y-3 rounded-xl border p-3">{optionalFields.map(renderField)}</div>
              ) : null}

              <div className="space-y-2 rounded-xl border p-3 text-xs">
                <label className="flex cursor-pointer items-center gap-2">
                  <input
                    type="checkbox"
                    className="accent-current"
                    checked={onEnd}
                    onChange={(event) => setOnEnd(event.target.checked)}
                  />
                  <span>【本轮结束】也推</span>
                </label>
                <label className="flex cursor-pointer items-center gap-2">
                  <input
                    type="checkbox"
                    className="accent-current"
                    checked={titleOnly}
                    onChange={(event) => setTitleOnly(event.target.checked)}
                  />
                  <span>只推标题，不带正文</span>
                </label>
              </div>
            </AdvancedSection>

            {saved.lastError ? (
              <div
                data-push-error
                className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
              >
                <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="font-medium">上次失败 · {formatClock(saved.lastError.at)}</div>
                  <div className="mt-0.5 break-words opacity-90">{saved.lastError.message}</div>
                </div>
              </div>
            ) : saved.lastOkAt ? (
              <div className="flex items-center gap-1.5 px-1 text-xs text-emerald-700 dark:text-emerald-400">
                <CheckCircle2 className="size-3.5 shrink-0" />
                <span>上次成功：{formatClock(saved.lastOkAt)}</span>
              </div>
            ) : null}
          </div>
        )}

        <DialogFooter className="gap-2 sm:justify-between">
          <div className="flex flex-wrap items-center gap-1.5">
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void handleTest()}>
              <Send className="size-3.5" />
              {testing ? "发送中…" : "测试"}
            </Button>
            {hasStoredAnything ? (
              <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void handleClear()}>
                <Trash2 className="size-3.5" />
                清空
              </Button>
            ) : null}
          </div>
          <Button type="button" size="sm" disabled={busy} onClick={() => void handleSave()}>
            {saving ? "保存中…" : "保存"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
