"use client"

import { useState } from "react"
import { ShieldAlert, ShieldCheck, ShieldOff } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/components/room/api"
import { Reveal } from "@/components/room/reveal"
import type { PermitRequest, PublicAgent, RoomSnapshot } from "@/lib/types"

// Permission prompts of woken Claude Code turns (lib/permits.ts), over the
// composer: the seat waits until one of these buttons is pressed.

async function post(body: Record<string, unknown>) {
  try {
    await api("/api/v1/permit", { method: "POST", body: JSON.stringify({ as: "human", ...body }) })
    return true
  } catch (error) {
    toast.error(error instanceof Error ? error.message : "没发出去")
    return false
  }
}

function PermitCard({ item }: { item: PermitRequest }) {
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
    <div className="pill rounded-2xl px-3 py-2.5 text-xs ring-1 ring-amber-500/50">
      <p className="flex items-center gap-1.5">
        <ShieldAlert className="size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
        <span className="min-w-0 flex-1">
          <span className="font-medium">{item.agentName}</span>
          <span className="text-muted-foreground">
            {full ? " 请求这次唤起的临时完整权限" : ` 想用 ${item.tool}，等你允许`}
          </span>
        </span>
      </p>
      <pre className="mt-1.5 max-h-32 overflow-auto rounded-lg bg-muted/70 px-2.5 py-1.5 font-mono text-[11px] leading-4 break-all whitespace-pre-wrap">
        {full ? item.reason : item.input}
      </pre>
      {denying ? (
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
            placeholder="告诉它为什么（可不写）"
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
              允许这一次
            </button>
          )}
          <button
            type="button"
            disabled={busy}
            className="rounded-full bg-amber-500 px-3 py-1 font-medium text-white hover:bg-amber-600 disabled:opacity-50"
            title="这次唤起剩下的工具调用都不用再确认，唤起结束自动收回"
            onClick={() => void answer("full")}
          >
            {full ? "允许，这次唤起完整权限" : "这次唤起全部允许"}
          </button>
        </div>
      )}
    </div>
  )
}

export function PermitBar({ room }: { room: RoomSnapshot }) {
  const items = room.permits ?? []
  return (
    <Reveal open={items.length > 0} className="flex flex-col gap-2 pb-2">
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
  if (agent.agentName !== "claude" || !agent.runId) return null
  const on = Boolean(agent.fullAccess)
  return (
    <button
      type="button"
      disabled={busy}
      className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] disabled:opacity-50 ${
        on ? "bg-amber-500/15 text-amber-700 hover:bg-amber-500/25 dark:text-amber-300" : "text-muted-foreground hover:bg-muted"
      }`}
      title={on ? "收回：之后的工具调用又要你逐条确认" : "这次唤起剩下的工具调用都不用再确认，唤起结束自动收回"}
      onClick={async () => {
        setBusy(true)
        if (await post({ agentId: agent.id, full: !on })) toast.success(on ? `收回了 ${agent.name} 的完整权限` : `${agent.name} 这次唤起有完整权限了`)
        setBusy(false)
      }}
    >
      {on ? <ShieldCheck className="size-3" /> : <ShieldOff className="size-3" />}
      {on ? "完整权限中 · 收回" : "给完整权限"}
    </button>
  )
}
