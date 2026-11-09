import { useEffect, useRef, useState } from "react"

import { Bot } from "@/components/room/bot"
import { kindOf, type Kind } from "@/lib/kinds"
import { splitMentions } from "@/lib/text"
import { STATUS_COLOR, STATUS_LABEL } from "@/lib/status"
import type { AgentStatus } from "@/lib/types"

export function Mark({ className = "size-7" }: { className?: string }) {
  return (
    <span
      className={`grid shrink-0 grid-cols-2 gap-[3px] rounded-lg bg-primary p-[6px] ${className}`}
      aria-hidden="true"
    >
      <span className="rounded-[2px] bg-[#d97757]" />
      <span className="rounded-[2px] bg-[#4d6bfe]" />
      <span className="rounded-[2px] bg-[#10a37f]" />
      <span className="rounded-[2px] bg-[#7c6cf0]" />
    </span>
  )
}

export function Lamp({ status }: { status: AgentStatus }) {
  const color = STATUS_COLOR[status]
  return (
    <span className="relative flex size-2 shrink-0" title={STATUS_LABEL[status]}>
      {status === "working" ? (
        <span
          className="absolute inline-flex size-full animate-ping rounded-full opacity-60"
          style={{ background: color }}
        />
      ) : null}
      <span className="relative inline-flex size-2 rounded-full" style={{ background: color }} />
    </span>
  )
}

const BOT_SIZE = { sm: 24, md: 32, lg: 36 }

// One of the five kinds is drawn as its animated character, which shows the
// status itself. Anyone else gets a colored tile with their first letter.
export function Avatar({
  name,
  color,
  label,
  kind,
  size = "md",
  status,
  hover,
  watch,
}: {
  name: string
  color: string
  label?: string
  kind?: Kind | null
  size?: "sm" | "md" | "lg"
  status?: AgentStatus
  hover?: boolean
  watch?: boolean
}) {
  if (kind) {
    return <Bot shape={kind.shape} color={kind.color} size={BOT_SIZE[size]} status={status} hover={hover} watch={watch ?? hover} />
  }
  const glyph = (label || name).slice(0, 1).toUpperCase()
  const box = size === "lg" ? "size-9 text-sm" : size === "sm" ? "size-6 text-[11px]" : "size-8 text-xs"
  return (
    <span className="relative shrink-0">
      <span
        className={`grid place-items-center rounded-lg font-semibold text-white ${box}`}
        style={{ background: color }}
        aria-hidden="true"
      >
        {glyph}
      </span>
      {status ? (
        <span className="absolute -right-0.5 -bottom-0.5 rounded-full bg-background p-[2px]">
          <Lamp status={status} />
        </span>
      ) : null}
    </span>
  )
}

export function seatLook(agent: { name: string; color: string; agentName?: string; model?: string; demo?: boolean }) {
  const kind = kindOf(agent)
  return { kind, color: kind?.color ?? agent.color, label: kind?.label }
}

// The thread sticks to its bottom as it grows, which pushes the head of
// something just opened out of sight. Once that has happened (next frames,
// and again when a Reveal has finished growing), bring its top back into view.
export function keepTopInView(node: HTMLElement | null) {
  const pull = () => {
    let box = node?.parentElement ?? null
    while (box && !/auto|scroll/.test(getComputedStyle(box).overflowY)) box = box.parentElement
    if (!node || !box) return
    const above = node.getBoundingClientRect().top - box.getBoundingClientRect().top - 40
    if (above < 0) box.scrollTop += above
  }
  requestAnimationFrame(() => requestAnimationFrame(pull))
  window.setTimeout(pull, 350)
}

export function MessageBody({
  text,
  names,
  tone = "ink",
}: {
  text: string
  names: string[]
  tone?: "ink" | "inverse"
}) {
  const parts = splitMentions(text, names)
  const mentionClass =
    tone === "inverse"
      ? "rounded px-0.5 font-medium bg-white/18"
      : "rounded px-0.5 font-medium text-mention bg-mention/10"
  // Long answers fill the whole thread, so anything past four lines folds
  // until it's opened. Whether it overflows is measured while folded, and
  // again whenever the bubble's width changes.
  const ref = useRef<HTMLParagraphElement>(null)
  const [open, setOpen] = useState(false)
  const [long, setLong] = useState(false)
  useEffect(() => {
    const body = ref.current
    if (!body || open) return
    const measure = () => setLong(body.scrollHeight > body.clientHeight + 1)
    const observer = new ResizeObserver(measure)
    observer.observe(body)
    measure()
    return () => observer.disconnect()
  }, [open, text])
  return (
    <>
      <p
        ref={ref}
        className={`text-[0.9rem] leading-relaxed break-words whitespace-pre-wrap ${open ? "" : "line-clamp-4"}`}
      >
        {parts.map((part, index) =>
          part.mention ? (
            <span key={`${part.text}-${index}`} className={mentionClass}>
              {part.text}
            </span>
          ) : (
            <span key={`${index}-${part.text.slice(0, 12)}`}>{part.text}</span>
          ),
        )}
      </p>
      {long ? (
        <button
          type="button"
          className={`mt-0.5 text-xs font-medium underline-offset-2 hover:underline ${
            tone === "inverse" ? "text-white/90" : "text-muted-foreground"
          }`}
          aria-expanded={open}
          onClick={() => {
            setOpen(!open)
            keepTopInView(ref.current)
          }}
        >
          {open ? "收起" : "展开全文"}
        </button>
      ) : null}
    </>
  )
}
