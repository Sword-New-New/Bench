import { useEffect, useMemo, useRef, useState } from "react"
import { Send, X } from "lucide-react"

import { Avatar, seatLook } from "@/components/room/bits"
import { Reveal } from "@/components/room/reveal"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { KINDS, kindOf } from "@/lib/kinds"
import { escapeRegExp, unknownMentions } from "@/lib/text"
import type { Message, PublicAgent } from "@/lib/types"

export const DOCK_EVENT = "bench-dock"

function hasMention(text: string, name: string) {
  return new RegExp(`@${escapeRegExp(name)}(?![\\p{L}\\p{N}_-])`, "u").test(text)
}

function toggleMention(text: string, name: string) {
  if (hasMention(text, name)) {
    return text
      .replace(new RegExp(`@${escapeRegExp(name)}(?![\\p{L}\\p{N}_-])\\s?`, "u"), "")
      .replace(/^\s+/, "")
  }
  return `@${name} ${text}`
}

export function Composer({
  agents,
  value,
  reply,
  busy,
  inputRef,
  onChange,
  onSend,
  onClearReply,
  notice,
}: {
  agents: PublicAgent[]
  value: string
  reply: Message | null
  busy: boolean
  inputRef: React.RefObject<HTMLTextAreaElement | null>
  onChange: (value: string) => void
  onSend: () => void
  onClearReply: () => void
  // Shown just above the input, such as the summary reminder.
  notice?: React.ReactNode
}) {
  const [picked, setPicked] = useState(false)
  const formRef = useRef<HTMLFormElement>(null)

  // The composer floats over the thread; tell the thread how much room to
  // leave. Panels open with an animation, so this fires every frame while they
  // move, and the thread keeps its last message in view in the same frame.
  useEffect(() => {
    const form = formRef.current
    const host = form?.parentElement
    if (!form || !host) return
    const observer = new ResizeObserver(() => {
      host.style.setProperty("--dock", `${form.offsetHeight}px`)
      host.dispatchEvent(new Event(DOCK_EVENT))
    })
    observer.observe(form)
    return () => observer.disconnect()
  }, [])
  const query = useMemo(() => {
    const match = value.match(/@([\p{L}\p{N}_-]*)$/u)
    return match ? match[1] : null
  }, [value])
  const exact = query !== null && agents.some((agent) => agent.name === query)
  const matches =
    query === null || exact
      ? []
      : agents.filter((agent) => agent.name.toLowerCase().includes(query.toLowerCase())).slice(0, 6)
  const unknown = unknownMentions(
    value,
    agents.map((agent) => agent.name),
  )

  // One quick target per kind: the seat that is online, else the one that can be woken.
  const targets = KINDS.flatMap((kind) => {
    const seats = agents.filter((agent) => kindOf(agent)?.id === kind.id)
    const seat =
      seats.find((agent) => agent.status !== "offline") ?? seats.find((agent) => agent.callable) ?? seats[0]
    return seat ? [{ kind, seat }] : []
  })

  function insert(name: string) {
    onChange(value.replace(/@([\p{L}\p{N}_-]*)$/u, `@${name} `))
    setPicked(true)
    inputRef.current?.focus()
  }

  return (
    <form
      ref={formRef}
      className="absolute inset-x-0 bottom-0 z-10 px-3 pb-3 md:px-6"
      onSubmit={(event) => {
        event.preventDefault()
        onSend()
      }}
    >
      {notice ? <div className="mx-auto max-w-3xl">{notice}</div> : null}
      <div
        className="raised mx-auto max-w-3xl rounded-[22px] transition-shadow focus-within:ring-3 focus-within:ring-ring/20"
      >
        <Reveal open={reply !== null}>
          {reply ? (
            <div className="flex items-center gap-2 border-b border-foreground/8 px-3.5 py-2 text-xs text-muted-foreground">
              <span className="min-w-0 flex-1 truncate">
                回复 <span className="font-medium text-foreground">{reply.authorName}</span>：{reply.text}
              </span>
              <button type="button" className="rounded p-0.5 hover:bg-muted" onClick={onClearReply} aria-label="取消回复">
                <X className="size-3.5" />
              </button>
            </div>
          ) : null}
        </Reveal>
        <Reveal open={matches.length > 0 && !picked}>
          <div className="flex flex-wrap gap-1 border-b border-foreground/8 px-2 py-2">
            {matches.map((agent) => {
              const look = seatLook(agent)
              return (
                <button
                  key={agent.id}
                  type="button"
                  className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs hover:bg-foreground/6"
                  onClick={() => insert(agent.name)}
                >
                  <Avatar name={agent.name} color={look.color} label={look.label} kind={look.kind} size="sm" />
                  <span className="font-medium">{agent.name}</span>
                  <span className="text-muted-foreground">{look.kind?.label ?? agent.role}</span>
                </button>
              )
            })}
          </div>
        </Reveal>
        <Label htmlFor="composer" className="sr-only">
          发给房间
        </Label>
        <Textarea
          ref={inputRef}
          id="composer"
          value={value}
          placeholder="说点什么，@ 谁就唤起谁 · Enter 发送，Shift+Enter 换行"
          className="max-h-60 min-h-14 resize-none border-0 bg-transparent px-4 pt-3.5 shadow-none placeholder:text-foreground/45 focus-visible:ring-0 dark:bg-transparent"
          onChange={(event) => {
            setPicked(false)
            onChange(event.target.value)
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              if (matches.length > 0 && !picked) {
                insert(matches[0].name)
                return
              }
              onSend()
            }
          }}
        />
        <div className="flex items-center gap-2 px-2 pb-2">
          <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
            <span className="shrink-0 px-1 text-xs text-muted-foreground">发给</span>
            {targets.map(({ kind, seat }) => {
              const on = hasMention(value, seat.name)
              return (
                <button
                  key={kind.id}
                  type="button"
                  title={`@${seat.name}`}
                  className={`flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-xs transition-[background,box-shadow,color] ${
                    on ? "text-white" : "pill hover:brightness-105"
                  }`}
                  style={
                    on
                      ? {
                          background: `linear-gradient(160deg, color-mix(in oklch, ${kind.color} 80%, white), ${kind.color})`,
                          boxShadow: `inset 0 1px 0 0 rgb(255 255 255 / .45), 0 4px 12px -4px ${kind.color}`,
                        }
                      : undefined
                  }
                  onClick={() => {
                    onChange(toggleMention(value, seat.name))
                    inputRef.current?.focus()
                  }}
                >
                  <span className="size-1.5 rounded-full" style={{ background: on ? "white" : kind.color }} />
                  {kind.label}
                </button>
              )
            })}
            {agents.length > 1 ? (
              <button
                type="button"
                className={`shrink-0 rounded-full px-2.5 py-1 text-xs ${
                  hasMention(value, "所有人") ? "bg-primary text-primary-foreground" : "pill hover:brightness-105"
                }`}
                onClick={() => {
                  onChange(toggleMention(value, "所有人"))
                  inputRef.current?.focus()
                }}
              >
                所有人
              </button>
            ) : null}
            {targets.length === 0 && agents.length <= 1 ? (
              <span className="truncate text-xs text-muted-foreground">还没有 AI 入座 · Enter 发送</span>
            ) : null}
          </div>
          <Button
            type="submit"
            size="icon"
            className="rounded-full shadow-[inset_0_1px_0_0_rgb(255_255_255/0.25)]"
            disabled={busy || value.trim().length === 0}
            aria-label="发送"
          >
            <Send />
          </Button>
        </div>
      </div>
      <Reveal open={unknown.length > 0}>
        <p className="pill mx-auto mt-1.5 w-fit max-w-3xl rounded-full px-3 py-0.5 text-[11px] text-amber-700 dark:text-amber-300">
          房间里还没有 {unknown.map((name) => `@${name}`).join("、")}，这句不会叫醒谁
        </p>
      </Reveal>
    </form>
  )
}
