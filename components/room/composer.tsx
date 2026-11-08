import { useMemo, useState } from "react"
import { Send, X } from "lucide-react"

import { Avatar, seatLook } from "@/components/room/bits"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { KINDS, kindOf } from "@/lib/kinds"
import { escapeRegExp, unknownMentions } from "@/lib/text"
import type { Message, PublicAgent } from "@/lib/types"

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
}: {
  agents: PublicAgent[]
  value: string
  reply: Message | null
  busy: boolean
  inputRef: React.RefObject<HTMLTextAreaElement | null>
  onChange: (value: string) => void
  onSend: () => void
  onClearReply: () => void
}) {
  const [picked, setPicked] = useState(false)
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
      className="px-4 pb-4 md:px-6"
      onSubmit={(event) => {
        event.preventDefault()
        onSend()
      }}
    >
      <div className="mx-auto max-w-3xl rounded-2xl border bg-card shadow-sm focus-within:border-ring/60 focus-within:ring-3 focus-within:ring-ring/15">
        {reply ? (
          <div className="flex items-center gap-2 border-b px-3 py-2 text-xs text-muted-foreground">
            <span className="min-w-0 flex-1 truncate">
              回复 <span className="font-medium text-foreground">{reply.authorName}</span>：{reply.text}
            </span>
            <button type="button" className="rounded p-0.5 hover:bg-muted" onClick={onClearReply} aria-label="取消回复">
              <X className="size-3.5" />
            </button>
          </div>
        ) : null}
        {matches.length > 0 && !picked ? (
          <div className="flex flex-wrap gap-1 border-b px-2 py-2">
            {matches.map((agent) => {
              const look = seatLook(agent)
              return (
                <button
                  key={agent.id}
                  type="button"
                  className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs hover:bg-muted"
                  onClick={() => insert(agent.name)}
                >
                  <Avatar name={agent.name} color={look.color} label={look.label} size="sm" />
                  <span className="font-medium">{agent.name}</span>
                  <span className="text-muted-foreground">{look.kind?.label ?? agent.role}</span>
                </button>
              )
            })}
          </div>
        ) : null}
        <Label htmlFor="composer" className="sr-only">
          发给房间
        </Label>
        <Textarea
          ref={inputRef}
          id="composer"
          value={value}
          placeholder="说点什么，@ 谁就唤起谁……"
          className="max-h-60 min-h-14 resize-none border-0 bg-transparent px-3.5 pt-3 shadow-none focus-visible:ring-0 dark:bg-transparent"
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
                  className={`flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition-colors ${
                    on ? "text-white" : "hover:bg-muted"
                  }`}
                  style={on ? { background: kind.color, borderColor: kind.color } : undefined}
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
                className={`shrink-0 rounded-full border px-2 py-0.5 text-xs ${
                  hasMention(value, "所有人") ? "bg-primary text-primary-foreground" : "hover:bg-muted"
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
          <Button type="submit" size="icon" disabled={busy || value.trim().length === 0} aria-label="发送">
            <Send />
          </Button>
        </div>
      </div>
      <p className="mx-auto mt-1.5 max-w-3xl px-1 text-[11px] text-muted-foreground">
        {unknown.length > 0
          ? `房间里还没有 ${unknown.map((name) => `@${name}`).join("、")}，这句不会叫醒谁`
          : "Enter 发送 · Shift+Enter 换行 · 消息里 @ 到的人会被唤起"}
      </p>
    </form>
  )
}
