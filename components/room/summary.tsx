import { useEffect, useRef, useState } from "react"
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
// The debug menu plays the "summary written" animation without a real summary.
export const SUMMARY_DONE_DEMO = "bench-summary-done-demo"
const DOTS = ["#059669", "#10b981", "#34d399", "#6ee7b7", "#a7f3d0"]

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

// The check breaks into green dots that fly to the room summary in the side
// panel; the first to land makes the card glow. With the panel hidden they
// just scatter and fade.
function burst(from: HTMLElement) {
  const start = from.getBoundingClientRect()
  const x0 = start.left + start.width / 2
  const y0 = start.top + start.height / 2
  const target = document.querySelector<HTMLElement>("[data-summary-card]")
  const end = target?.getBoundingClientRect()
  const landing = target && end && end.width > 0 && end.height > 0 ? { target, end } : null
  const layer = document.createElement("div")
  layer.className = "pointer-events-none fixed inset-0 z-[90]"
  document.body.appendChild(layer)
  let glowed = false
  const count = 24
  for (let index = 0; index < count; index++) {
    const dot = document.createElement("span")
    const size = 4 + Math.random() * 5
    Object.assign(dot.style, {
      position: "absolute",
      left: `${x0 - size / 2}px`,
      top: `${y0 - size / 2}px`,
      width: `${size}px`,
      height: `${size}px`,
      borderRadius: "9999px",
      background: DOTS[index % DOTS.length],
      boxShadow: "0 0 6px rgba(16,185,129,.6)",
    })
    layer.appendChild(dot)
    const angle = (index / count) * Math.PI * 2 + Math.random() * 0.4
    const spread = 28 + Math.random() * 36
    const sx = Math.cos(angle) * spread
    const sy = Math.sin(angle) * spread
    const keyframes: Keyframe[] = [
      { transform: "translate(0, 0) scale(.3)", opacity: 0 },
      { transform: `translate(${sx}px, ${sy}px) scale(1.2)`, opacity: 1, offset: 0.22 },
    ]
    if (landing) {
      const tx = landing.end.left + 16 + Math.random() * Math.max(landing.end.width - 32, 8) - x0
      const ty = landing.end.top + 10 + Math.random() * Math.min(landing.end.height - 20, 24) - y0
      // Up over the page in an arc, then down into the card.
      keyframes.push(
        { transform: `translate(${(sx + tx) / 2}px, ${Math.min(sy, ty) - 70 - Math.random() * 50}px) scale(.9)`, opacity: 1, offset: 0.6 },
        { transform: `translate(${tx}px, ${ty}px) scale(.5)`, opacity: 0.9, offset: 0.94 },
        { transform: `translate(${tx}px, ${ty}px) scale(0)`, opacity: 0 },
      )
    } else {
      keyframes.push({ transform: `translate(${sx * 2.4}px, ${sy * 2.4 - 30}px) scale(0)`, opacity: 0 })
    }
    const flight = dot.animate(keyframes, {
      duration: landing ? 1000 + Math.random() * 350 : 700 + Math.random() * 200,
      delay: index * 14,
      easing: "cubic-bezier(.45,0,.25,1)",
      fill: "forwards",
    })
    flight.onfinish = () => {
      dot.remove()
      if (!landing || glowed) return
      glowed = true
      landing.target.animate(
        [
          { boxShadow: "0 0 0 0 rgba(16,185,129,0)", scale: "1" },
          { boxShadow: "0 0 0 3px rgba(16,185,129,.55), 0 0 28px rgba(16,185,129,.45)", scale: "1.03", offset: 0.3 },
          { boxShadow: "0 0 0 0 rgba(16,185,129,0)", scale: "1" },
        ],
        { duration: 1100, easing: "ease-out" },
      )
    }
  }
  window.setTimeout(() => layer.remove(), 2500)
}

// A summary just landed: the spinner turns into a green check, which then
// bursts toward the room summary.
function SummaryDone({ name, onEnd }: { name: string; onEnd: () => void }) {
  const check = useRef<HTMLSpanElement>(null)
  const end = useRef(onEnd)
  useEffect(() => {
    end.current = onEnd
  })
  useEffect(() => {
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    const fly = window.setTimeout(() => {
      if (!still && check.current) burst(check.current)
    }, 750)
    const close = window.setTimeout(() => end.current(), still ? 1600 : 2300)
    return () => {
      window.clearTimeout(fly)
      window.clearTimeout(close)
    }
  }, [])
  return (
    <div className="pill flex items-center gap-2 rounded-2xl px-3 py-2 text-xs ring-1 ring-emerald-500/40">
      <span ref={check} className="summary-check grid size-5 shrink-0 place-items-center rounded-full bg-emerald-500 text-white">
        <svg viewBox="0 0 16 16" className="size-3" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3.5 8.5l3 3 6-7" />
        </svg>
      </span>
      <span className="min-w-0 flex-1 truncate">
        <span className="font-medium">{name}</span>
        <span className="text-emerald-700 dark:text-emerald-400"> 写好了房间摘要</span>
      </span>
    </div>
  )
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
  // A summary saved while a seat was on the job is one it wrote; the job ends
  // just after the save, so either snapshot may still name the writer.
  const at = room.summary?.at ?? 0
  const [seen, setSeen] = useState({ project: room.project.id, at, writer: room.summaryWriter })
  const [done, setDone] = useState<{ name: string; round: number } | null>(null)
  if (seen.project !== room.project.id || seen.at !== at || seen.writer !== room.summaryWriter) {
    const by = room.summaryWriter ?? seen.writer
    if (seen.project === room.project.id && at > seen.at && by) {
      const name = room.agents.find((agent) => agent.id === by)?.name ?? room.summary?.by ?? ""
      setDone({ name, round: (done?.round ?? 0) + 1 })
    }
    setSeen({ project: room.project.id, at, writer: room.summaryWriter })
  }
  const demoName = room.agents.find((agent) => agent.callable && !agent.demo)?.name ?? room.agents[0]?.name ?? "某个席位"
  useEffect(() => {
    const play = () => setDone((last) => ({ name: demoName, round: (last?.round ?? 0) + 1 }))
    window.addEventListener(SUMMARY_DONE_DEMO, play)
    return () => window.removeEventListener(SUMMARY_DONE_DEMO, play)
  }, [demoName])
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
    <Reveal open={Boolean(done) || Boolean(writer) || due} className="pb-2">
      {done ? (
        <SummaryDone key={done.round} name={done.name} onEnd={() => setDone(null)} />
      ) : writer ? (
        <div className="summary-writing pill flex items-center gap-2 rounded-2xl px-3 py-2 text-xs text-muted-foreground ring-1 ring-emerald-500/25">
          <span className="relative grid size-5 shrink-0 place-items-center">
            <span className="absolute inset-0 animate-spin rounded-full border-2 border-emerald-500/20 border-t-emerald-500 motion-reduce:animate-none" />
            <NotebookPen className="size-2.5 text-emerald-600 dark:text-emerald-400" />
          </span>
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
      <section className="note mx-3 mb-5 space-y-2 p-2.5" data-tone="blue" data-summary-card>
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
    <details className="note group mx-3 mb-5 px-3 py-2.5" data-tone="blue" data-tilt="b" data-summary-card>
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
