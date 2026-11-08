import { useEffect, useRef, useState, type CSSProperties } from "react"
import { ArrowRight, ListTree, Reply, X } from "lucide-react"

import { Avatar, MessageBody, seatLook } from "@/components/room/bits"
import { DOCK_EVENT } from "@/components/room/composer"
import { RunTrail } from "@/components/room/run-trail"
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
  onOpenRun,
  onExample,
  detail,
  onDetail,
}: {
  // 「详细」: each wake's steps show in the thread too (only on this page).
  detail: boolean
  onDetail: (detail: boolean) => void
  messages: Message[]
  agents: PublicAgent[]
  names: string[]
  focusName: string | null
  onClearFocus: () => void
  onReply: (message: Message) => void
  onOpenTask: (taskId: string) => void
  onOpenRun: (runId: string) => void
  onExample: (text: string) => void
}) {
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  // A smooth scroll we started is still moving; it passes through spots far
  // from the bottom, which must not count as you scrolling up.
  const gliding = useRef(false)
  const talked = messages.some((message) => message.kind !== "system")

  // New messages glide into view, as long as you were reading at the bottom.
  const seen = useRef(0)
  useEffect(() => {
    const node = scroller.current
    if (!node || !stick.current) return
    const first = seen.current === 0
    seen.current = messages.length
    if (first) {
      node.scrollTop = node.scrollHeight
      return
    }
    if (node.scrollHeight - node.scrollTop - node.clientHeight < 1) return
    gliding.current = true
    node.scrollTo({ top: node.scrollHeight, behavior: "smooth" })
    // scrollend can go missing (an interrupted scroll); never stay deaf to the user.
    const timer = window.setTimeout(() => (gliding.current = false), 1200)
    return () => {
      window.clearTimeout(timer)
      gliding.current = false
    }
  }, [messages])

  // The composer grows and shrinks with an animation; keep the last message
  // just above it in the same frame, so it rides along instead of lagging.
  useEffect(() => {
    const node = scroller.current
    const host = node?.parentElement?.parentElement
    if (!node || !host) return
    const pin = () => {
      if (stick.current) node.scrollTop = node.scrollHeight
    }
    host.addEventListener(DOCK_EVENT, pin)
    return () => host.removeEventListener(DOCK_EVENT, pin)
  }, [])

  // In 「详细」 the steps of a running wake keep growing; stay at the bottom.
  const content = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const node = scroller.current
    const inner = content.current
    if (!node || !inner) return
    const observer = new ResizeObserver(() => {
      if (stick.current && !gliding.current) node.scrollTop = node.scrollHeight
    })
    observer.observe(inner)
    return () => observer.disconnect()
  }, [])

  // Wakes still going whose reply isn't in yet.
  const posted = new Set(messages.map((message) => message.runId).filter(Boolean))
  const live = agents.filter((agent) => agent.runId && !posted.has(agent.runId))

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {focusName ? (
        <div className="absolute inset-x-0 top-0 z-10 flex justify-center pt-2">
          <button
            type="button"
            className="raised chip flex items-center gap-1.5 rounded-full px-3 py-1 text-xs"
            onClick={onClearFocus}
          >
            只看和 {focusName} 有关的
            <X className="size-3" />
          </button>
        </div>
      ) : null}
      <div className="absolute top-2 right-3 z-10 flex rounded-full p-0.5 pill" role="radiogroup" aria-label="群聊显示">
        {(
          [
            [false, "摘要"],
            [true, "详细"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={label}
            type="button"
            role="radio"
            aria-checked={detail === value}
            title={value ? "把每个模型做了什么也展开在群聊里，只有你看得到" : "群聊里只放回答"}
            className={`rounded-full px-2.5 py-0.5 text-[11px] transition-colors ${
              detail === value ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground"
            }`}
            onClick={() => onDetail(value)}
          >
            {label}
          </button>
        ))}
      </div>
      <div
        ref={scroller}
        className="min-h-0 flex-1 overflow-y-auto"
        onScroll={(event) => {
          if (gliding.current) return
          const node = event.currentTarget
          stick.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80
        }}
        onScrollEnd={() => {
          gliding.current = false
        }}
        aria-live="polite"
      >
        <div ref={content} className="mx-auto flex max-w-3xl flex-col gap-1 px-4 pt-6 pb-[calc(var(--dock,8rem)+1rem)] md:px-6">
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
              onOpenRun={onOpenRun}
              detail={detail}
            />
          ))}
          {live.map((agent) => (
            <LiveRun key={agent.id} agent={agent} detail={detail} onOpenRun={onOpenRun} />
          ))}
        </div>
      </div>
    </div>
  )
}

function Welcome({ onExample }: { onExample: (text: string) => void }) {
  return (
    <div className="frost mb-6 rounded-2xl px-5 py-6">
      <h2 className="text-base font-semibold">一个入口，叫到每一个 AI</h2>
      <p className="mt-1.5 text-sm leading-6 text-muted-foreground">
        Claude、DeepSeek、GPT、Grok、Gemini 各自在自己的软件里跑。它们入座以后，你在这里 @ 谁，房间就去唤起谁的会话，回答会回到这里。
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        {EXAMPLES.map((example) => (
          <button
            key={example}
            type="button"
            className="pill chip rounded-full px-3 py-1.5 text-left text-xs"
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
  onOpenRun,
  detail,
}: {
  detail: boolean
  message: Message
  previous?: Message
  messages: Message[]
  agents: PublicAgent[]
  names: string[]
  onReply: (message: Message) => void
  onOpenTask: (taskId: string) => void
  onOpenRun: (runId: string) => void
}) {
  const [watching, setWatching] = useState(false)

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
      <article className="my-2 rounded-xl border bg-card/85 px-4 py-3">
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
          <div className="bubble mine rounded-2xl rounded-br-md px-3.5 py-2 text-white">
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
    <article
      className={`group flex gap-3 ${grouped ? "mt-0.5" : "mt-4"}`}
      onPointerEnter={() => setWatching(true)}
      onPointerLeave={() => setWatching(false)}
    >
      <div className="w-8 shrink-0">
        {!grouped ? (
          <Avatar name={message.authorName} color={look.color} label={look.label} kind={look.kind} watch={watching} />
        ) : null}
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
        {detail && message.runId ? <RunTrail runId={message.runId} answer={message.text} /> : null}
        <div
          className="bubble rounded-2xl rounded-tl-md bg-card/85 px-3.5 py-2"
          style={{ "--halo": look.color } as CSSProperties}
        >
          <MessageBody text={message.text} names={names} />
        </div>
        {message.runId && !detail ? (
          // How it got there: the tool calls of the wake that wrote this.
          <button
            type="button"
            className="mt-1 flex items-center gap-1 rounded-md px-1 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={() => message.runId && onOpenRun(message.runId)}
          >
            <ListTree className="size-3" />
            查看过程
          </button>
        ) : null}
      </div>
      {replyButton}
    </article>
  )
}

// A seat that is working on a reply right now. 「详细」 shows its steps as they
// come; 「摘要」 a bubble that keeps moving until the reply lands in its place,
// with the step it is on and a way into the full log.
function LiveRun({
  agent,
  detail,
  onOpenRun,
}: {
  agent: PublicAgent
  detail: boolean
  onOpenRun: (runId: string) => void
}) {
  const look = seatLook(agent)
  return (
    <article className="mt-4 flex gap-3">
      <div className="w-8 shrink-0">
        <Avatar name={agent.name} color={look.color} label={look.label} kind={look.kind} status="working" />
      </div>
      <div className="min-w-0 max-w-[min(85%,40rem)] flex-1">
        <p className="mb-1 flex flex-wrap items-baseline gap-x-2 text-xs">
          <span className="font-semibold">{agent.name}</span>
          <span className="text-sky-700 dark:text-sky-300">正在做</span>
        </p>
        {detail ? (
          agent.runId ? <RunTrail runId={agent.runId} /> : null
        ) : (
          <button
            type="button"
            className="bubble working flex w-fit max-w-full items-center gap-2.5 rounded-2xl rounded-tl-md bg-card/85 px-3.5 py-2.5 text-left"
            style={{ "--halo": look.color } as CSSProperties}
            title="查看过程"
            onClick={() => agent.runId && onOpenRun(agent.runId)}
          >
            <span className="typing shrink-0" aria-hidden>
              <i />
              <i />
              <i />
            </span>
            <span className="min-w-0 truncate text-sm text-muted-foreground">{agent.doing || "在想…"}</span>
            <ListTree className="size-3.5 shrink-0 text-muted-foreground" aria-label="查看过程" />
          </button>
        )}
      </div>
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
