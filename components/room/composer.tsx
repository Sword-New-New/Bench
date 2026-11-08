import { useMemo, useState } from "react"

import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { unknownMentions } from "@/lib/text"
import type { Message, PublicAgent } from "@/lib/types"

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
      : agents.filter((agent) => agent.name.includes(query)).slice(0, 6)
  const unknown = unknownMentions(
    value,
    agents.map((agent) => agent.name),
  )

  function insert(name: string) {
    onChange(value.replace(/@([\p{L}\p{N}_-]*)$/u, `@${name} `))
    setPicked(true)
    inputRef.current?.focus()
  }

  return (
    <form
      className="border-t px-4 py-3"
      onSubmit={(event) => {
        event.preventDefault()
        onSend()
      }}
    >
      {reply ? (
        <div className="mb-2 flex items-center justify-between gap-2 rounded-lg bg-muted px-2 py-1.5 text-xs">
          <span className="truncate">
            回复 {reply.authorName}：{reply.text}
          </span>
          <button type="button" className="shrink-0 underline-offset-2 hover:underline" onClick={onClearReply}>
            取消
          </button>
        </div>
      ) : null}
      {matches.length > 0 && !picked ? (
        <div className="mb-2 flex flex-wrap gap-1">
          {matches.map((agent) => (
            <Button
              key={agent.id}
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => insert(agent.name)}
            >
              @{agent.name}
              <span className="text-muted-foreground">{agent.role}</span>
            </Button>
          ))}
        </div>
      ) : null}
      <Label htmlFor="composer" className="sr-only">
        发给房间
      </Label>
      <Textarea
        ref={inputRef}
        id="composer"
        value={value}
        placeholder="说一件需要一起做的事，用 @名字 点名"
        className="min-h-16 bg-card"
        onChange={(event) => {
          setPicked(false)
          onChange(event.target.value)
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault()
            if (matches.length > 0 && !picked) {
              insert(matches[0].name)
              return
            }
            onSend()
          }
        }}
      />
      <div className="mt-2 flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          {unknown.length > 0
            ? `房间里还没有 ${unknown.map((name) => `@${name}`).join("、")}`
            : "Enter 发送 · Shift+Enter 换行"}
        </p>
        <Button type="submit" disabled={busy || value.trim().length === 0}>
          发送
        </Button>
      </div>
    </form>
  )
}
