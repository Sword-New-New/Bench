"use client"

import { useState } from "react"
import { BellRing, Check, ClipboardCheck, ExternalLink, Send, X } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/components/room/api"
import { openProjectAt } from "@/components/room/refs"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { clock } from "@/lib/status"
import type { Message, RelayDraft } from "@/lib/types"

// A card at the front desk (lib/front-relay.ts): something its AI drafted to
// send into a project, or a to-do there waiting on the user. It leaves the
// desk only when the user clicks 「发出」 / 「通过」 here.

const HEAD: Record<RelayDraft["kind"], { label: string; icon: typeof Send }> = {
  relay: { label: "转达", icon: Send },
  nudge: { label: "催一下", icon: BellRing },
  review: { label: "等你验收", icon: ClipboardCheck },
  batch: { label: "整批验收", icon: ClipboardCheck },
}

export function RelayCard({ message }: { message: Message }) {
  const relay = message.relay
  const [text, setText] = useState(relay?.text ?? "")
  const [busy, setBusy] = useState(false)
  if (!relay) return null
  const head = HEAD[relay.kind]
  const Icon = head.icon
  const open = relay.state === "draft"

  const act = async (action: "send" | "drop" | "pass") => {
    if (action === "send" && !text.trim()) {
      toast.error("原话是空的")
      return
    }
    setBusy(true)
    try {
      await api("/api/v1/relay", {
        method: "POST",
        body: JSON.stringify({ as: "human", messageId: message.id, action, ...(action === "send" ? { text } : {}) }),
      })
      toast.success(action === "send" ? `已发给 ${relay.seatName}` : action === "pass" ? "验收通过" : "不发了")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "没成功")
    } finally {
      setBusy(false)
    }
  }

  const look = () => openProjectAt(relay.project, relay.taskId)
  const to = relay.kind === "review" ? (relay.seatName ? `负责人 ${relay.seatName}` : "") : relay.seatName ? `→ ${relay.seatName}` : ""

  return (
    <div className="my-2 w-full max-w-[min(42rem,100%)] self-start rounded-2xl border border-primary/25 bg-primary/[0.05] px-4 py-3 text-sm">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1 font-medium text-foreground">
          <Icon className="size-3.5" />
          {head.label}
        </span>
        <span className="min-w-0 truncate">
          「{relay.projectName}」{to ? ` ${to}` : ""}
        </span>
      </div>

      {relay.why ? <p className="mt-1.5 text-xs leading-5 text-muted-foreground">{relay.why}</p> : null}

      {relay.kind === "review" ? (
        <div className="mt-2">
          <p className="font-medium leading-6" title={relay.taskId}>
            {relay.taskTitle}
          </p>
          {relay.text ? <p className="mt-1 line-clamp-4 text-xs leading-5 text-muted-foreground">{relay.text}</p> : null}
        </div>
      ) : open ? (
        <div className="mt-2">
          <Textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            rows={Math.min(6, Math.max(2, Math.ceil(text.length / 40)))}
            className="resize-y text-sm"
            aria-label="要发出的原话"
          />
        </div>
      ) : (
        <p className="mt-2 whitespace-pre-wrap leading-6">{relay.text}</p>
      )}

      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        {open && relay.kind !== "review" ? (
          <>
            <Button type="button" size="sm" disabled={busy} onClick={() => void act("send")}>
              <Send className="size-3.5" />
              发出
            </Button>
            <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void act("drop")}>
              <X className="size-3.5" />
              不发
            </Button>
          </>
        ) : null}
        {open && relay.kind === "review" ? (
          <>
            <Button type="button" size="sm" disabled={busy} onClick={() => void act("pass")}>
              <Check className="size-3.5" />
              通过
            </Button>
            <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void act("drop")}>
              <X className="size-3.5" />
              收起
            </Button>
          </>
        ) : null}
        {!open ? (
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            {relay.state === "dropped" ? null : <Check className="size-3" />}
            {relay.state === "sent" ? "已发出" : relay.state === "passed" ? "已通过" : relay.kind === "review" ? "已收起" : "没发"}
            {relay.settledAt ? ` · ${clock(relay.settledAt)}` : ""}
          </span>
        ) : null}
        <Button type="button" size="sm" variant="outline" className="ml-auto" onClick={look}>
          <ExternalLink className="size-3.5" />
          去看
        </Button>
      </div>
    </div>
  )
}
