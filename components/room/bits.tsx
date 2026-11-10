import { useEffect, useState } from "react"
import { ChevronDown, ChevronUp } from "lucide-react"

import { Bot, type BotMood } from "@/components/room/bot"
import { Markdown } from "@/components/room/markdown"
import { kindOf, type Kind } from "@/lib/kinds"
import { STATUS_COLOR, STATUS_LABEL } from "@/lib/status"
import type { AgentStatus } from "@/lib/types"

// The app's own icon (public/bench.svg, also the favicon and the launcher's).
export function Mark({ className = "size-7" }: { className?: string }) {
  // eslint-disable-next-line @next/next/no-img-element
  return <img src="/bench.svg" alt="" aria-hidden="true" className={`shrink-0 ${className}`} />
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
  mood,
}: {
  name: string
  color: string
  label?: string
  kind?: Kind | null
  size?: "sm" | "md" | "lg"
  status?: AgentStatus
  hover?: boolean
  watch?: boolean
  // Only for bots (kind set): a face instead of status, see Bot.
  mood?: BotMood
}) {
  if (kind) {
    return <Bot shape={kind.shape} color={kind.color} size={BOT_SIZE[size]} status={status} hover={hover} watch={watch ?? hover} mood={mood} />
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

// Long messages fold to four lines. The state lives with the message, so its
// 「展开全文 / 收起」 sits in the row of 「查看过程」 and 「回复」 under it:
// one place and one look, folded or open.
export type Fold = ReturnType<typeof useFold>

export function useFold(text: string) {
  // Whether it overflows is measured while folded, and again whenever the
  // bubble's width changes. The paragraph comes in through a callback ref.
  const [node, attach] = useState<HTMLElement | null>(null)
  const [open, setOpen] = useState(false)
  const [long, setLong] = useState(false)
  useEffect(() => {
    if (!node || open) return
    const measure = () => setLong(node.scrollHeight > node.clientHeight + 1)
    // The observer reports the first size by itself once laid out; measuring
    // here as well forced a layout per message while a room was drawn.
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [node, open, text])
  const toggle = () => {
    setOpen(!open)
    keepTopInView(node)
  }
  return { attach, open, long, toggle }
}

export function FoldButton({ fold }: { fold: Fold }) {
  if (!fold.long) return null
  return (
    <button
      type="button"
      className="flex items-center gap-1 rounded-md px-1 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
      aria-expanded={fold.open}
      onClick={fold.toggle}
    >
      {fold.open ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
      {fold.open ? "收起" : "展开全文"}
    </button>
  )
}

export function MessageBody({
  text,
  names,
  tone = "ink",
  fold: given,
  from,
}: {
  text: string
  names: string[]
  tone?: "ink" | "inverse"
  // Who wrote it (a seat id or "human"): relative file paths are looked up in their folder.
  from?: string
  // Given, the caller shows its FoldButton; otherwise it goes right under the text.
  fold?: Fold
}) {
  const own = useFold(text)
  const { attach, open, long } = given ?? own
  return (
    <>
      {/* Folded to four lines by height, so a code box or a table inside folds too. */}
      <div
        ref={attach}
        className={`text-[0.9rem] leading-relaxed break-words ${
          open ? "" : `max-h-[4lh] overflow-hidden ${long ? "[mask-image:linear-gradient(to_bottom,black_55%,transparent)]" : ""}`
        }`}
      >
        <Markdown text={text} names={names} tone={tone} from={from} />
      </div>
      {given ? null : (
        <div className="-ml-1">
          <FoldButton fold={own} />
        </div>
      )}
    </>
  )
}

