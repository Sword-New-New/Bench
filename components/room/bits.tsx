import { splitMentions } from "@/lib/text"
import { STATUS_COLOR, STATUS_LABEL } from "@/lib/status"
import type { AgentStatus } from "@/lib/types"

export function Mark() {
  return (
    <span className="grid grid-cols-2 gap-0.5" aria-hidden="true">
      <span className="size-2 rounded-[2px] bg-foreground" />
      <span className="size-2 rounded-[2px] bg-[#0f7a55]" />
      <span className="size-2 rounded-[2px] bg-foreground/25" />
      <span className="size-2 rounded-[2px] bg-foreground/25" />
    </span>
  )
}

export function Lamp({ status }: { status: AgentStatus }) {
  const color = STATUS_COLOR[status]
  return (
    <span className="relative flex size-2.5 shrink-0" title={STATUS_LABEL[status]}>
      {status === "working" ? (
        <span
          className="absolute inline-flex size-full animate-ping rounded-full opacity-60"
          style={{ background: color }}
        />
      ) : null}
      <span className="relative inline-flex size-2.5 rounded-full" style={{ background: color }} />
    </span>
  )
}

export function MessageBody({
  text,
  names,
  tone = "ink",
}: {
  text: string
  names: string[]
  tone?: "ink" | "cream"
}) {
  const parts = splitMentions(text, names)
  const mentionClass =
    tone === "cream" ? "font-medium underline decoration-white/50 underline-offset-2" : "font-medium text-[#9a3412]"
  return (
    <p className="whitespace-pre-wrap text-sm leading-6">
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
