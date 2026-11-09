import { useEffect, useMemo, useRef, useState } from "react"
import { File, Folder, Paperclip, Send, X } from "lucide-react"
import { toast } from "sonner"

import { PendingFiles, pickPaths, previewText, uploadFile, type Pending } from "@/components/room/attachments"
import { Avatar, seatLook } from "@/components/room/bits"
import { Reveal } from "@/components/room/reveal"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
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
  files,
  onFiles,
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
}) {
  const [picked, setPicked] = useState(false)
  const [dragging, setDragging] = useState(false)
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
          placeholder={dragging ? "松手就附上" : "说点什么，@ 谁就唤起谁 · 可以粘贴图片、拖文件进来 · Enter 发送"}
          className="max-h-60 min-h-14 resize-none border-0 bg-transparent px-4 pt-3.5 shadow-none placeholder:text-foreground/45 focus-visible:ring-0 dark:bg-transparent"
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
            {targets.map(({ kind, seat, label }) => (
              <Pick
                key={seat.id}
                gone={hasMention(value, seat.name)}
                title={`@${seat.name}`}
                onPick={() => {
                  onChange(toggleMention(value, seat.name))
                  inputRef.current?.focus()
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
                onPick={() => {
                  onChange(toggleMention(value, "所有人"))
                  inputRef.current?.focus()
                }}
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
  children,
}: {
  gone: boolean
  title: string
  onPick: () => void
  children: React.ReactNode
}) {
  return (
    <div
      className={`grid shrink-0 transition-[grid-template-columns,opacity] duration-300 ease-[cubic-bezier(.2,.9,.3,1)] motion-reduce:transition-none ${
        gone ? "grid-cols-[0fr] opacity-0" : "grid-cols-[1fr] opacity-100"
      }`}
      inert={gone}
    >
      {/* Room above and below for the chip's shadow, which the collapse clips. */}
      <div className="-my-1 min-w-0 overflow-hidden py-1">
        <div className="pr-1 pl-0.5">
          <button
            type="button"
            title={title}
            className={`pill chip flex items-center gap-1 rounded-full px-2.5 py-1 text-xs whitespace-nowrap ${
              gone ? "scale-50" : "scale-100"
            }`}
            onClick={onPick}
          >
            {children}
          </button>
        </div>
      </div>
    </div>
  )
}
