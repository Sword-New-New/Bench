import { startTransition, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react"
import { ArrowRight, Check, ChevronDown, ListTree, Reply, Undo2, X, Zap } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/components/room/api"
import { AskCard, PinnedAsks } from "@/components/room/ask-card"
import { MessageFiles, previewText } from "@/components/room/attachments"
import { LimitedCard } from "@/components/room/limited-card"
import { FullAccessToggle } from "@/components/room/permits"
import { Avatar, FoldButton, keepTopInView, MessageBody, seatLook, useFold } from "@/components/room/bits"
import { DOCK_EVENT } from "@/components/room/composer"
import { GOTO_EVENT, type Goto } from "@/components/room/refs"
import { Reveal } from "@/components/room/reveal"
import { RunTrail } from "@/components/room/run-trail"
import { Button } from "@/components/ui/button"
import { clock } from "@/lib/status"
import type { Message, PublicAgent } from "@/lib/types"

const EXAMPLES = [
  "@所有人 各自说一下你现在在做什么、擅长什么",
  "做一版定价页，手机上要能扫，做完看一遍边界",
  "谁现在有空？",
]

// How many thread items (a reply chain counts as one) are drawn at first and per click.
const PAGE = 40
const FIRST = 12

export function Thread({
  messages,
  agents,
  names,
  focusName,
  onClearFocus,
  onReply,
  onOpenTask,
  onOpenRun,
  onRewake,
  onMention,
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
  // Wake again a seat a restart cut off.
  onRewake: (runId: string) => void
  // Clicking an avatar @-mentions that seat in the composer.
  onMention: (name: string) => void
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

  // A long room is slow to draw whole: show the latest stretch, and let a
  // click at the top bring in an earlier one without moving what you are reading.
  // A fresh thread (page load, another project) first draws only the last
  // few, which is all that shows at the bottom, then the rest of the page
  // right after in the background: switching projects waits for less.
  const [limit, setLimit] = useState(FIRST)
  useEffect(() => {
    const frame = requestAnimationFrame(() => startTransition(() => setLimit((value) => Math.max(value, PAGE))))
    return () => cancelAnimationFrame(frame)
  }, [])
  const anchor = useRef<number | null>(null)
  const items = threadItems(messages)
  const hidden = Math.max(0, items.length - limit)
  const shown = hidden > 0 ? items.slice(hidden) : items
  // Open questions whose card is in the part not drawn.
  const drawn = new Set(shown.flatMap((item) => (item.chain ? item.chain : [item.message]).map((message) => message.id)))
  const pinned = hidden > 0 ? messages.filter((message) => message.ask?.state === "open" && !message.recalled && !drawn.has(message.id)) : []
  const loadEarlier = () => {
    const node = scroller.current
    anchor.current = node ? node.scrollHeight - node.scrollTop : null
    stick.current = false
    setLimit((value) => value + PAGE)
  }
  useLayoutEffect(() => {
    const node = scroller.current
    if (node && anchor.current !== null) node.scrollTop = node.scrollHeight - anchor.current
    anchor.current = null
  }, [limit])

  const row = (message: Message, previous?: Message) => (
    <div key={message.id} data-message={message.id} className="contents">
    <MessageRow
      message={message}
      previous={previous}
      messages={messages}
      agents={agents}
      names={names}
      onReply={onReply}
      onOpenTask={onOpenTask}
      onOpenRun={onOpenRun}
      onRewake={onRewake}
      onMention={onMention}
      detail={detail}
    />
    </div>
  )

  const line = (message: Message, previous: Message | undefined) => (
    <div key={message.id} data-message={message.id} className="contents">
    <ChainLine
      message={message}
      previous={previous}
      messages={messages}
      agents={agents}
      names={names}
      detail={detail}
      onReply={onReply}
      onOpenRun={onOpenRun}
      onMention={onMention}
    />
    </div>
  )

  // A message id clicked in some message (components/room/refs.ts): draw far
  // enough back to include it, open its reply chain if folded there (ReplyChain
  // listens too), scroll to it and flash it.
  const latest = useRef({ messages, items, limit })
  useEffect(() => {
    latest.current = { messages, items, limit }
  })
  useEffect(() => {
    const onGoto = (event: Event) => {
      const { kind, id } = (event as CustomEvent<Goto>).detail
      if (kind !== "message") return
      const now = latest.current
      if (!now.messages.some((message) => message.id === id)) {
        toast("这条消息太早了，页面上没有加载到")
        return
      }
      const index = now.items.findIndex((item) => (item.chain ?? [item.message]).some((message) => message.id === id))
      stick.current = false
      if (index >= 0 && index < now.items.length - now.limit) setLimit(now.items.length - index + 3)
      const find = (tries: number) => {
        const holder = document.querySelector(`[data-message="${CSS.escape(id)}"]`)
        const target = holder?.firstElementChild as HTMLElement | null | undefined
        if (target) {
          target.scrollIntoView({ block: "center", behavior: "smooth" })
          target.animate(
            [
              { outline: "2px solid color-mix(in oklab, var(--color-mention, #3b82f6) 85%, transparent)", outlineOffset: "4px" },
              { outline: "2px solid transparent", outlineOffset: "4px" },
            ],
            { duration: 1800, delay: 250, easing: "ease-out" },
          )
          return
        }
        if (tries > 0) requestAnimationFrame(() => find(tries - 1))
        else toast("这条消息在群聊里没画出来")
      }
      requestAnimationFrame(() => find(30))
    }
    window.addEventListener(GOTO_EVENT, onGoto)
    return () => window.removeEventListener(GOTO_EVENT, onGoto)
  }, [])

  // Wakes still going whose reply isn't in yet. A question card (bench_ask)
  // comes from the middle of a run, not its end, so it doesn't count.
  const posted = new Set(messages.filter((message) => !message.ask).map((message) => message.runId).filter(Boolean))
  // In the order they started, so a tool call doesn't bump a seat to the top.
  const live = agents
    .filter((agent) => agent.runId && !posted.has(agent.runId))
    .sort((a, b) => (a.runStartedAt ?? 0) - (b.runStartedAt ?? 0) || a.id.localeCompare(b.id))

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
        {/* --live-gap: this column's gap, for a 「正在做」 row to give back as it closes (live-close). */}
        <div
          ref={content}
          className="mx-auto flex max-w-3xl flex-col gap-1 px-4 pt-6 pb-[calc(var(--dock,8rem)+1rem)] md:px-6 [&>.live-slot]:[--live-gap:0.25rem]"
        >
          <PinnedAsks asks={pinned} />
          {!talked ? <Welcome onExample={onExample} /> : null}
          {hidden > 0 ? (
            <button
              type="button"
              className="chip mx-auto my-2 rounded-full px-3 py-1 text-xs text-muted-foreground hover:text-foreground"
              onClick={loadEarlier}
            >
              加载更早的 {Math.min(PAGE, hidden)} 条（还有 {hidden} 条没显示）
            </button>
          ) : null}
          {shown.map((item) =>
            item.chain ? (
              <ReplyChain key={item.chain[0].id} chain={item.chain} line={line} />
            ) : (
              row(item.message, item.previous)
            ),
          )}
          <LiveDrawer agents={live} detail={detail} onOpenRun={onOpenRun} onMention={onMention} />
        </div>
      </div>
    </div>
  )
}

type ThreadItem = { message: Message; previous?: Message; chain?: undefined } | { chain: Message[] }

// Replies gather under the message they started from, into one chain. A
// chain sits where its latest message landed, so a new reply still turns up
// at the bottom of the thread, with what it answers right above it.
function threadItems(messages: Message[]): ThreadItem[] {
  const byId = new Map(messages.map((message) => [message.id, message]))
  const rootOf = (message: Message) => {
    let at = message
    const seen = new Set<string>()
    while (at.replyTo && !seen.has(at.id)) {
      seen.add(at.id)
      const up = byId.get(at.replyTo)
      if (!up || up.kind === "system") break
      at = up
    }
    return at.id
  }
  const chains = new Map<string, Message[]>()
  const chainOf = new Map<string, Message[]>()
  for (const message of messages) {
    if (message.kind === "system") continue
    const root = rootOf(message)
    const chain = chains.get(root) ?? []
    chain.push(message)
    chains.set(root, chain)
    chainOf.set(message.id, chain)
  }
  const items: ThreadItem[] = []
  let previous: Message | undefined
  for (const message of messages) {
    const chain = chainOf.get(message.id)
    if (!chain || chain.length < 2) {
      items.push({ message, previous })
      previous = message
      continue
    }
    if (chain[chain.length - 1].id !== message.id) continue
    items.push({ chain })
    previous = undefined
  }
  return items
}

// A reply chain reads as one conversation: one card, headed by who took part
// and when it last moved, every message on its own line, people and agents
// alike on the left. Folded, it shows the first message and the latest one,
// with how many sit between.
function ReplyChain({
  chain,
  line,
}: {
  chain: Message[]
  line: (message: Message, previous: Message | undefined) => ReactNode
}) {
  const [open, setOpen] = useState(false)
  const top = useRef<HTMLElement>(null)
  const [root, ...replies] = chain
  const middle = replies.slice(0, -1)
  const middleIds = middle.map((message) => message.id).join(" ")
  useEffect(() => {
    const ids = new Set(middleIds.split(" "))
    const onGoto = (event: Event) => {
      const { kind, id } = (event as CustomEvent<Goto>).detail
      if (kind === "message" && ids.has(id)) setOpen(true)
    }
    window.addEventListener(GOTO_EVENT, onGoto)
    return () => window.removeEventListener(GOTO_EVENT, onGoto)
  }, [middleIds])
  const last = replies[replies.length - 1]
  const people = [...new Set(chain.map((message) => message.authorName))]
  const toggle = () => {
    setOpen((value) => !value)
    keepTopInView(top.current)
  }
  return (
    // A solid card, not glass on glass: an opaque face, a rim you can see, a
    // lift off the backdrop, and a stripe down the left marking one conversation.
    <section
      ref={top}
      className="my-5 overflow-clip rounded-2xl border border-l-[3px] border-foreground/15 border-l-primary/60 bg-card shadow-[0_1px_2px_rgb(0_0_0/0.06),0_18px_36px_-20px_rgb(0_0_0/0.28)]"
    >
      <header className="flex items-center gap-2 border-b border-foreground/10 bg-muted/60 px-4 py-2 text-[11px] text-muted-foreground">
        <Reply className="size-3 shrink-0" />
        <span className="min-w-0 flex-1 truncate">
          <span className="font-medium text-foreground">回复链</span> · {chain.length} 条 · {people.join("、")} · 最新{" "}
          {clock(last.createdAt)}
        </span>
        {middle.length > 0 ? (
          <button
            type="button"
            className="flex shrink-0 items-center gap-0.5 rounded-md px-1 hover:bg-muted hover:text-foreground"
            aria-expanded={open}
            onClick={toggle}
          >
            {open ? "收起" : "展开全部"}
            <ChevronDown className={`size-3 transition-transform ${open ? "rotate-180" : ""}`} />
          </button>
        ) : null}
      </header>
      {line(root, undefined)}
      {middle.length > 0 ? (
        <>
          <Reveal open={!open}>
            <button
              type="button"
              className="flex w-full items-center gap-2 border-t border-foreground/8 px-4 py-1.5 text-[11px] text-muted-foreground hover:bg-muted/60 hover:text-foreground"
              onClick={toggle}
            >
              <span className="h-px flex-1 border-t border-dashed border-current/40" />
              中间还有 {middle.length} 条
              <span className="h-px flex-1 border-t border-dashed border-current/40" />
            </button>
          </Reveal>
          <Reveal open={open}>{middle.map((message, index) => line(message, middle[index - 1] ?? root))}</Reveal>
        </>
      ) : null}
      {/* Folded, the latest keeps its quote unless it answers the first message. */}
      {line(last, open ? (middle[middle.length - 1] ?? root) : root)}
    </section>
  )
}

// One message inside a reply chain: compact, left-aligned for everyone, a
// quote only when it answers something other than the line above it.
function ChainLine({
  message,
  previous,
  messages,
  agents,
  names,
  detail,
  onReply,
  onOpenRun,
  onMention,
}: {
  message: Message
  previous: Message | undefined
  messages: Message[]
  agents: PublicAgent[]
  names: string[]
  detail: boolean
  onReply: (message: Message) => void
  onOpenRun: (runId: string) => void
  onMention: (name: string) => void
}) {
  const fold = useFold(message.text)
  if (message.recalled) return <RecalledLine message={message} inChain />
  const author = agents.find((agent) => agent.id === message.authorId)
  const look = seatLook(
    author ?? { name: message.authorName, color: message.authorColor, model: message.authorModel, demo: message.authorDemo },
  )
  const human = message.authorId === "human"
  const reply =
    previous && message.replyTo && message.replyTo !== previous.id
      ? messages.find((item) => item.id === message.replyTo)
      : undefined
  const avatar = <Avatar name={message.authorName} color={look.color} label={look.label} kind={look.kind} size="sm" />
  return (
    <article className={`flex gap-3 px-4 py-3 ${previous ? "border-t border-foreground/8" : ""} ${human ? "bg-primary/[0.05]" : ""}`}>
      <div className="w-6 shrink-0 pt-0.5">
        {author ? (
          <MentionAvatar name={author.name} onMention={onMention}>
            {avatar}
          </MentionAvatar>
        ) : (
          avatar
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-baseline gap-x-2 text-xs">
          <span className="font-semibold">{message.authorName}</span>
          {look.kind ? (
            <span className="font-medium" style={{ color: look.color }}>
              {look.kind.label}
            </span>
          ) : null}
          <span className="text-muted-foreground">{clock(message.createdAt)}</span>
        </p>
        {reply ? <Quote message={reply} align="start" /> : null}
        {detail && message.runId ? <RunTrail runId={message.runId} answer={message.text} /> : null}
        {message.text ? (
          <div className="mt-0.5">
            <MessageBody text={shown(message, agents)} names={names} from={message.authorId} fold={fold} />
          </div>
        ) : null}
        {message.attachments?.length ? <MessageFiles files={message.attachments} folded={folded(fold)} /> : null}
        {message.ask ? <AskCard message={message} /> : null}
        <Reached message={message} />
        <div className="mt-0.5 -ml-1 flex items-center gap-1">
          <FoldButton fold={fold} />
          {message.runId && !detail ? (
            <button
              type="button"
              className="flex items-center gap-1 rounded-md px-1 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={() => message.runId && onOpenRun(message.runId)}
            >
              <ListTree className="size-3" />
              查看过程
            </button>
          ) : null}
          <button
            type="button"
            className="flex items-center gap-1 rounded-md px-1 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={() => onReply(message)}
            aria-label="回复这条"
          >
            <Reply className="size-3" />
            回复
          </button>
          {message.authorId === "human" ? <RecallButton message={message} /> : null}
        </div>
      </div>
    </article>
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

// A seat's avatar in the thread: one click puts @name in the composer.
function MentionAvatar({ name, onMention, children }: { name: string; onMention: (name: string) => void; children: ReactNode }) {
  return (
    <button
      type="button"
      className="block rounded-full transition-transform hover:scale-105 focus-visible:ring-2 focus-visible:ring-ring active:scale-95"
      title={`@${name}`}
      aria-label={`@${name}`}
      onClick={() => onMention(name)}
    >
      {children}
    </button>
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
  onRewake,
  onMention,
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
  onRewake: (runId: string) => void
  onMention: (name: string) => void
}) {
  const [watching, setWatching] = useState(false)
  const fold = useFold(message.text)

  if (message.recalled) return <RecalledLine message={message} />

  if (message.kind === "system" && message.limited) return <LimitedCard message={message} />

  if (message.kind === "system" && message.interrupted?.length) {
    // After a restart: what it cut off, each with a button to wake it again.
    return (
      <div className="my-2 self-center rounded-2xl border border-amber-500/30 bg-amber-500/[0.08] px-4 py-2.5 text-center text-xs leading-5 text-muted-foreground">
        <p>{message.text}</p>
        <div className="mt-2 flex flex-wrap justify-center gap-1.5">
          {message.interrupted.map((item) =>
            item.resumedAt ? (
              <span key={item.runId} className="inline-flex h-6 items-center gap-1 px-2 text-muted-foreground">
                <Check className="size-3" />
                {item.agentName} 已重新叫醒 · {clock(item.resumedAt)}
              </span>
            ) : (
              <span key={item.runId} className="inline-flex items-center gap-1">
                <Button type="button" size="xs" onClick={() => onRewake(item.runId)}>
                  重新叫醒 {item.agentName}
                </Button>
                <Button type="button" size="xs" variant="ghost" onClick={() => onOpenRun(item.runId)}>
                  过程
                </Button>
              </span>
            ),
          )}
        </div>
      </div>
    )
  }

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
          <MessageBody text={shown(message, agents)} names={names} from={message.authorId} />
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
  // In a chain the message it answers is usually right above it; quote it
  // only when it isn't.
  const reply =
    message.replyTo && message.replyTo !== previous?.id
      ? messages.find((item) => item.id === message.replyTo)
      : undefined
  const author = agents.find((agent) => agent.id === message.authorId)
  const look = seatLook(
    author ?? { name: message.authorName, color: message.authorColor, model: message.authorModel, demo: message.authorDemo },
  )

  // Under the bubble, where it can be found however long the message is.
  const replyButton = (
    <button
      type="button"
      className="flex items-center gap-1 rounded-md px-1 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
      onClick={() => onReply(message)}
      aria-label="回复这条"
    >
      <Reply className="size-3" />
      回复
    </button>
  )

  if (mine) {
    return (
      <article className={`flex justify-end ${grouped ? "mt-0.5" : "mt-4"}`}>
        <div className="max-w-[min(85%,36rem)]">
          {reply ? <Quote message={reply} align="end" /> : null}
          {message.text ? (
            <div className="bubble mine rounded-2xl rounded-br-md px-3.5 py-2 text-white">
              <MessageBody text={shown(message, agents)} names={names} from={message.authorId} tone="inverse" fold={fold} />
            </div>
          ) : null}
          {message.attachments?.length ? <MessageFiles files={message.attachments} align="end" folded={folded(fold)} /> : null}
          <Reached message={message} align="end" />
          <div className="mt-1 flex items-center justify-end gap-2 text-[11px] text-muted-foreground">
            <FoldButton fold={fold} />
            <RecallButton message={message} />
            {replyButton}
            {!grouped ? <span>{clock(message.createdAt)}</span> : null}
          </div>
        </div>
      </article>
    )
  }

  return (
    <article
      className={`flex gap-3 ${grouped ? "mt-0.5" : "mt-4"}`}
      onPointerEnter={() => setWatching(true)}
      onPointerLeave={() => setWatching(false)}
    >
      <div className="w-8 shrink-0">
        {grouped ? null : author ? (
          <MentionAvatar name={author.name} onMention={onMention}>
            <Avatar name={message.authorName} color={look.color} label={look.label} kind={look.kind} watch={watching} />
          </MentionAvatar>
        ) : (
          <Avatar name={message.authorName} color={look.color} label={look.label} kind={look.kind} watch={watching} />
        )}
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
        {message.text ? (
          <div
            className="bubble rounded-2xl rounded-tl-md bg-card/85 px-3.5 py-2"
            style={{ "--halo": look.color } as CSSProperties}
          >
            <MessageBody text={shown(message, agents)} names={names} from={message.authorId} fold={fold} />
          </div>
        ) : null}
        {message.attachments?.length ? <MessageFiles files={message.attachments} folded={folded(fold)} /> : null}
        {message.ask ? <AskCard message={message} /> : null}
        <Reached message={message} />
        <div className="mt-1 flex items-center gap-1">
          <FoldButton fold={fold} />
          {message.runId && !detail ? (
            // How it got there: the tool calls of the wake that wrote this.
            <button
              type="button"
              className="flex items-center gap-1 rounded-md px-1 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={() => message.runId && onOpenRun(message.runId)}
            >
              <ListTree className="size-3" />
              查看过程
            </button>
          ) : null}
          {replyButton}
        </div>
      </div>
    </article>
  )
}

// A seat that is working on a reply right now. 「详细」 shows its steps as they
// come; 「摘要」 a bubble that keeps moving until the reply lands in its place,
// with the step it is on and a way into the full log.
// Seats working right now. One shows as its card; two or more fold into one
// bar (who, and a line of what each is doing) that opens to the cards.
// A step that has gone quiet for 10 seconds says how long it has been going.
const QUIET_MS = 10_000

function useNow(on: boolean) {
  const [now, setNow] = useState(0)
  useEffect(() => {
    if (!on) return
    const tick = () => setNow(Date.now())
    const first = window.setTimeout(tick, 0)
    const timer = window.setInterval(tick, 1000)
    return () => {
      window.clearTimeout(first)
      window.clearInterval(timer)
    }
  }, [on])
  return now
}

function quietFor(agent: PublicAgent, now: number) {
  // 「还没开始回应，已等 …」 already counts by itself.
  if (!agent.stepAt || !now || agent.doing.includes("已等")) return ""
  const ms = now - agent.stepAt
  if (ms < QUIET_MS) return ""
  const sec = Math.floor(ms / 1000)
  return sec < 60 ? `${sec} 秒` : `${Math.floor(sec / 60)} 分 ${String(sec % 60).padStart(2, "0")} 秒`
}

function Quiet({ agent, now }: { agent: PublicAgent; now: number }) {
  const text = quietFor(agent, now)
  return text ? <span className="shrink-0 tabular-nums text-amber-700/80 dark:text-amber-300/80">· {text}</span> : null
}

// ---- recall ----

// The page puts a recalled message's words back in the composer through this.
export const EDIT_EVENT = "bench-edit-draft"

// What was taken back from this page, for 「重新编辑」. Only here: the room
// itself keeps nothing of it.
const recalledHere = new Map<string, string>()

async function recallMessage(message: Message) {
  try {
    const result = await api<{ original: { text: string } }>("/api/v1/recall", {
      method: "POST",
      body: JSON.stringify({ as: "human", id: message.id }),
    })
    if (result.original.text.trim()) recalledHere.set(message.id, result.original.text)
  } catch (error) {
    toast.error(error instanceof Error ? error.message : "没撤回成功")
  }
}

function RecallButton({ message }: { message: Message }) {
  return (
    <button
      type="button"
      className="flex items-center gap-1 rounded-md px-1 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
      onClick={() => void recallMessage(message)}
      aria-label="撤回这条"
    >
      <Undo2 className="size-3" />
      撤回
    </button>
  )
}

function RecalledLine({ message, inChain = false }: { message: Message; inChain?: boolean }) {
  const words = recalledHere.get(message.id)
  return (
    <p
      className={`text-center text-xs text-muted-foreground ${inChain ? "px-4 py-2.5" : "my-2 self-center"}`}
    >
      {message.authorId === "human" ? "你" : message.authorName}撤回了一条消息
      {message.recalled ? ` · ${clock(message.recalled.at)}` : ""}
      {words ? (
        <button
          type="button"
          className="ml-1.5 font-medium text-primary underline-offset-2 hover:underline"
          onClick={() => window.dispatchEvent(new CustomEvent(EDIT_EVENT, { detail: words }))}
        >
          重新编辑
        </button>
      ) : null}
    </p>
  )
}

// While a long message is folded, its attachments fold with it.
function folded(fold: { long: boolean; open: boolean; toggle: () => void }) {
  return fold.long && !fold.open ? fold.toggle : undefined
}

// Seats that were busy when this called them and got it in the middle of
// their run (lib/summon.ts takeQueued), not after it.
function Reached({ message, align = "start" }: { message: Message; align?: "start" | "end" }) {
  const list = message.reached
  if (!list?.length) return null
  const names = list.map((item) => item.name).join("、")
  return (
    <p
      className={`mt-1 flex animate-in items-center gap-1 text-[11px] text-emerald-700 duration-300 fade-in dark:text-emerald-400 ${
        align === "end" ? "justify-end" : ""
      }`}
      title={`${names} 正在干活，这条在它这一轮中途就送进去了，不用等它做完`}
    >
      <Zap className="size-3" />
      已送到正在干活的 {names}
    </p>
  )
}

// Seats whose run just ended stay a moment longer, so their card can fold
// away instead of vanishing (`.live-leave`).
const LEAVE_MS = 1450

function useLeaving(agents: PublicAgent[]) {
  const key = agents.map((agent) => agent.id).join(" ")
  const [seen, setSeen] = useState({ key, agents })
  const [gone, setGone] = useState<PublicAgent[]>([])
  if (seen.key !== key) {
    const still = new Set(agents.map((agent) => agent.id))
    const left = seen.agents.filter((agent) => !still.has(agent.id))
    setSeen({ key, agents })
    if (left.length) setGone((list) => [...list.filter((agent) => !still.has(agent.id)), ...left])
    else if (gone.some((agent) => still.has(agent.id))) setGone((list) => list.filter((agent) => !still.has(agent.id)))
  } else if (agents.some((agent, index) => agent !== seen.agents[index])) {
    // Same seats, fresher data: keep the last look of each for when it leaves.
    setSeen({ key, agents })
  }
  useEffect(() => {
    if (gone.length === 0) return
    const timer = window.setTimeout(() => setGone([]), LEAVE_MS)
    return () => window.clearTimeout(timer)
  }, [gone])
  return gone
}

function Leaving({ leaving, color, children }: { leaving: boolean; color: string; children: ReactNode }) {
  return (
    <div
      className={`live-slot ${leaving ? "live-leave" : ""}`}
      style={{ "--halo": color } as CSSProperties}
      aria-hidden={leaving || undefined}
    >
      <div>
        {children}
        {leaving ? <i className="live-line" aria-hidden /> : null}
      </div>
    </div>
  )
}

// The bubble's width follows what it says: a hidden copy at its natural width
// is measured, and the bubble eases to that.
function useNaturalWidth() {
  const [node, measure] = useState<HTMLElement | null>(null)
  const [width, setWidth] = useState<number>()
  useEffect(() => {
    if (!node) return
    const update = () => setWidth(Math.ceil(node.getBoundingClientRect().width))
    const observer = new ResizeObserver(update)
    observer.observe(node)
    update()
    return () => observer.disconnect()
  }, [node])
  return { measure, width }
}

// Debug menu → a made-up seat runs through a short, a long and a short step,
// then finishes, so the card's width easing and its exit can be watched.
export const LIVE_DEMO = "bench-live-demo"
const DEMO_STEPS = ["读 thread.tsx", "跑 npx tsc --noEmit -p . && npx eslint app components lib scripts", "写回复"]
const DEMO_STEP_MS = 1800

function useLiveDemo() {
  const [step, setStep] = useState(-1)
  useEffect(() => {
    const timers: number[] = []
    const play = () => {
      timers.splice(0).forEach((timer) => window.clearTimeout(timer))
      setStep(0)
      for (let index = 1; index <= DEMO_STEPS.length; index++) {
        timers.push(window.setTimeout(() => setStep(index < DEMO_STEPS.length ? index : -1), index * DEMO_STEP_MS))
      }
    }
    window.addEventListener(LIVE_DEMO, play)
    return () => {
      window.removeEventListener(LIVE_DEMO, play)
      timers.forEach((timer) => window.clearTimeout(timer))
    }
  }, [])
  // One object per step: the exit keeps comparing seats by identity.
  return useMemo(() => (step < 0 ? null : demoAgent(DEMO_STEPS[step])), [step])
}

function demoAgent(doing: string): PublicAgent {
  const startedAt = Date.now()
  return {
    id: "demo-live",
    name: "演示",
    model: "",
    role: "",
    strengths: [],
    status: "working",
    doing,
    color: "oklch(0.65 0.15 160)",
    demo: true,
    agentName: "demo",
    hasSession: false,
    callable: false,
    standby: false,
    runStartedAt: startedAt,
    stepAt: startedAt,
    createdAt: startedAt,
    lastSeenAt: startedAt,
  }
}

function LiveDrawer({
  agents: real,
  detail,
  onOpenRun,
  onMention,
}: {
  agents: PublicAgent[]
  detail: boolean
  onOpenRun: (runId: string) => void
  onMention: (name: string) => void
}) {
  const [open, setOpen] = useState(false)
  const demo = useLiveDemo()
  const agents = demo ? [...real, demo] : real
  const now = useNow(agents.length > 0)
  const gone = useLeaving(agents)
  // Leaving cards keep their place and their element (same key, same
  // wrapper), so the exit plays on what was on screen.
  const leavingIds = new Set(gone.map((agent) => agent.id))
  const runs = [...agents, ...gone]
    .sort((a, b) => (a.runStartedAt ?? 0) - (b.runStartedAt ?? 0))
    .map((agent) => (
      <Leaving key={agent.id} leaving={leavingIds.has(agent.id)} color={seatLook(agent).color}>
        <LiveRun agent={agent} detail={detail} onOpenRun={onOpenRun} onMention={onMention} />
      </Leaving>
    ))
  if (agents.length === 0 && gone.length === 0) return null
  if (agents.length <= 1) return <>{runs}</>
  return (
    <section className="mt-4">
      <button
        type="button"
        className="bubble working flex w-full max-w-[min(100%,40rem)] items-center gap-3 rounded-2xl bg-card/85 px-3 py-2 text-left"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="flex shrink-0 -space-x-2">
          {agents.slice(0, 4).map((agent) => {
            const look = seatLook(agent)
            return (
              <span key={agent.id} className="rounded-full ring-2 ring-card">
                <Avatar name={agent.name} color={look.color} label={look.label} kind={look.kind} size="sm" />
              </span>
            )
          })}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-xs font-semibold">
            {agents.length} 个在做
            <span className="ml-1.5 font-normal text-muted-foreground">{open ? "点这里收起" : "点开看各自的进度"}</span>
          </span>
          {/* The first two say what they are on; the rest only count. */}
          <span className="flex min-w-0 gap-2 text-xs text-muted-foreground">
            {agents.slice(0, 2).map((agent) => (
              <span key={agent.id} className="flex min-w-0 max-w-1/2 gap-1">
                <span className="min-w-0 truncate">
                  <span className="font-medium text-foreground/80">{agent.name}</span>：{agent.doing || "在想…"}
                </span>
                <Quiet agent={agent} now={now} />
              </span>
            ))}
            {agents.length > 2 ? <span className="shrink-0">等 {agents.length} 个</span> : null}
          </span>
        </span>
        <span className="typing shrink-0" aria-hidden>
          <i />
          <i />
          <i />
        </span>
        <ChevronDown className={`size-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      <Reveal open={open}>{runs}</Reveal>
    </section>
  )
}

function LiveRun({
  agent,
  detail,
  onOpenRun,
  onMention,
}: {
  agent: PublicAgent
  detail: boolean
  onOpenRun: (runId: string) => void
  onMention: (name: string) => void
}) {
  const look = seatLook(agent)
  const now = useNow(true)
  const { measure, width } = useNaturalWidth()
  // Twice: once to show (it truncates when there's no room), once unseen at
  // its natural width to measure.
  const inside = (shown: boolean) => (
    <>
      <span className="typing shrink-0" aria-hidden>
        <i />
        <i />
        <i />
      </span>
      <span
        key={shown ? agent.doing : undefined}
        className={`min-w-0 truncate text-sm text-muted-foreground ${shown ? "animate-in duration-300 fade-in" : ""}`}
      >
        {agent.doing || "在想…"}
      </span>
      <span className="shrink-0 text-sm">
        <Quiet agent={agent} now={now} />
      </span>
      <ListTree className="size-3.5 shrink-0 text-muted-foreground" aria-label={shown ? "查看过程" : undefined} />
    </>
  )
  return (
    <article className="mt-4 flex animate-in gap-3 duration-300 fade-in slide-in-from-bottom-1">
      <div className="w-8 shrink-0">
        <MentionAvatar name={agent.name} onMention={onMention}>
          <Avatar name={agent.name} color={look.color} label={look.label} kind={look.kind} status="working" />
        </MentionAvatar>
      </div>
      <div className="min-w-0 max-w-[min(85%,40rem)] flex-1">
        <p className="mb-1 flex flex-wrap items-baseline gap-x-2 text-xs">
          <span className="font-semibold">{agent.name}</span>
          <span className="text-sky-700 dark:text-sky-300">正在做</span>
          <FullAccessToggle agent={agent} />
        </p>
        {detail ? (
          agent.runId ? <RunTrail runId={agent.runId} /> : null
        ) : (
          <button
            type="button"
            className={`bubble working flex max-w-full items-center gap-2.5 rounded-2xl rounded-tl-md bg-card/85 px-3.5 py-2.5 text-left transition-[width] duration-300 ease-out motion-reduce:transition-none ${
              width ? "" : "w-fit"
            }`}
            style={{ "--halo": look.color, width } as CSSProperties}
            title="查看过程"
            onClick={() => agent.runId && onOpenRun(agent.runId)}
          >
            {inside(true)}
            <span
              ref={measure}
              className="pointer-events-none invisible absolute top-0 left-0 flex w-max items-center gap-2.5 px-3.5 py-2.5"
              aria-hidden
            >
              {inside(false)}
            </span>
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
      回复 {message.authorName}：{previewText(message)}
    </p>
  )
}

// What a message reads as on the page. A verdict names the task's owner by
// its current seat name, looked up from the id it carries.
function shown(message: Message, agents: PublicAgent[]) {
  const owner = message.verdict?.ownerId
  if (!owner) return message.text
  const name = agents.find((agent) => agent.id === owner)?.name
  return name ? `${message.text}（负责人 ${name}）` : message.text
}

