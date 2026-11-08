import { useEffect, useRef } from "react"
import { ArrowRight, Reply, X } from "lucide-react"

import { Avatar, MessageBody, seatLook } from "@/components/room/bits"
import { clock } from "@/lib/status"
import type { Message, PublicAgent } from "@/lib/types"

const EXAMPLES = [
  "@所有人 各自说一下你现在在做什么、擅长什么",
  "做一版定价页，手机上要能扫，做完看一遍边界",
  "谁现在有空？",
]

export function Thread({
  messages,
  agents,
  names,
  focusName,
  onClearFocus,
  onReply,
  onOpenTask,
  onExample,
}: {
  messages: Message[]
  agents: PublicAgent[]
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
    <div className="relative flex min-h-0 flex-1 flex-col">
      {focusName ? (
        <div className="absolute inset-x-0 top-0 z-10 flex justify-center pt-2">
          <button
            type="button"
            className="flex items-center gap-1.5 rounded-full border bg-card px-3 py-1 text-xs shadow-sm hover:bg-muted"
            onClick={onClearFocus}
          >
            只看和 {focusName} 有关的
            <X className="size-3" />
          </button>
        </div>
      ) : null}
      <div
        ref={scroller}
        className="min-h-0 flex-1 overflow-y-auto"
        onScroll={(event) => {
          const node = event.currentTarget
          stick.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80
        }}
        aria-live="polite"
      >
        <div className="mx-auto flex max-w-3xl flex-col gap-1 px-4 py-6 md:px-6">
          {!talked ? <Welcome onExample={onExample} /> : null}
          {messages.map((message, index) => (
            <MessageRow
              key={message.id}
              message={message}
              previous={messages[index - 1]}
              messages={messages}
              agents={agents}
              names={names}
              onReply={onReply}
              onOpenTask={onOpenTask}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

function Welcome({ onExample }: { onExample: (text: string) => void }) {
  return (
    <div className="mb-6 rounded-2xl border border-dashed px-5 py-6">
      <h2 className="text-base font-semibold">一个入口，叫到每一个 AI</h2>
      <p className="mt-1.5 text-sm leading-6 text-muted-foreground">
        Claude、DeepSeek、GPT、Grok、Gemini 各自在自己的软件里跑。它们入座以后，你在这里 @ 谁，房间就去唤起谁的会话，回答会回到这里。
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        {EXAMPLES.map((example) => (
          <button
            key={example}
            type="button"
            className="rounded-full border bg-card px-3 py-1.5 text-left text-xs hover:bg-muted"
            onClick={() => onExample(example)}
          >
            {example}
          </button>
        ))}
      </div>
    </div>
  )
}

function MessageRow({
  message,
  previous,
  messages,
  agents,
  names,
  onReply,
  onOpenTask,
}: {
  message: Message
  previous?: Message
  messages: Message[]
  agents: PublicAgent[]
  names: string[]
  onReply: (message: Message) => void
  onOpenTask: (taskId: string) => void
}) {
  if (message.kind === "system") {
    return (
      <p className="my-2 self-center rounded-full bg-muted px-3 py-1 text-center text-xs leading-5 text-muted-foreground">
        {message.text}
      </p>
    )
  }

  if (message.kind === "handoff" && message.handoff) {
    const handoff = message.handoff
    return (
      <article className="my-2 rounded-xl border bg-card px-4 py-3">
        <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{handoff.fromName}</span>
          <ArrowRight className="size-3" />
          <span className="font-medium text-foreground">{handoff.toName}</span>
          <span>交接 · {clock(message.createdAt)}</span>
        </p>
        <button
          type="button"
          className="mt-1.5 text-left text-sm font-semibold underline-offset-2 hover:underline disabled:no-underline"
          disabled={!message.taskId}
          onClick={() => message.taskId && onOpenTask(message.taskId)}
        >
          {handoff.taskTitle}
        </button>
        <div className="mt-1 text-muted-foreground">
          <MessageBody text={message.text} names={names} />
        </div>
      </article>
    )
  }

  const mine = message.authorId === "human"
  const grouped =
    previous !== undefined &&
    previous.kind === "chat" &&
    previous.authorId === message.authorId &&
    message.createdAt - previous.createdAt < 5 * 60_000 &&
    !message.replyTo
  const reply = message.replyTo ? messages.find((item) => item.id === message.replyTo) : undefined
  const author = agents.find((agent) => agent.id === message.authorId)
  const look = seatLook(
    author ?? { name: message.authorName, color: message.authorColor, model: message.authorModel, demo: message.authorDemo },
  )

  const replyButton = (
    <button
      type="button"
      className="self-center rounded-md p-1 text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-muted focus-visible:opacity-100"
      onClick={() => onReply(message)}
      aria-label="回复这条"
    >
      <Reply className="size-3.5" />
    </button>
  )

  if (mine) {
    return (
      <article className={`group flex justify-end gap-1 ${grouped ? "mt-0.5" : "mt-4"}`}>
        {replyButton}
        <div className="max-w-[min(85%,36rem)]">
          {reply ? <Quote message={reply} align="end" /> : null}
          <div className="rounded-2xl rounded-br-md bg-primary px-3.5 py-2 text-primary-foreground">
            <MessageBody text={message.text} names={names} tone="inverse" />
          </div>
          {!grouped ? (
            <p className="mt-1 text-right text-[11px] text-muted-foreground">{clock(message.createdAt)}</p>
          ) : null}
        </div>
      </article>
    )
  }

  return (
    <article className={`group flex gap-3 ${grouped ? "mt-0.5" : "mt-4"}`}>
      <div className="w-8 shrink-0">
        {!grouped ? <Avatar name={message.authorName} color={look.color} label={look.label} /> : null}
      </div>
      <div className="min-w-0 max-w-[min(85%,40rem)]">
        {!grouped ? (
          <p className="mb-1 flex flex-wrap items-baseline gap-x-2 text-xs">
            <span className="font-semibold">{message.authorName}</span>
            {look.kind ? (
              <span className="font-medium" style={{ color: look.color }}>
                {look.kind.label}
              </span>
            ) : message.authorModel ? (
              <span className="text-muted-foreground">{message.authorModel}</span>
            ) : null}
            {message.authorDemo ? <span className="text-muted-foreground">演示</span> : null}
            <span className="text-muted-foreground">{clock(message.createdAt)}</span>
          </p>
        ) : null}
        {reply ? <Quote message={reply} align="start" /> : null}
        <div className="rounded-2xl rounded-tl-md border bg-card px-3.5 py-2">
          <MessageBody text={message.text} names={names} />
        </div>
      </div>
      {replyButton}
    </article>
  )
}

function Quote({ message, align }: { message: Message; align: "start" | "end" }) {
  return (
    <p
      className={`mb-1 line-clamp-1 border-l-2 pl-2 text-xs text-muted-foreground ${align === "end" ? "ml-auto" : ""}`}
    >
      回复 {message.authorName}：{message.text}
    </p>
  )
}
