"use client"

import { useSyncExternalStore, type ReactNode } from "react"
import { ChevronDown, ChevronUp } from "lucide-react"

import { keepTopInView, type Fold } from "@/components/room/bits"
import { Markdown } from "@/components/room/markdown"
import { Reveal } from "@/components/room/reveal"
import { gistOf } from "@/lib/text"
import type { Message } from "@/lib/types"

// 「摘要」 档: an agent's reply shows one line, its conclusion, and opens in
// place to the full text on a click. Where the line comes from, in order:
//   1. Message.gist, stored with the message (the author's first line, or the
//      one a summary seat filled in; t_83c6fcc9);
//   2. gistOf(text), the same rules run here, for messages that have none;
//   3. the opening of the text, cleaned of markup, when the rules find none.
// Which messages never fold: the user's own, questions (message.ask), recalled
// ones, and replies short enough to be their own summary. Everything that is
// not a plain chat message (system lines, handoffs, cards) is drawn by other
// branches of the thread and never gets here.

const END = "【本轮结束】"

export type Summary = {
  text: string
  // The seat that wrote it when it was not the author.
  by?: string
  // Small things worth knowing about what is folded: 附 3 个, 约 1200 字.
  hints: string[]
}

// Which messages are open right now. Kept for as long as the page is, not
// stored: a reload folds everything again.
const opened = new Set<string>()
const listeners = new Set<() => void>()

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function setOpened(id: string, on: boolean) {
  if (opened.has(id) === on) return
  if (on) opened.add(id)
  else opened.delete(id)
  for (const listener of [...listeners]) listener()
}

// A jump to a message (search hit, a clicked id) opens it first.
export function expandMessage(id: string) {
  setOpened(id, true)
}

export function useOpened(id: string) {
  return useSyncExternalStore(
    subscribe,
    () => opened.has(id),
    () => false,
  )
}

function plain(text: string) {
  return text.replace(/\s+/g, " ").trim()
}

// The start of a reply with the markup taken off, for when no rule found a
// sentence: the first line that says something, cut at 80 characters.
function opening(body: string) {
  for (const raw of body.split("\n")) {
    const line = raw
      .replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.、)）]\s*|\|)/, "")
      .replace(/[*_`|]/g, "")
      .trim()
    if (!line || /^[-:\s]+$/.test(line)) continue
    return line.length > 80 ? `${line.slice(0, 80)}…` : line
  }
  return ""
}

function approx(count: number) {
  if (count < 1000) return Math.round(count / 10) * 10
  return Math.round(count / 100) * 100
}

export function summaryOf(message: Message): Summary | null {
  if (message.kind !== "chat" || message.authorId === "human" || message.recalled || message.ask) return null
  if (!message.text.trim()) return null
  const stored = message.gist
  const body = message.text.trim().startsWith(END) ? message.text.trim().slice(END.length).trim() : message.text.trim()
  const text = stored?.text?.trim() || gistOf(message.text) || opening(body)
  if (!text) return null
  const rest = plain(body) !== plain(text)
  const files = message.attachments?.length ?? 0
  // Nothing hidden behind it: draw the reply as it is.
  if (!rest && files === 0) return null
  const hints: string[] = []
  if (files > 0) hints.push(`附 ${files} 个`)
  if (message.taskId) hints.push(`待办 ${message.taskId.replace(/^t_/, "").slice(0, 4)}`)
  if (rest && body.length >= 200) hints.push(`约 ${approx(body.length)} 字`)
  const by = stored && stored.by && stored.by !== "author" ? stored.by : undefined
  if (by) hints.push(`摘要由 ${by} 补`)
  return { text, by, hints }
}

// What a row needs to draw a reply in the 「摘要」 档: the summary (null when
// this one is drawn whole, or in 「详细」), whether it is open, and how to
// flip it, keeping the top of the message in view as it does.
export function useSummary(message: Message, detail: boolean) {
  const open = useOpened(message.id)
  const info = detail ? null : summaryOf(message)
  return {
    info,
    open,
    folded: info !== null && !open,
    toggle: (node: HTMLElement | null) => {
      setOpened(message.id, !open)
      keepTopInView(node)
    },
  }
}

export type SummaryState = ReturnType<typeof useSummary>

// The Fold the full text is drawn with once it is open: no four-line cut.
const OPEN_FOLD: Fold = { attach: () => {}, open: true, long: false, toggle: () => {} }

export function openFold() {
  return OPEN_FOLD
}

// The bubble's content: the one line (a button), or the full text, with a
// height glide between the two.
export function SummaryLine({
  summary,
  names,
  from,
  open,
  onToggle,
  tone = "ink",
  children,
}: {
  summary: Summary
  names: string[]
  from: string
  open: boolean
  onToggle: () => void
  tone?: "ink" | "inverse"
  children: ReactNode
}) {
  return (
    <>
      <Reveal open={!open}>
        <button
          type="button"
          className="block w-full cursor-pointer rounded-md text-left outline-offset-4"
          aria-expanded={false}
          onClick={onToggle}
        >
          <div className="line-clamp-2 text-[0.9rem] leading-relaxed break-words">
            <Markdown text={summary.text} names={names} tone={tone} from={from} />
          </div>
          <span className="mt-1 flex flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground">
            <span className="flex items-center gap-0.5">
              <ChevronDown className="size-3" />
              展开
            </span>
            {summary.hints.map((hint) => (
              <span key={hint}>{hint}</span>
            ))}
          </span>
        </button>
      </Reveal>
      <Reveal open={open}>{children}</Reveal>
    </>
  )
}

// 「收起」 under an opened reply, where 「展开全文」 sits for a long one.
export function SummaryButton({ state, node }: { state: SummaryState; node: () => HTMLElement | null }) {
  if (!state.info || !state.open) return null
  return (
    <button
      type="button"
      className="flex items-center gap-1 rounded-md px-1 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
      aria-expanded
      onClick={() => state.toggle(node())}
    >
      <ChevronUp className="size-3" />
      收起
    </button>
  )
}
