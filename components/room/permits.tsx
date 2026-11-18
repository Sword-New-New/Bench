"use client"

import { useState } from "react"
import { ShieldAlert, ShieldCheck, ShieldOff } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/components/room/api"
import { Reveal } from "@/components/room/reveal"
import type { PermitRequest, PublicAgent, RoomSnapshot } from "@/lib/types"
import { asksOnPage } from "@/lib/kinds"

// Permission prompts of woken Claude Code turns (lib/permits.ts), over the
// composer: the seat waits until one of these buttons is pressed.

async function post(body: Record<string, unknown>) {
  try {
    await api("/api/v1/permit", { method: "POST", body: JSON.stringify({ as: "human", ...body }) })
    return true
  } catch (error) {
    toast.error(error instanceof Error ? error.message : "发送失败")
    return false
  }
}

export function PermitCard({
  item,
  projectName,
  onInspect,
}: {
  item: PermitRequest
  projectName?: string
  onInspect?: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [denying, setDenying] = useState(false)
  const [note, setNote] = useState("")
  const answer = async (decision: "once" | "full" | "deny") => {
    setBusy(true)
    await post({ id: item.id, decision, note: decision === "deny" ? note : undefined })
    setBusy(false)
  }
  const full = item.kind === "full"
  return (
    <div className="notice rounded-2xl px-3 py-2.5 text-xs [--notice-ring:color-mix(in_oklch,var(--color-amber-500)_55%,transparent)]">
      <p className="flex items-center gap-1.5">
        <ShieldAlert className="size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
        <span className="min-w-0 flex-1">
          {projectName ? (
            <span className="mr-1.5 inline-block rounded bg-foreground/[0.06] px-1.5 py-0.5 text-[0.625rem] leading-4 text-muted-foreground">
              {projectName}
            </span>
          ) : null}
          <span className="font-medium">{item.agentName}</span>
          <span className="text-muted-foreground">
            {full ? " 想要这一轮的完整权限" : ` 想${item.plain?.action ?? "用一个工具"}`}
          </span>
        </span>
      </p>
      {/* The sentence first (the client's own on what it is for, or the
          reason given for full permission); the tool name and the command
          itself are behind 「看原始内容」. */}
      {full || item.plain?.why ? (
        <p className="mt-1.5 text-[0.8125rem] leading-5 break-words">{full ? item.reason : item.plain?.why}</p>
      ) : null}
      <details className="group mt-1.5">
        <summary className="cursor-pointer text-[0.6875rem] text-muted-foreground select-none hover:text-foreground">
          看原始内容
        </summary>
        <pre className="mt-1 max-h-32 overflow-auto rounded-lg bg-muted/70 px-2.5 py-1.5 font-mono text-[0.6875rem] leading-4 break-all whitespace-pre-wrap">
          {full ? item.reason : `${item.tool ?? ""}\n${item.input ?? ""}`.trim()}
        </pre>
      </details>
      {onInspect ? (
        <div className="mt-2 flex justify-end">
          <button
            type="button"
            className="rounded-full bg-primary px-3 py-1 font-medium text-primary-foreground hover:opacity-90"
            onClick={onInspect}
          >
            去看
          </button>
        </div>
      ) : denying ? (
        <form
          className="mt-2 flex items-center gap-1.5"
          onSubmit={(event) => {
            event.preventDefault()
            void answer("deny")
          }}
        >
          <input
            autoFocus
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="拒绝原因（选填）"
            aria-label="拒绝的原因"
            className="h-7 min-w-0 flex-1 rounded-full border bg-background/70 px-3 outline-none focus:border-primary"
          />
          <button type="submit" disabled={busy} className="rounded-full bg-destructive px-3 py-1 font-medium text-white disabled:opacity-50">
            拒绝
          </button>
          <button type="button" className="rounded-full px-2 py-1 text-muted-foreground hover:bg-muted" onClick={() => setDenying(false)}>
            取消
          </button>
        </form>
      ) : (
        <div className="mt-2 flex flex-wrap items-center justify-end gap-1.5">
          <button
            type="button"
            disabled={busy}
            className="rounded-full px-3 py-1 text-muted-foreground hover:bg-muted disabled:opacity-50"
            onClick={() => setDenying(true)}
          >
            拒绝…
          </button>
          {full ? null : (
            <button
              type="button"
              disabled={busy}
              className="rounded-full border px-3 py-1 font-medium hover:bg-muted disabled:opacity-50"
              onClick={() => void answer("once")}
            >
              允许一次
            </button>
          )}
          <button
            type="button"
            disabled={busy}
            className="rounded-full bg-amber-500 px-3 py-1 font-medium text-white hover:bg-amber-600 disabled:opacity-50"
            title="本轮剩余操作免确认，结束收回"
            onClick={() => void answer("full")}
          >
            {full ? "允许" : "本轮全允"}
          </button>
        </div>
      )}
    </div>
  )
}

export function PermitBar({ room }: { room: RoomSnapshot }) {
  const items = room.permits ?? []
  return (
    // px/pt: room for the cards' ring, which Reveal would clip (see SummaryNudge).
    <Reveal open={items.length > 0} className="flex flex-col gap-2 px-px pt-px pb-2">
      {items.map((item) => (
        <PermitCard key={item.id} item={item} />
      ))}
    </Reveal>
  )
}

// On a running Claude seat: grant full permission for the rest of this wake,
// or take it back.
export function FullAccessToggle({ agent }: { agent: PublicAgent }) {
  const [busy, setBusy] = useState(false)
  if (!asksOnPage(agent.agentName) || !agent.runId) return null
  const on = Boolean(agent.fullAccess)
  // 「默认开启全部权限」: it can be taken back for this wake; the next one
  // has it again.
  const auto = Boolean(agent.autoFull)
  const label = auto ? (on ? "默认全权 · 收回" : "已收回 · 恢复") : on ? "完整权限 · 收回" : "给全权"
  const hint = auto
    ? on
      ? "本轮收回，下次恢复；长关去菜单取消"
      : "恢复默认全部权限"
    : on
      ? "收回后操作需逐条确认"
      : "本轮免确认，结束自动收回"
  const done = auto
    ? on
      ? "本轮已收回，下次恢复"
      : "已恢复默认全权"
    : on
      ? "已收回完整权限"
      : "本轮已给完整权限"
  return (
    <button
      type="button"
      disabled={busy}
      className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[0.6875rem] disabled:opacity-50 ${
        on ? "bg-amber-500/15 text-amber-700 hover:bg-amber-500/25 dark:text-amber-300" : "text-muted-foreground hover:bg-muted"
      }`}
      title={hint}
      onClick={async () => {
        setBusy(true)
        if (await post({ agentId: agent.id, full: !on })) toast.success(done)
        setBusy(false)
      }}
    >
      {on ? <ShieldCheck className="size-3" /> : <ShieldOff className="size-3" />}
      {label}
    </button>
  )
}
