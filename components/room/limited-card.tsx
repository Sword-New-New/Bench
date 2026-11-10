"use client"

import { useState } from "react"
import { Check, Clock, Hourglass } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/components/room/api"
import { Button } from "@/components/ui/button"
import { whenText } from "@/lib/limits"
import type { Message } from "@/lib/types"

// Under 「X 撞到额度」: what ran out, and what to do about the turn it cut
// short. Like Claude Code's own prompt after a limit: carry on by itself once
// the allowance resets, carry on now, or leave it. The room does the waiting
// (lib/summon.ts limitChoice); this only picks.

export function LimitedCard({ message }: { message: Message }) {
  const limited = message.limited
  const [sending, setSending] = useState(false)
  if (!limited) return null

  const choose = async (action: "schedule" | "now" | "cancel" | "dismiss", done?: string) => {
    setSending(true)
    try {
      await api(`/api/v1/runs/${limited.runId}`, { method: "POST", body: JSON.stringify({ as: "human", action }) })
      if (done) toast.success(done)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "没成功")
    } finally {
      setSending(false)
    }
  }

  const resets = limited.resetsAt
  let body
  if (limited.state === "resumed") {
    body = (
      <span className="inline-flex items-center gap-1">
        <Check className="size-3" />
        {limited.agentName} 已经叫醒，接着做了{limited.at ? ` · ${whenText(limited.at)}` : ""}
      </span>
    )
  } else if (limited.state === "dismissed") {
    body = <span>不自动继续{limited.note ? `（${limited.note}）` : ""}</span>
  } else if (limited.state === "scheduled") {
    body = (
      <span className="inline-flex flex-wrap items-center justify-center gap-1.5">
        <Hourglass className="size-3" />
        {limited.at ? `${whenText(limited.at)} 自动叫醒 ${limited.agentName} 接着做` : "等重置后自动接着做"}
        <Button type="button" size="xs" variant="ghost" disabled={sending} onClick={() => void choose("cancel")}>
          取消
        </Button>
      </span>
    )
  } else {
    body = (
      <span className="inline-flex flex-wrap items-center justify-center gap-1.5">
        {limited.state === "failed" ? <span className="text-destructive">自动叫醒没成功：{limited.note}</span> : null}
        {resets ? (
          <Button type="button" size="xs" disabled={sending} onClick={() => void choose("schedule", `${whenText(resets)} 重置后自动叫醒 ${limited.agentName}`)}>
            <Clock className="size-3" />
            重置后自动继续 · {whenText(resets)}
          </Button>
        ) : null}
        <Button type="button" size="xs" variant="outline" disabled={sending} onClick={() => void choose("now", "叫醒了，会带着原来那些消息接着做")}>
          现在重试
        </Button>
        <Button type="button" size="xs" variant="ghost" disabled={sending} onClick={() => void choose("dismiss")}>
          不用了
        </Button>
      </span>
    )
  }

  return (
    <div className="my-2 self-center rounded-2xl border border-amber-500/30 bg-amber-500/[0.08] px-4 py-2.5 text-center text-xs leading-5 text-muted-foreground">
      <p>{message.text}</p>
      <div className="mt-2">{body}</div>
    </div>
  )
}
