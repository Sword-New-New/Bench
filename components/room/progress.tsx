"use client"

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react"
import { Check, ChevronDown, Loader2, MessageCircle, RotateCcw, Square } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/components/room/api"
import { AskCard } from "@/components/room/ask-card"
import { keepTopInView, useTick } from "@/components/room/bits"
import { nudgeSeat } from "@/components/room/nudge"
import { PermitCard } from "@/components/room/permits"
import { GOTO_EVENT, type Goto } from "@/components/room/refs"
import { Reveal } from "@/components/room/reveal"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { ago, clock, plainCheckText } from "@/lib/status"
import type { Digest, DigestRow, DigestState } from "@/lib/digest"
import { gistOf } from "@/lib/text"
import type { Message, PermitRequest, PublicAgent } from "@/lib/types"

// 「进展」: the room as things, not as a timeline: one line a thing, its state
// as a colour, what you have to do as a button on the line. The rows come from
// a digest of the room's own facts (to-dos, steps, sign-offs, who is stuck),
// never from a model. A row opens in place to its conversation, each reply
// still a one-line gist first.

// The same colours as the right column and the flow view.
const LOOK: Record<DigestState, { stripe: string; chip: string; label: string; title: string }> = {
  you: {
    stripe: "bg-amber-500",
    chip: "border-amber-500/50 bg-amber-500/12 text-amber-800 dark:text-amber-300",
    label: "等你",
    title: "等你动手",
  },
  stuck: {
    stripe: "bg-red-500",
    chip: "border-red-500/45 bg-red-500/10 text-red-700 dark:text-red-300",
    label: "停着",
    title: "停着，要推一把",
  },
  doing: {
    stripe: "bg-sky-500",
    chip: "border-sky-500/45 bg-sky-500/10 text-sky-700 dark:text-sky-300",
    label: "在做",
    title: "在做",
  },
  done: {
    stripe: "bg-emerald-500",
    chip: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    label: "今天做完",
    title: "今天做完的",
  },
  talk: {
    stripe: "bg-foreground/25",
    chip: "border-foreground/15 bg-muted text-muted-foreground",
    label: "对话",
    title: "没挂在待办上的对话",
  },
}

// Groups beyond this many rows fold their tail into one line.
const SHOW = 4

// Which rows are open, and which folded groups are, for as long as the page is.
const open = new Set<string>()
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
function setOpen(key: string, on: boolean) {
  if (open.has(key) === on) return
  if (on) open.add(key)
  else open.delete(key)
  for (const listener of [...listeners]) listener()
}
function useOpen(key: string) {
  return useSyncExternalStore(
    subscribe,
    () => open.has(key),
    () => false,
  )
}

async function reopenDeputy(taskId: string) {
  try {
    await api("/api/v1/deputy", {
      method: "POST",
      body: JSON.stringify({ as: "human", action: "reopen", taskId }),
    })
    toast.success("已重开，回到等你验收")
    return true
  } catch (error) {
    toast.error(error instanceof Error ? error.message : "重开失败")
    return false
  }
}

async function review(taskId: string, pass: boolean, note: string) {
  try {
    await api(`/api/v1/tasks/${taskId}`, {
      method: "POST",
      body: JSON.stringify({ as: "human", action: pass ? "pass" : "reject", note }),
    })
    toast.success(pass ? "验收通过" : "打回了，已经叫醒负责人")
    return true
  } catch (error) {
    toast.error(error instanceof Error ? error.message : "没发出去")
    return false
  }
}

export function ProgressView({
  digest,
  agents,
  permits,
  messages,
  renderMessage,
  onOpenRun,
  onStop,
  onShowChat,
}: {
  digest: Digest
  agents: PublicAgent[]
  permits: PermitRequest[]
  messages: Message[]
  // One message of an opened row, drawn the way the thread draws it.
  renderMessage: (message: Message, previous: Message | undefined) => ReactNode
  onOpenRun: (runId: string) => void
  onStop?: (agent: PublicAgent) => void
  // A jump to a message no row holds: show it in the thread.
  onShowChat: (messageId: string) => void
}) {
  const now = useTick(30_000)
  const byId = useMemo(() => new Map(messages.map((message) => [message.id, message])), [messages])
  const groups = useRef<Partial<Record<DigestState, HTMLElement | null>>>({})
  const box = useRef<HTMLDivElement>(null)

  const rows = useMemo(() => [...digest.you, ...digest.stuck, ...digest.doing, ...digest.done, ...digest.talk], [digest])

  // Talk that comes in while the 「对话」 group is folded: a quiet pill, not a
  // jump of the page. Counted from when this page was opened.
  const talkOpen = useOpen("group:talk")
  const [seen] = useState(() => new Set(digest.talk.flatMap((row) => row.messageIds)))
  const fresh = digest.talk.flatMap((row) => row.messageIds).filter((id) => !seen.has(id)).length

  // A message or to-do id clicked somewhere: open the row that holds it and
  // bring it to the middle; a message no row holds is shown in the thread.
  useEffect(() => {
    const onGoto = (event: Event) => {
      const { kind, id } = (event as CustomEvent<Goto>).detail
      const row = rows.find((item) => (kind === "task" ? item.id === id : item.id === id || item.messageIds.includes(id)))
      if (!row) {
        if (kind === "message") onShowChat(id)
        return
      }
      setOpen(`row:${row.id}`, true)
      // A group folded behind 「还有 N 件」 or on one line opens too.
      setOpen(`more:${row.state}`, true)
      setOpen(`group:${row.state}`, true)
      const find = (tries: number) => {
        const target = box.current?.querySelector<HTMLElement>(
          kind === "message" && row.id !== id ? `[data-pmessage="${CSS.escape(id)}"]` : `[data-row="${CSS.escape(row.id)}"]`,
        )
        if (target) {
          target.scrollIntoView({ block: "center", behavior: "smooth" })
          target.animate(
            [
              { outline: "2px solid color-mix(in oklab, var(--color-mention, #3b82f6) 85%, transparent)", outlineOffset: "3px" },
              { outline: "2px solid transparent", outlineOffset: "3px" },
            ],
            { duration: 1800, delay: 250, easing: "ease-out" },
          )
        } else if (tries > 0) requestAnimationFrame(() => find(tries - 1))
      }
      requestAnimationFrame(() => find(30))
    }
    window.addEventListener(GOTO_EVENT, onGoto)
    return () => window.removeEventListener(GOTO_EVENT, onGoto)
  }, [rows, onShowChat])

  const jump = (state: DigestState) => {
    setOpen(`group:${state}`, true)
    requestAnimationFrame(() => groups.current[state]?.scrollIntoView({ block: "start", behavior: "smooth" }))
  }

  const empty = rows.length === 0
  const order: DigestState[] = ["you", "stuck", "doing", "done", "talk"]
  return (
    <div ref={box} className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-4 px-4 pt-14 pb-[calc(var(--dock,8rem)+7rem)] md:px-6" data-dock="padding-bottom 7rem">
        <div className="flex flex-wrap items-center gap-2" role="list" aria-label="现在的情况">
          {(["you", "stuck", "doing", "done"] as const).map((state) => (
            <button
              key={state}
              type="button"
              role="listitem"
              className={`flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-opacity ${LOOK[state].chip} ${
                digest.counts[state] === 0 ? "opacity-55" : "hover:opacity-80"
              }`}
              disabled={digest.counts[state] === 0}
              onClick={() => jump(state)}
            >
              {LOOK[state].label}
              <span className="text-sm font-semibold tabular-nums">{digest.counts[state]}</span>
            </button>
          ))}
        </div>
        {fresh > 0 && !talkOpen ? (
          <button
            type="button"
            className="self-start rounded-full border bg-card/80 px-3 py-1 text-[0.6875rem] text-muted-foreground hover:text-foreground"
            onClick={() => {
              jump("talk")
            }}
          >
            对话里有 {fresh} 条新的
          </button>
        ) : null}
        {empty ? (
          <p className="rounded-2xl border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
            还没有待办，也没有对话。在底下说一句，或点「对话」看群聊。
          </p>
        ) : null}
        {order.map((state) => {
          const list = digest[state]
          if (list.length === 0) return null
          return (
            <Group
              key={state}
              state={state}
              list={list}
              attach={(node) => {
                groups.current[state] = node
              }}
              rowOf={(row) => (
                <Row
                  key={row.id}
                  row={row}
                  agents={agents}
                  permits={permits}
                  byId={byId}
                  now={now}
                  renderMessage={renderMessage}
                  onOpenRun={onOpenRun}
                  onStop={onStop}
                />
              )}
            />
          )
        })}
      </div>
    </div>
  )
}

// One group. 「今天做完」 and 「对话」 start folded to one line; a group with
// more than SHOW rows folds the rest behind 「还有 N 件」.
function Group({
  state,
  list,
  attach,
  rowOf,
}: {
  state: DigestState
  list: DigestRow[]
  attach: (node: HTMLElement | null) => void
  rowOf: (row: DigestRow) => ReactNode
}) {
  const quiet = state === "done" || state === "talk"
  const opened = useOpen(`group:${state}`)
  const more = useOpen(`more:${state}`)
  const look = LOOK[state]
  const head = list.slice(0, SHOW)
  const tail = list.slice(SHOW)
  return (
    <section ref={attach} aria-label={look.title} className="scroll-mt-12">
      <h3 className="mb-1.5 flex items-center gap-2 text-xs text-muted-foreground">
        <span className={`size-1.5 rounded-full ${look.stripe}`} />
        <span className="font-medium text-foreground">{look.title}</span>
        <span className="tabular-nums">{list.length}</span>
      </h3>
      {quiet ? (
        <>
          <Reveal open={!opened}>
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-xl border bg-card/70 px-3 py-2 text-left text-xs text-muted-foreground hover:bg-card hover:text-foreground"
              onClick={() => setOpen(`group:${state}`, true)}
            >
              <span className="min-w-0 flex-1 truncate">
                {state === "done" ? "✓ " : ""}
                {list.map((row) => row.title).join(" · ")}
              </span>
              <ChevronDown className="size-3.5 shrink-0" />
            </button>
          </Reveal>
          <Reveal open={opened}>
            <div className="flex flex-col gap-2">
              {list.map(rowOf)}
              <button
                type="button"
                className="self-end rounded-md px-1 text-[0.6875rem] text-muted-foreground hover:bg-muted hover:text-foreground"
                onClick={() => setOpen(`group:${state}`, false)}
              >
                收起
              </button>
            </div>
          </Reveal>
        </>
      ) : (
        <div className="flex flex-col gap-2">
          {head.map(rowOf)}
          {tail.length > 0 ? (
            <>
              <Reveal open={!more}>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded-xl border border-dashed px-3 py-1.5 text-left text-xs text-muted-foreground hover:bg-card/70 hover:text-foreground"
                  onClick={() => setOpen(`more:${state}`, true)}
                >
                  <span className="min-w-0 flex-1 truncate">
                    还有 {tail.length} 件：{tail.map((row) => row.title).join(" · ")}
                  </span>
                  <ChevronDown className="size-3.5 shrink-0" />
                </button>
              </Reveal>
              <Reveal open={more}>
                <div className="flex flex-col gap-2">{tail.map(rowOf)}</div>
              </Reveal>
            </>
          ) : null}
        </div>
      )}
    </section>
  )
}

function Row({
  row,
  agents,
  permits,
  byId,
  now,
  renderMessage,
  onOpenRun,
  onStop,
}: {
  row: DigestRow
  agents: PublicAgent[]
  permits: PermitRequest[]
  byId: Map<string, Message>
  now: number
  renderMessage: (message: Message, previous: Message | undefined) => ReactNode
  onOpenRun: (runId: string) => void
  onStop?: (agent: PublicAgent) => void
}) {
  const key = `row:${row.id}`
  const opened = useOpen(key)
  const look = LOOK[row.state]
  const node = useRef<HTMLElement>(null)
  const owner = row.owner ? agents.find((agent) => agent.id === row.owner?.id) : undefined
  const [rejecting, setRejecting] = useState(false)
  const [reason, setReason] = useState("")
  const [busy, setBusy] = useState(false)
  const messages = useMemo(
    () => row.messageIds.map((id) => byId.get(id)).filter((message): message is Message => Boolean(message)),
    [row.messageIds, byId],
  )
  const asking = row.need === "answer" ? (messages.find((message) => message.id === row.askId) ?? byId.get(row.askId ?? "")) : undefined
  const permit = row.need === "permit" ? permits.find((item) => item.id === row.permitId) : undefined
  const toggle = () => {
    setOpen(key, !opened)
    keepTopInView(node.current)
  }
  const steps = row.steps
  const percent = steps && steps.total > 0 ? Math.round((steps.done / steps.total) * 100) : 0

  return (
    <article
      ref={node}
      data-row={row.id}
      className="relative overflow-hidden rounded-xl border bg-card/85 shadow-[0_1px_2px_rgb(0_0_0/0.05)]"
    >
      <span className={`absolute inset-y-0 left-0 w-1 ${look.stripe}`} aria-hidden />
      <div className="flex items-start gap-3 py-2.5 pr-3 pl-4">
        <button
          type="button"
          className="min-w-0 flex-1 cursor-pointer rounded-md text-left outline-offset-4"
          aria-expanded={opened}
          onClick={toggle}
        >
          <span className="flex items-center gap-1.5 text-sm font-semibold">
            <span className="min-w-0 truncate">{row.title}</span>
            {row.deputy ? (
              <span className="shrink-0 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[0.625rem] leading-4 font-medium text-emerald-700 dark:text-emerald-300">
                前台代签
              </span>
            ) : null}
          </span>
          <span className="mt-0.5 line-clamp-2 text-xs leading-5 text-muted-foreground">
            {row.owner ? <span className="font-medium text-foreground/80">{row.owner.name}</span> : null}
            {row.owner ? " · " : ""}
            {row.line}
          </span>
          <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[0.6875rem] text-muted-foreground/90">
            {row.since ? <span>停了 {ago(row.since, now).replace("前", "")}</span> : <span>{clock(row.at)}</span>}
            {row.attachments > 0 ? <span>附 {row.attachments} 个</span> : null}
            {row.messageIds.length > 0 ? <span>{row.messageIds.length} 条对话</span> : null}
            {row.check ? <span>{CHECK[row.check.state] ?? row.check.state}</span> : null}
            {row.deputy?.checkName || row.check?.name ? (
              <span>检查人 {row.deputy?.checkName ?? row.check?.name}</span>
            ) : null}
          </span>
        </button>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          {steps ? (
            <span className="flex items-center gap-1.5 text-[0.6875rem] text-muted-foreground tabular-nums" title={steps.current ? `现在：${steps.current}` : undefined}>
              <span className="h-1 w-14 overflow-hidden rounded-full bg-foreground/10">
                <span className={`block h-full origin-left rounded-full ${look.stripe}`} style={{ width: `${percent}%` }} />
              </span>
              {steps.done}/{steps.total}
            </span>
          ) : null}
          <div className="flex items-center gap-1">
            {row.state === "done" && row.deputy ? (
              <Button
                type="button"
                size="xs"
                variant="outline"
                disabled={busy}
                title="撤销代签，回到等你验收"
                onClick={async () => {
                  setBusy(true)
                  await reopenDeputy(row.id)
                  setBusy(false)
                }}
              >
                <RotateCcw className="size-3" />
                重开
              </Button>
            ) : null}
            {row.need === "review" && !rejecting ? (
              <>
                <Button
                  type="button"
                  size="xs"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true)
                    await review(row.id, true, "")
                    setBusy(false)
                  }}
                >
                  <Check className="size-3" />
                  通过
                </Button>
                <Button type="button" size="xs" variant="outline" disabled={busy} onClick={() => setRejecting(true)}>
                  打回
                </Button>
              </>
            ) : null}
            {row.state === "stuck" && owner?.owes && owner.callable ? (
              <Button type="button" size="xs" variant="outline" title="以你的名义在群里 @ 它，带上这几件事" onClick={() => void nudgeSeat(owner)}>
                叫它接着做
              </Button>
            ) : null}
            {row.state === "doing" && owner?.runId ? (
              <>
                <Button type="button" size="xs" variant="ghost" onClick={() => owner.runId && onOpenRun(owner.runId)}>
                  <Loader2 className="size-3 animate-spin" />
                  过程
                </Button>
                {onStop ? (
                  <Button type="button" size="xs" variant="ghost" title="停止：停掉这次叫醒，排在后面的也一起取消" aria-label={`停下 ${owner.name}`} onClick={() => onStop(owner)}>
                    <Square className="size-2.5 fill-current" />
                  </Button>
                ) : null}
              </>
            ) : null}
          </div>
        </div>
      </div>
      {rejecting ? (
        <form
          className="space-y-1.5 border-t px-4 py-2"
          onSubmit={async (event) => {
            event.preventDefault()
            if (!reason.trim()) return
            setBusy(true)
            const done = await review(row.id, false, reason.trim())
            setBusy(false)
            if (done) {
              setRejecting(false)
              setReason("")
            }
          }}
        >
          <Textarea
            autoFocus
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder={`哪里不对？会转给 ${row.owner?.name ?? "负责人"}，它照着改`}
            aria-label="打回原因"
            rows={2}
            className="min-h-0 resize-none bg-background/60 text-xs"
          />
          <div className="flex gap-1">
            <Button type="submit" size="xs" variant="destructive" disabled={busy || !reason.trim()}>
              打回
            </Button>
            <Button type="button" size="xs" variant="ghost" onClick={() => setRejecting(false)}>
              取消
            </Button>
          </div>
        </form>
      ) : null}
      {/* Questions and permissions are the thing itself: shown whether or not the row is open. */}
      {asking ? <div className="border-t px-4 pb-2">{askBlock(asking)}</div> : null}
      {permit ? (
        <div className="border-t px-3 py-2">
          <PermitCard item={permit} />
        </div>
      ) : null}
      <Reveal open={opened}>
        <div className="border-t bg-background/40">
          {row.deputy ? (
            <div className="border-b border-foreground/[0.06] bg-emerald-500/[0.06] px-4 py-2 text-xs leading-5">
              <p className="font-medium text-emerald-800 dark:text-emerald-200">
                前台代签
                {row.deputy.checkName ?? row.check?.name ? (
                  <span className="font-normal text-muted-foreground"> · 检查人：{row.deputy.checkName ?? row.check?.name}</span>
                ) : null}
              </p>
              <p className="text-foreground/85">原因：{plainCheckText(row.deputy.why)}</p>
            </div>
          ) : null}
          {messages.length === 0 ? (
            <p className="px-4 py-3 text-xs text-muted-foreground">这件事还没有对话。</p>
          ) : (
            messages.map((message, index) => (
              <div key={message.id} data-pmessage={message.id}>
                {renderMessage(message, messages[index - 1])}
              </div>
            ))
          )}
        </div>
      </Reveal>
    </article>
  )
}

function askBlock(message: Message) {
  return (
    <>
      <p className="mt-2 text-xs leading-5 text-muted-foreground">
        <MessageCircle className="mr-1 inline size-3" />
        {message.authorName}：{gistOf(message.text) ?? message.text}
      </p>
      <AskCard message={message} />
    </>
  )
}

const CHECK: Record<string, string> = {
  queued: "检查排着",
  running: "检查中",
  passed: "查过，没问题",
  failed: "查出问题",
  unverified: "没查出结论",
  skipped: "没检查",
  error: "检查没跑成",
}

// 「你刚说的」: over the composer on the progress page, so a line you send does
// not seem to vanish: who it called, what became of each call, and the one
// line they answered with. It fades once the line belongs to a to-do's row
// (or after five minutes).
export function JustSaid({
  messages,
  agents,
  digest,
  onOpenRun,
}: {
  messages: Message[]
  agents: PublicAgent[]
  digest: Digest
  onOpenRun?: (runId: string) => void
}) {
  const now = useTick(15_000)
  const onRows = useMemo(() => {
    const ids = new Set<string>()
    for (const row of [...digest.you, ...digest.stuck, ...digest.doing, ...digest.done]) for (const id of row.messageIds) ids.add(id)
    return ids
  }, [digest])
  const mine = useMemo(
    () =>
      messages
        .filter((message) => message.authorId === "human" && message.kind === "chat" && !message.recalled && now - message.createdAt < 5 * 60_000 && !onRows.has(message.id))
        .slice(-2),
    [messages, now, onRows],
  )
  return (
    <Reveal open={mine.length > 0} className="flex flex-col gap-1.5 px-px pt-px pb-2">
      {mine.map((message) => {
        const answer = messages.find((item) => item.replyTo === message.id && item.authorId !== "human" && item.kind === "chat")
        const calls = message.calls ?? []
        return (
          <div key={message.id} className="notice rounded-2xl px-3 py-1.5 text-xs">
            <p className="flex items-baseline gap-1.5 text-muted-foreground">
              <span className="shrink-0 font-medium text-foreground">你刚说的</span>
              <span className="min-w-0 truncate">{message.text.replace(/\s+/g, " ")}</span>
            </p>
            <p className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-[0.6875rem] text-muted-foreground">
              {calls.map((call) => {
                const isFailed = call.state === "failed"
                const label = `${call.name} · ${CALL[call.state] ?? call.state}${
                  isFailed && call.note ? `（${call.note.length > 40 ? `${call.note.slice(0, 40)}…` : call.note}）` : ""
                }`
                if (onOpenRun && call.runId) {
                  return (
                    <button
                      key={call.id}
                      type="button"
                      onClick={() => call.runId && onOpenRun(call.runId)}
                      className={`shrink-0 cursor-pointer underline decoration-current/35 underline-offset-2 hover:decoration-current ${
                        isFailed ? "text-red-600 dark:text-red-400" : call.state === "retrying" ? "text-amber-700 dark:text-amber-300" : ""
                      }`}
                      title={[call.note, "点击查看过程"].filter(Boolean).join(" · ")}
                    >
                      {label}
                    </button>
                  )
                }
                return (
                  <span key={call.id} className={`shrink-0 ${isFailed ? "text-red-600 dark:text-red-400" : ""}`} title={call.note}>
                    {label}
                  </span>
                )
              })}
              {answer ? (
                <span className="min-w-0 truncate text-foreground">
                  {answer.authorName}：{answer.gist?.text ?? gistOf(answer.text) ?? answer.text.replace(/\s+/g, " ").slice(0, 80)}
                </span>
              ) : agents.some((agent) => calls.some((call) => call.id === agent.id && agent.runId)) ? (
                <span className="flex items-center gap-1 text-sky-700 dark:text-sky-300">
                  <Loader2 className="size-3 animate-spin" />
                  正在回
                </span>
              ) : null}
            </p>
          </div>
        )
      })}
    </Reveal>
  )
}

const CALL: Record<string, string> = {
  queued: "排着队",
  held: "已送到",
  started: "开始了",
  picked: "在做",
  answered: "已回答",
  silent: "跑完了没说话",
  retrying: "重试中",
  failed: "没叫成",
  stopped: "你停了",
  cut: "中途断了",
  dropped: "撤掉了",
}
