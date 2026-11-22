"use client"

import { useState } from "react"
import { ArrowRightLeft, Check, Clock, Hourglass } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/components/room/api"
import { openSeatProfileFor } from "@/components/room/seat-profile-dialog"
import { Button } from "@/components/ui/button"
import { whenText } from "@/lib/limits"
import type { Message } from "@/lib/types"

// Under 「X 撞到额度」: what ran out, and what to do about the turn it cut
// short. Carry on by itself once the allowance resets, retry now, switch the
// seat to another AI vendor to take over immediately, or dismiss.

export function LimitedCard({
  message,
  compact = false,
  count = 1,
  projectName,
  onInspect,
  onOpenRun,
}: {
  message: Message
  compact?: boolean
  // How many times this seat hit the limit, when the card stands for several.
  count?: number
  projectName?: string
  onInspect?: () => void
  onOpenRun?: (runId: string) => void
}) {
  const limited = message.limited
  const [sending, setSending] = useState(false)
  if (!limited) return null

  if (onInspect) {
    return (
      <div
        className={`rounded-2xl border bg-card px-3 py-2.5 text-xs shadow-sm ${
          limited.kind === "balance" ? "border-destructive/35" : "border-amber-500/35"
        }`}
      >
        <p className="flex flex-wrap items-center gap-1.5 font-medium">
          {projectName ? (
            <span className="rounded bg-foreground/[0.06] px-1.5 py-0.5 text-[0.625rem] leading-4 text-muted-foreground">
              {projectName}
            </span>
          ) : null}
          <span>{limited.kind === "balance" ? `${limited.agentName} 余额不足` : `${limited.agentName} 撞到额度`}</span>
        </p>
        <p className="mt-1 text-muted-foreground">{message.text}</p>
        {count > 1 ? <p className="mt-0.5 text-muted-foreground">共撞了 {count} 次</p> : null}
        <div className="mt-2 flex justify-end gap-1.5">
          {onOpenRun && limited.runId ? (
            <Button type="button" size="xs" variant="ghost" onClick={() => onOpenRun(limited.runId)}>
              查看过程
            </Button>
          ) : null}
          <Button type="button" size="xs" onClick={onInspect}>
            去看
          </Button>
        </div>
      </div>
    )
  }

  const choose = async (action: "schedule" | "now" | "cancel" | "dismiss", done?: string) => {
    setSending(true)
    try {
      await api(`/api/v1/runs/${limited.runId}`, { method: "POST", body: JSON.stringify({ as: "human", action }) })
      if (done) toast.success(done)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "操作失败")
    } finally {
      setSending(false)
    }
  }

  const openRebind = () => {
    openSeatProfileFor(limited.agentId, { tab: "rebind", fromRunId: limited.runId })
  }

  const resets = limited.resetsAt
  let body
  if (limited.state === "rebound") {
    body = (
      <span className="inline-flex items-center gap-1">
        <Check className="size-3" />
        已换 {limited.reboundTo ?? "其他客户端"} 接着做
        {limited.at ? ` · ${whenText(limited.at)}` : ""}
      </span>
    )
  } else if (limited.state === "resumed") {
    body = (
      <span className="inline-flex items-center gap-1">
        <Check className="size-3" />
        已叫醒 {limited.agentName} 接着做{limited.at ? ` · ${whenText(limited.at)}` : ""}
      </span>
    )
  } else if (limited.state === "dismissed") {
    body = <span>已忽略{limited.note ? `（${limited.note}）` : ""}</span>
  } else if (limited.state === "scheduled") {
    body = (
      <span className="inline-flex flex-wrap items-center justify-center gap-1.5">
        <Hourglass className="size-3" />
        {limited.at ? `${whenText(limited.at)} 自动叫醒接着做` : "到点自动继续"}
        <Button type="button" size="xs" variant="outline" disabled={sending} onClick={openRebind}>
          <ArrowRightLeft className="size-3" />
          换客户端…
        </Button>
        <Button type="button" size="xs" variant="ghost" disabled={sending} onClick={() => void choose("cancel")}>
          取消
        </Button>
      </span>
    )
  } else {
    body = (
      <span className="inline-flex flex-wrap items-center justify-center gap-1.5">
        {limited.state === "failed" ? <span className="text-destructive">自动叫醒失败：{limited.note}</span> : null}
        {resets ? (
          <Button type="button" size="xs" disabled={sending} onClick={() => void choose("schedule", "到点自动叫醒")}>
            <Clock className="size-3" />
            到点继续
          </Button>
        ) : null}
        <Button type="button" size="xs" variant={resets ? "outline" : "default"} disabled={sending} onClick={() => void choose("now", "已叫醒接着做")}>
          现在重试
        </Button>
        <Button type="button" size="xs" variant="outline" disabled={sending} onClick={openRebind}>
          <ArrowRightLeft className="size-3" />
          换客户端…
        </Button>
        <Button type="button" size="xs" variant="ghost" disabled={sending} onClick={() => void choose("dismiss")}>
          忽略
        </Button>
      </span>
    )
  }

  return (
    <div
      className={
        compact
          ? `rounded-2xl border bg-card px-3 py-2.5 text-xs shadow-sm ${
              limited.kind === "balance" ? "border-destructive/35" : "border-amber-500/35"
            }`
          : `my-2 self-center rounded-2xl border px-4 py-2.5 text-center text-xs leading-5 ${
              limited.kind === "balance"
                ? "border-destructive/30 bg-destructive/[0.07] text-destructive dark:text-red-300"
                : "border-amber-500/30 bg-amber-500/[0.08] text-muted-foreground"
            }`
      }
    >
      <p className={compact ? "font-medium text-foreground" : "font-medium"}>{message.text}</p>
      {count > 1 ? <p className={compact ? "mt-0.5 text-muted-foreground" : ""}>共撞了 {count} 次</p> : null}
      <div className={`mt-2 flex flex-wrap items-center gap-1.5 ${compact ? "justify-start [&>span]:justify-start" : "justify-center"}`}>
        {body}
        {onOpenRun && limited.runId ? (
          <Button type="button" size="xs" variant="ghost" onClick={() => onOpenRun(limited.runId)}>
            查看过程
          </Button>
        ) : null}
      </div>
    </div>
  )
}
