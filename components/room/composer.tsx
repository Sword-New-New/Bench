import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { File, Folder, Paperclip, Send, X } from "lucide-react"
import { toast } from "sonner"

import { PendingFiles, pickPaths, previewText, uploadFile, type Pending } from "@/components/room/attachments"
import { Avatar, seatLook } from "@/components/room/bits"
import { Reveal } from "@/components/room/reveal"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { SLASH_COMMANDS, parseSlash } from "@/lib/commands"
import { KINDS, kindOf } from "@/lib/kinds"
import { escapeRegExp, insertMention, unknownMentions } from "@/lib/text"
import type { Message, PublicAgent } from "@/lib/types"

export const DOCK_EVENT = "bench-dock"

function hasMention(text: string, name: string) {
  return new RegExp(`@${escapeRegExp(name)}(?![\\p{L}\\p{N}_-])`, "u").test(text)
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
  files,
  onFiles,
  speakers = [],
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
  // Attachments going out with the next message.
  files: Pending[]
  onFiles: (update: (current: Pending[]) => Pending[]) => void
  // Seat ids that spoke in the room, latest first (one each).
  speakers?: string[]
}) {
  const [picked, setPicked] = useState(false)
  const [dragging, setDragging] = useState(false)
  const chips = useChipOrder()
  // The (up to) three chips of whoever spoke last, taken when you click into
  // the input to type, and kept while you do so the row doesn't move under you.
  const [recent, setRecent] = useState<string[]>([])
  const uploading = files.some((item) => item.uploading)

  // Pasted or dropped: shown at once, then swapped for the saved copy.
  function addBlobs(list: FileList | File[]) {
    for (const file of Array.from(list)) {
      const key = `uploading:${Math.random().toString(36).slice(2)}`
      const preview = file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined
      onFiles((current) => [
        ...current,
        { kind: preview ? "image" : "file", name: file.name || "粘贴的图片", path: key, size: file.size, preview, uploading: true },
      ])
      uploadFile(file)
        .then((saved) => onFiles((current) => current.map((item) => (item.path === key ? { ...saved, preview } : item))))
        .catch((error: unknown) => {
          onFiles((current) => current.filter((item) => item.path !== key))
          toast.error(error instanceof Error ? error.message : "没传上")
        })
    }
    inputRef.current?.focus()
  }

  function pick(kind: "files" | "dirs") {
    pickPaths(kind)
      .then((chosen) => {
        if (chosen.length) onFiles((current) => [...current, ...chosen])
        inputRef.current?.focus()
      })
      .catch((error: unknown) => toast.error(error instanceof Error ? error.message : "没打开选择窗口"))
  }
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
  // Typing a command's name at the very start: the commands that fit.
  // (After any @s in front of it, too.)
  const slashQuery = value.match(/^(?:@\S+\s+)*\/([a-z]*)$/)?.[1] ?? null
  const slashMatches =
    slashQuery === null ? [] : SLASH_COMMANDS.filter((item) => item.name.startsWith(slashQuery) && item.name !== slashQuery)
  const slash = parseSlash(
    value,
    agents.map((agent) => agent.name),
  )
  const unknown = unknownMentions(
    value,
    agents.map((agent) => agent.name),
  )

  // Quick targets: every seat that is online or can be woken, so two sessions
  // of the same kind are two chips; a kind with none of those still gets its
  // first seat. A kind with one chip reads as the kind, several by seat name.
  const targets = KINDS.flatMap((kind) => {
    const seats = agents.filter((agent) => kindOf(agent)?.id === kind.id)
    const reachable = seats.filter((agent) => agent.status !== "offline" || agent.callable)
    const picked = reachable.length > 0 ? reachable : seats.slice(0, 1)
    return picked.map((seat) => ({ kind, seat, label: picked.length > 1 ? seat.name : kind.label }))
  })
  const ordered = upFront(chips.sort(targets), recent)

  function insertCommand(name: string) {
    onChange(value.replace(/\/[a-z]*$/, `/${name} `))
    inputRef.current?.focus()
  }

  function insert(name: string) {
    onChange(value.replace(/@([\p{L}\p{N}_-]*)$/u, `@${name} `))
    setPicked(true)
    inputRef.current?.focus()
  }

  // A name under the input goes in where the caret is, not at the front. The
  // text comes back through `value`, so the caret is put after the name once
  // that has rendered.
  const caret = useRef<number | null>(null)
  useLayoutEffect(() => {
    if (caret.current === null) return
    inputRef.current?.setSelectionRange(caret.current, caret.current)
    caret.current = null
  }, [value, inputRef])

  function mention(name: string) {
    const input = inputRef.current
    // An input that was never clicked into has its caret at the end.
    const start = input?.selectionStart ?? value.length
    const next = insertMention(value, name, start, input?.selectionEnd ?? start)
    caret.current = next.caret
    onChange(next.text)
    input?.focus()
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
        className={`raised mx-auto max-w-3xl rounded-[22px] transition-shadow focus-within:ring-3 focus-within:ring-ring/20 ${
          dragging ? "ring-3 ring-primary/40" : ""
        }`}
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes("Files")) return
          event.preventDefault()
          setDragging(true)
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false)
        }}
        onDrop={(event) => {
          if (!event.dataTransfer.files.length) return
          event.preventDefault()
          setDragging(false)
          addBlobs(event.dataTransfer.files)
        }}
      >
        <Reveal open={reply !== null}>
          {reply ? (
            <div className="flex items-center gap-2 border-b border-foreground/8 px-3.5 py-2 text-xs text-muted-foreground">
              <span className="min-w-0 flex-1 truncate">
                回复 <span className="font-medium text-foreground">{reply.authorName}</span>：{previewText(reply)}
              </span>
              {agents.some((agent) => agent.id === reply.authorId) ? (
                <span className="shrink-0 text-[11px]">发出去就会叫醒它，不用 @</span>
              ) : null}
              <button type="button" className="rounded p-0.5 hover:bg-muted" onClick={onClearReply} aria-label="取消回复">
                <X className="size-3.5" />
              </button>
            </div>
          ) : null}
        </Reveal>
        <Reveal open={slashMatches.length > 0}>
          <div className="flex flex-col gap-0.5 border-b border-foreground/8 px-2 py-2">
            {slashMatches.map((item) => (
              <button
                key={item.name}
                type="button"
                className="flex items-baseline gap-2 rounded-lg px-2 py-1 text-left text-xs hover:bg-foreground/6"
                onClick={() => insertCommand(item.name)}
              >
                <span className="font-mono font-medium">/{item.name}</span>
                {item.hint ? <span className="font-mono text-muted-foreground">{item.hint}</span> : null}
                <span className="min-w-0 flex-1 truncate text-right text-muted-foreground">{item.about}</span>
              </button>
            ))}
          </div>
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
        <PendingFiles
          files={files}
          onRemove={(index) =>
            onFiles((current) => {
              const gone = current[index]
              if (gone?.preview) URL.revokeObjectURL(gone.preview)
              return current.filter((_, at) => at !== index)
            })
          }
        />
        <Label htmlFor="composer" className="sr-only">
          发给房间
        </Label>
        <Textarea
          ref={inputRef}
          id="composer"
          value={value}
          placeholder={dragging ? "松手就附上" : "说点什么，@ 谁就唤起谁 · / 是命令 · 可以粘贴图片、拖文件进来 · Enter 发送"}
          className="max-h-60 min-h-14 resize-none border-0 bg-transparent px-4 pt-3.5 shadow-none placeholder:text-foreground/45 focus-visible:ring-0 dark:bg-transparent"
          onFocus={() => {
            const ids = new Set(targets.map((item) => item.seat.id))
            const next = speakers.filter((id) => ids.has(id)).slice(0, RECENT_UP_FRONT)
            setRecent((current) => (current.join() === next.join() ? current : next))
          }}
          onChange={(event) => {
            setPicked(false)
            onChange(event.target.value)
          }}
          onPaste={(event) => {
            if (!event.clipboardData.files.length) return
            event.preventDefault()
            addBlobs(event.clipboardData.files)
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              if (slashMatches.length > 0) {
                insertCommand(slashMatches[0].name)
                return
              }
              if (matches.length > 0 && !picked) {
                insert(matches[0].name)
                return
              }
              onSend()
            }
          }}
        />
        <div className="flex items-center gap-2 px-2 pb-2">
          <DropdownMenu>
            <DropdownMenuTrigger
              className="grid size-8 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/6 hover:text-foreground aria-expanded:bg-foreground/6"
              aria-label="附上文件或文件夹"
              title="附上文件或文件夹，也可以直接粘贴图片、拖文件进来"
            >
              <Paperclip className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" side="top" className="min-w-40">
              <DropdownMenuItem onClick={() => pick("files")}>
                <File />
                选文件…
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => pick("dirs")}>
                <Folder />
                选文件夹…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <div className="-my-1.5 flex min-w-0 flex-1 items-center overflow-x-auto py-1.5">
            <span className="shrink-0 px-1 text-xs text-muted-foreground">发给</span>
            {ordered.map(({ kind, seat, label }) => (
              <Pick
                key={seat.id}
                gone={hasMention(value, seat.name)}
                title={`@${seat.name} · 拖动可以换位置`}
                lifted={chips.draggingId === seat.id}
                slotRef={chips.slot(seat.id)}
                dragHandlers={chips.handlers(seat.id, ordered.map((item) => item.seat.id))}
                onPick={() => {
                  if (chips.justDragged()) return
                  mention(seat.name)
                }}
              >
                <span className="size-1.5 rounded-full" style={{ background: kind.color }} />
                {label}
              </Pick>
            ))}
            {agents.length > 1 ? (
              <Pick
                gone={hasMention(value, "所有人")}
                title="@所有人"
                onPick={() => mention("所有人")}
              >
                所有人
              </Pick>
            ) : null}
            {targets.length === 0 && agents.length <= 1 ? (
              <span className="truncate text-xs text-muted-foreground">还没有 AI 入座 · Enter 发送</span>
            ) : null}
          </div>
          <Button
            type="submit"
            size="icon"
            className="rounded-full shadow-[inset_0_1px_0_0_rgb(255_255_255/0.25)]"
            disabled={busy || uploading || (value.trim().length === 0 && files.length === 0)}
            aria-label="发送"
          >
            <Send />
          </Button>
        </div>
      </div>
      <Reveal open={slash !== null}>
        <p className="pill mx-auto mt-1.5 w-fit max-w-3xl rounded-full px-3 py-0.5 text-[11px] text-muted-foreground">
          {slash === null
            ? null
            : slash.targets.length === 0
              ? `/${slash.command.name} 要发给谁？@ 一个席位，或点下面的名字`
              : slash.command.needsText && !slash.text
                ? `/${slash.command.name} 后面写上${slash.command.hint}`
                : `/${slash.command.name} 只发给 ${slash.targets.join("、")}，不进群聊`}
        </p>
      </Reveal>
      <Reveal open={unknown.length > 0}>
        <p className="pill mx-auto mt-1.5 w-fit max-w-3xl rounded-full px-3 py-0.5 text-[11px] text-amber-700 dark:text-amber-300">
          房间里还没有 {unknown.map((name) => `@${name}`).join("、")}，这句不会叫醒谁
        </p>
      </Reveal>
    </form>
  )
}

// One quick-mention chip. Nobody gets @'d twice in one message, so once its
// name is in the draft it shrinks away and the chips after it slide over;
// taking the name back out of the text brings it back.
function Pick({
  gone,
  title,
  onPick,
  lifted,
  slotRef,
  dragHandlers,
  children,
}: {
  gone: boolean
  title: string
  onPick: () => void
  // Being dragged to a new place in the row.
  lifted?: boolean
  slotRef?: (node: HTMLDivElement | null) => void
  dragHandlers?: React.HTMLAttributes<HTMLButtonElement>
  children: React.ReactNode
}) {
  return (
    <div
      ref={slotRef}
      className={`grid shrink-0 transition-[grid-template-columns,opacity] duration-300 ease-[cubic-bezier(.2,.9,.3,1)] motion-reduce:transition-none ${
        gone ? "grid-cols-[0fr] opacity-0" : "grid-cols-[1fr] opacity-100"
      } ${lifted ? "relative z-10" : ""}`}
      inert={gone}
    >
      {/* Room above and below for the chip's shadow, which the collapse clips. */}
      <div className="-my-1 min-w-0 overflow-hidden py-1">
        <div className="pr-1 pl-0.5">
          <button
            type="button"
            title={title}
            className={`pill chip flex items-center gap-1 rounded-full px-2.5 py-1 text-xs whitespace-nowrap select-none ${
              dragHandlers ? "touch-pan-y" : ""
            } ${gone ? "scale-50" : lifted ? "scale-110 cursor-grabbing shadow-lg ring-2 ring-primary/40" : "scale-100"}`}
            onClick={onPick}
            {...dragHandlers}
          >
            {children}
          </button>
        </div>
      </div>
    </div>
  )
}

const ORDER_KEY = "bench-chip-order"
const RECENT_UP_FRONT = 3

// The given seats first, in that order; the rest keep theirs.
function upFront<T extends { seat: { id: string } }>(items: T[], ids: string[]) {
  if (ids.length === 0) return items
  const rank = (id: string) => {
    const index = ids.indexOf(id)
    return index < 0 ? ids.length : index
  }
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => rank(a.item.seat.id) - rank(b.item.seat.id) || a.index - b.index)
    .map(({ item }) => item)
}

// How far a slide in progress has moved a chip sideways.
function shiftOf(node: HTMLElement) {
  const transform = getComputedStyle(node).transform
  return transform && transform !== "none" ? new DOMMatrixReadOnly(transform).m41 : 0
}
const DRAG_START_PX = 6

function loadOrder(): string[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(ORDER_KEY) ?? "[]")
    return Array.isArray(saved) ? saved.filter((id): id is string => typeof id === "string") : []
  } catch {
    return []
  }
}

// The quick-mention chips in the order you dragged them into, kept in this
// browser by seat id (ids are unique across projects); seats it hasn't seen
// keep their place after the ones it has. Dragging a chip past another's
// middle swaps them, and the chips it passes slide over.
function useChipOrder() {
  // The chips only show once the room has loaded in the browser, so reading
  // storage up front can't disagree with the server's render.
  const [order, setOrder] = useState<string[]>(() => (typeof window === "undefined" ? [] : loadOrder()))
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const drag = useRef<{ id: string; x: number; moved: boolean } | null>(null)
  // The row's order as last rendered, which a drag reads as it moves.
  const current = useRef<string[]>([])
  const dropped = useRef(0)
  const slots = useRef(new Map<string, HTMLDivElement>())
  const lefts = useRef(new Map<string, number>())

  // Slide the chips that moved from where they were to where they are now.
  // Places are read from the layout (offsetLeft), which a slide in progress
  // doesn't shift; a chip still sliding from the last swap starts the next
  // slide from wherever it is on screen, so quick swaps never add up.
  useLayoutEffect(() => {
    for (const [id, node] of slots.current) {
      const now = node.offsetLeft
      const before = lefts.current.get(id)
      lefts.current.set(id, now)
      if (before === undefined || Math.abs(before - now) < 1) continue
      const from = before - now + shiftOf(node)
      node.style.transition = "none"
      node.style.transform = `translateX(${from}px)`
      void node.offsetWidth
      node.style.transition = "transform 200ms cubic-bezier(.2,.9,.3,1)"
      node.style.transform = ""
      const settle = () => {
        node.style.transition = ""
        node.removeEventListener("transitionend", settle)
      }
      node.addEventListener("transitionend", settle)
    }
  })

  function save(next: string[]) {
    try {
      localStorage.setItem(ORDER_KEY, JSON.stringify(next.slice(0, 200)))
    } catch {}
  }

  return {
    draggingId,
    sort<T extends { seat: { id: string } }>(items: T[]) {
      const rank = (id: string) => {
        const index = order.indexOf(id)
        return index < 0 ? Number.MAX_SAFE_INTEGER : index
      }
      return items
        .map((item, index) => ({ item, index }))
        .sort((a, b) => rank(a.item.seat.id) - rank(b.item.seat.id) || a.index - b.index)
        .map(({ item }) => item)
    },
    slot(id: string) {
      return (node: HTMLDivElement | null) => {
        if (node) slots.current.set(id, node)
        else slots.current.delete(id)
      }
    },
    // A drag ends with a click on the chip; that click isn't a pick.
    justDragged() {
      return Date.now() - dropped.current < 300
    },
    handlers(id: string, ids: string[]): React.HTMLAttributes<HTMLButtonElement> {
      current.current = ids
      return {
        onPointerDown(event) {
          if (event.button !== 0) return
          const start = { id, x: event.clientX, moved: false }
          drag.current = start
          // Listened to on the window: a chip moved to a new place in the row
          // is a node React moved, which loses any pointer capture.
          const move = (moved: PointerEvent) => {
            if (!start.moved) {
              if (Math.abs(moved.clientX - start.x) < DRAG_START_PX) return
              start.moved = true
              setDraggingId(id)
            }
            const now = current.current
            const others = now.filter((other) => other !== id)
            const at = others.filter((other) => {
              const node = slots.current.get(other)
              if (!node) return false
              // Where it sits in the row, not where a slide has it right now.
              const box = node.getBoundingClientRect()
              return box.width > 0 && box.left - shiftOf(node) + box.width / 2 < moved.clientX
            }).length
            const next = [...others.slice(0, at), id, ...others.slice(at)]
            if (next.join() === now.join()) return
            current.current = next
            setOrder((old) => [...next, ...old.filter((other) => !next.includes(other))])
          }
          const end = (finished: Event) => {
            window.removeEventListener("pointermove", move)
            window.removeEventListener("pointerup", end)
            window.removeEventListener("pointercancel", end)
            drag.current = null
            if (!start.moved) return
            setDraggingId(null)
            if (finished.type === "pointercancel") return
            dropped.current = Date.now()
            setOrder((old) => {
              save(old)
              return old
            })
          }
          window.addEventListener("pointermove", move)
          window.addEventListener("pointerup", end)
          window.addEventListener("pointercancel", end)
        },
      }
    },
  }
}
