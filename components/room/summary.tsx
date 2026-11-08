import { useEffect, useState } from "react"
import { NotebookPen, X } from "lucide-react"

import { Avatar, seatLook } from "@/components/room/bits"
import { Reveal } from "@/components/room/reveal"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { clock } from "@/lib/status"
import type { PublicAgent, RoomSnapshot } from "@/lib/types"

const SNOOZE_KEY = "bench-summary-snooze"
const SNOOZE_MS = 30 * 60_000
const SNOOZE_EVENT = "bench-summary-snooze"

export function clearSummarySnooze() {
  try {
    localStorage.removeItem(SNOOZE_KEY)
  } catch {}
  window.dispatchEvent(new Event(SNOOZE_EVENT))
}

function snoozedUntil() {
  try {
    return Number(localStorage.getItem(SNOOZE_KEY)) || 0
  } catch {
    return 0
  }
}

// Shown over the composer once a summary is due: pick who writes it, put it
// off for a while, or skip this stretch of talk.
export function SummaryNudge({
  room,
  busy,
  onRequest,
  onSkip,
}: {
  room: RoomSnapshot
  busy: boolean
  onRequest: (agent: PublicAgent) => void
  onSkip: () => void
}) {
  const [until, setUntil] = useState(0)
  const [now, setNow] = useState(0)
  // Read the clock and the snooze after mount, so the server render matches.
  useEffect(() => {
    const tick = () => {
      setUntil(snoozedUntil())
      setNow(Date.now())
    }
    const first = window.setTimeout(tick, 0)
    const timer = window.setInterval(tick, 60_000)
    window.addEventListener(SNOOZE_EVENT, tick)
    return () => {
      window.clearTimeout(first)
      window.clearInterval(timer)
      window.removeEventListener(SNOOZE_EVENT, tick)
    }
  }, [])

  const writer = room.summaryWriter ? room.agents.find((agent) => agent.id === room.summaryWriter) : undefined
  const due = room.summaryDue && now > 0 && now >= until
  const writers = room.agents.filter((agent) => agent.callable && !agent.demo)
  const { count, chars } = room.sinceSummary
  const snooze = () => {
    const next = Date.now() + SNOOZE_MS
    try {
      localStorage.setItem(SNOOZE_KEY, String(next))
    } catch {}
    setUntil(next)
  }

  return (
    <Reveal open={Boolean(writer) || due} className="pb-2">
      {writer ? (
        <div className="pill flex items-center gap-2 rounded-2xl px-3 py-2 text-xs text-muted-foreground">
          <NotebookPen className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">
            <span className="font-medium text-foreground">{writer.name}</span> 正在写房间摘要…
          </span>
        </div>
      ) : due ? (
        <div className="pill rounded-2xl px-3 py-2 text-xs">
          <div className="flex items-center gap-2">
            <NotebookPen className="size-3.5 shrink-0 text-muted-foreground" />
            <p className="min-w-0 flex-1 leading-5">
              {room.summary ? "上次摘要之后" : "到现在"}已经聊了 {count} 条（约 {Math.round(chars / 1000)} 千字），超出一次唤起能带的量了。找谁写一份摘要？
            </p>
            <button
              type="button"
              className="rounded p-0.5 text-muted-foreground hover:bg-muted"
              onClick={snooze}
              aria-label="稍后提醒"
            >
              <X className="size-3.5" />
            </button>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-1.5 pl-5.5">
            {writers.map((agent) => {
              const look = seatLook(agent)
              return (
                <button
                  key={agent.id}
                  type="button"
                  className="pill chip flex h-7 shrink-0 items-center gap-1.5 rounded-full pr-2.5 pl-0.5 text-xs font-medium disabled:opacity-50"
                  disabled={busy}
                  onClick={() => onRequest(agent)}
                >
                  <Avatar name={agent.name} color={look.color} label={look.label} kind={look.kind} size="sm" />
                  {agent.name}
                </button>
              )
            })}
            {writers.length === 0 ? <span className="text-muted-foreground">没有能唤起的席位</span> : null}
            <span className="ml-auto flex shrink-0 gap-0.5">
              <Button type="button" size="xs" variant="ghost" disabled={busy} onClick={snooze}>
                稍后
              </Button>
              <Button type="button" size="xs" variant="ghost" disabled={busy} onClick={onSkip}>
                这段不用
              </Button>
            </span>
          </div>
        </div>
      ) : null}
    </Reveal>
  )
}

// The room summary at the top of the side panel: read it, or fix it by hand.
export function SummaryCard({
  room,
  busy,
  onSave,
}: {
  room: RoomSnapshot
  busy: boolean
  onSave: (text: string) => Promise<boolean>
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const summary = room.summary

  if (draft !== null) {
    return (
      <section className="note mx-3 mb-5 space-y-2 p-2.5" data-tone="blue">
        <Textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          className="min-h-48 border-0 bg-white/40 text-xs leading-5 dark:bg-black/15"
          aria-label="房间摘要"
          autoFocus
        />
        <div className="flex justify-end gap-1">
          <Button type="button" size="xs" variant="ghost" onClick={() => setDraft(null)}>
            取消
          </Button>
          <Button
            type="button"
            size="xs"
            disabled={busy || !draft.trim()}
            onClick={async () => {
              if (await onSave(draft)) setDraft(null)
            }}
          >
            保存
          </Button>
        </div>
      </section>
    )
  }

  return (
    <details className="note group mx-3 mb-5 px-3 py-2.5" data-tone="blue" data-tilt="b">
      <summary className="flex cursor-pointer items-center gap-2 text-xs">
        <NotebookPen className="size-3.5 opacity-70" />
        <span className="font-medium">房间摘要</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          {summary ? `${summary.by} · ${clock(summary.at)}` : "还没有"}
          {room.sinceSummary.count > 0 ? ` · 之后又聊了 ${room.sinceSummary.count} 条` : ""}
        </span>
      </summary>
      <div className="mt-2 space-y-1 text-xs leading-5">
        {summary ? (
          summary.text.split("\n").map((line, index) =>
            line.startsWith("#") ? (
              <p key={index} className="pt-1 font-semibold">
                {line.replace(/^#+\s*/, "")}
              </p>
            ) : line.trim() ? (
              <p key={index} className="text-muted-foreground">
                {line}
              </p>
            ) : null,
          )
        ) : (
          <p className="text-muted-foreground">聊到一次唤起带不下的量时，房间会提醒你找人写。也可以自己先写一份。</p>
        )}
        <div className="flex justify-end pt-1">
          <Button type="button" size="xs" variant="ghost" onClick={() => setDraft(summary?.text ?? "## 结论\n\n## 进行中\n\n## 待定\n")}>
            {summary ? "修改" : "自己写"}
          </Button>
        </div>
      </div>
    </details>
  )
}
