import { Bot, BOT_SHAPE } from "@/components/room/bot"
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
    return <Bot shape={BOT_SHAPE[kind.id]} color={kind.color} size={BOT_SIZE[size]} status={status} hover={hover} watch={watch ?? hover} />
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
  return (
    <p className="text-[0.9rem] leading-relaxed break-words whitespace-pre-wrap">
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
  )
}
