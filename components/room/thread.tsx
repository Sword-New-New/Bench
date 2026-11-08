import { useEffect, useRef } from "react"

import { Button } from "@/components/ui/button"
import { MessageBody } from "@/components/room/bits"
import { clock } from "@/lib/status"
import type { Message } from "@/lib/types"

const EXAMPLES = [
  "做一版定价页，手机上要能扫，做完看一遍边界",
  "谁现在有空，各自擅长什么",
  "@阿证 看一下登录失败时有没有人负责说明",
]

export function Thread({
  messages,
  names,
  focusName,
  onClearFocus,
  onReply,
  onOpenTask,
  onExample,
}: {
  messages: Message[]
  names: string[]
  focusName: string | null
  onClearFocus: () => void
  onReply: (message: Message) => void
  onOpenTask: (taskId: string) => void
  onExample: (text: string) => void
}) {
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const talked = messages.some((message) => message.kind !== "system")

  useEffect(() => {
    if (!stick.current) return
    const node = scroller.current
    if (!node) return
    node.scrollTop = node.scrollHeight
  }, [messages])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between px-4 py-3">
        <h2 className="text-sm font-medium">群聊</h2>
        {focusName ? (
          <button
            type="button"
            className="text-xs text-muted-foreground underline-offset-2 hover:underline"
            onClick={onClearFocus}
          >
            只看 {focusName} · 清除
          </button>
        ) : (
          <span className="text-xs text-muted-foreground">写下来，别人就能看见</span>
        )}
      </div>
      <div
        ref={scroller}
        className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 pb-4"
        onScroll={(event) => {
          const node = event.currentTarget
          stick.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80
        }}
        aria-live="polite"
      >
        {messages.length === 0 ? (
          <div className="rounded-xl border border-dashed px-4 py-5 text-sm leading-6 text-muted-foreground">
            群里还没人说话。你先丢一件事进来，或让某个 agent 用接入说明入座。
          </div>
        ) : null}
        {messages.map((message) => (
          <MessageRow
            key={message.id}
            message={message}
            messages={messages}
            names={names}
            onReply={onReply}
            onOpenTask={onOpenTask}
          />
        ))}
        {!talked ? (
          <div className="space-y-2 pt-2">
            <p className="text-xs text-muted-foreground">可以先丢一句：</p>
            <div className="flex flex-col gap-2">
              {EXAMPLES.map((example) => (
                <Button
                  key={example}
                  type="button"
                  variant="outline"
                  className="h-auto justify-start px-3 py-2 text-left whitespace-normal"
                  onClick={() => onExample(example)}
                >
                  {example}
                </Button>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}

function MessageRow({
  message,
  messages,
  names,
  onReply,
  onOpenTask,
}: {
  message: Message
  messages: Message[]
  names: string[]
  onReply: (message: Message) => void
  onOpenTask: (taskId: string) => void
}) {
  if (message.kind === "system") {
    return (
      <p className="py-1 text-center text-xs leading-5 text-muted-foreground">{message.text}</p>
    )
  }

  if (message.kind === "handoff" && message.handoff) {
    const handoff = message.handoff
    return (
      <article className="rounded-xl border bg-card px-3 py-3">
        <p className="text-xs tracking-wide text-muted-foreground">交接</p>
        <p className="mt-1 text-sm">
          <span className="font-medium" style={{ color: message.authorColor }}>
            {handoff.fromName}
          </span>
          <span className="text-muted-foreground"> 交给 </span>
          <span className="font-medium">{handoff.toName}</span>
        </p>
        {message.taskId ? (
          <button
            type="button"
            className="mt-2 text-left text-sm font-medium underline-offset-2 hover:underline"
            onClick={() => onOpenTask(message.taskId!)}
          >
            {handoff.taskTitle}
          </button>
        ) : (
          <p className="mt-2 text-sm font-medium">{handoff.taskTitle}</p>
        )}
        <div className="mt-2">
          <MessageBody text={message.text} names={names} />
        </div>
        <p className="mt-2 text-xs text-muted-foreground">{clock(message.createdAt)}</p>
      </article>
    )
  }

  const mine = message.authorId === "human"
  const reply = message.replyTo
    ? messages.find((item) => item.id === message.replyTo)
    : undefined

  return (
    <article className={`flex ${mine ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[min(100%,40rem)] rounded-2xl px-3 py-2.5 ${
          mine ? "bg-primary text-primary-foreground" : "border bg-card"
        }`}
        style={mine ? undefined : { borderLeftWidth: 3, borderLeftColor: message.authorColor }}
      >
        <div className="mb-1 flex flex-wrap items-baseline gap-x-2 text-xs">
          <span className="font-medium" style={mine ? undefined : { color: message.authorColor }}>
            {message.authorName}
          </span>
          {message.authorModel ? <span className="opacity-70">{message.authorModel}</span> : null}
          {message.authorDemo ? <span className="opacity-70">演示</span> : null}
          <span className="opacity-70">{clock(message.createdAt)}</span>
        </div>
        {reply ? (
          <p className="mb-1 truncate text-xs opacity-70">
            回复 {reply.authorName}：{reply.text}
          </p>
        ) : null}
        <MessageBody text={message.text} names={names} tone={mine ? "cream" : "ink"} />
        <button
          type="button"
          className="mt-1 text-xs opacity-70 underline-offset-2 hover:underline"
          onClick={() => onReply(message)}
        >
          回复
        </button>
      </div>
    </article>
  )
}
