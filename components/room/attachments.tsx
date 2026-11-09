"use client"

import { useEffect, useState } from "react"
import { createPortal } from "react-dom"
import { ChevronLeft, ChevronRight, Copy, Download, File, Folder, Loader2, RotateCcw, RotateCw, X } from "lucide-react"

import { api, inOpenProject } from "@/components/room/api"
import type { Attachment } from "@/lib/types"

// Files, folders and images going out with a message. Picked from disk they
// travel as their own path; pasted or dropped, the room saves a copy first
// (app/api/v1/files) and the message carries that.

export type Pending = Attachment & {
  // A pasted image shows from memory before it is sent.
  preview?: string
  uploading?: boolean
}

const UPLOAD_LIMIT = 25 * 1024 * 1024
const IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp|avif)$/i

function base64(file: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""))
    reader.onerror = () => reject(reader.error ?? new Error("读不出这个文件"))
    reader.readAsDataURL(file)
  })
}

export async function uploadFile(file: File) {
  if (file.size > UPLOAD_LIMIT) throw new Error(`${file.name} 超过 25 MB，请用回形针从磁盘选，房间只传路径`)
  const name = file.name || (file.type.startsWith("image/") ? `粘贴的图片.${file.type.split("/")[1] ?? "png"}` : "粘贴的文件")
  const result = await api<{ attachment: Attachment }>("/api/v1/files", {
    method: "POST",
    body: JSON.stringify({ as: "human", name, type: file.type, data: await base64(file) }),
  })
  return result.attachment
}

// The desktop's own picker; the room answers with full paths.
export async function pickPaths(pick: "files" | "dirs"): Promise<Pending[]> {
  const result = await api<{ paths: string[] }>("/api/v1/folder", {
    method: "POST",
    body: JSON.stringify({ as: "human", pick }),
  })
  return result.paths.map((file) => ({
    kind: pick === "dirs" ? "dir" : IMAGE_RE.test(file) ? "image" : "file",
    name: file.split("/").filter(Boolean).pop() ?? file,
    path: file,
  }))
}

// One line for a message in a reply preview; one with only attachments says
// what they are.
export function previewText(message: { text: string; attachments?: Attachment[] }) {
  if (message.text.trim()) return message.text
  const first = message.attachments?.[0]
  if (!first) return ""
  const label = first.kind === "image" ? "[图片]" : first.kind === "dir" ? "[文件夹]" : "[文件]"
  const more = (message.attachments?.length ?? 0) > 1 ? ` 等 ${message.attachments?.length} 个` : ""
  return `${label} ${first.name}${more}`
}

export function imageUrl(file: string) {
  return inOpenProject(`/api/v1/files?path=${encodeURIComponent(file)}`)
}

function size(bytes?: number) {
  if (bytes === undefined) return ""
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function Icon({ kind }: { kind: Attachment["kind"] }) {
  const Shape = kind === "dir" ? Folder : File
  return <Shape className="size-4 shrink-0 text-muted-foreground" />
}

// In the composer, above the input: what will go out, each removable.
export function PendingFiles({ files, onRemove }: { files: Pending[]; onRemove: (index: number) => void }) {
  if (files.length === 0) return null
  return (
    <div className="flex flex-wrap gap-1.5 border-b border-foreground/8 px-3 py-2">
      {files.map((item, index) => (
        <span
          key={`${item.path}-${index}`}
          className="group/file relative flex max-w-56 items-center gap-1.5 rounded-xl border bg-background/60 py-1 pr-1.5 pl-1 text-xs"
          title={item.path}
        >
          {item.preview ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={item.preview} alt="" className="size-8 shrink-0 rounded-lg object-cover" />
          ) : (
            <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted">
              {item.uploading ? <Loader2 className="size-4 animate-spin text-muted-foreground" /> : <Icon kind={item.kind} />}
            </span>
          )}
          <span className="min-w-0">
            <span className="block truncate font-medium">{item.name}</span>
            <span className="block truncate text-[10px] text-muted-foreground">
              {item.uploading ? "在传…" : item.kind === "dir" ? "文件夹" : size(item.size) || "从磁盘选的"}
            </span>
          </span>
          <button
            type="button"
            className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={() => onRemove(index)}
            aria-label={`不发 ${item.name}`}
          >
            <X className="size-3.5" />
          </button>
        </span>
      ))}
    </div>
  )
}

// A picture opened over the page instead of in a new tab. Esc or a click
// outside closes it; the arrow keys step through the message's other images,
// R turns it (Shift+R the other way), and it can be saved as a file.
function ImageViewer({
  images,
  index,
  onIndex,
  onClose,
}: {
  images: Attachment[]
  index: number
  onIndex: (index: number) => void
  onClose: () => void
}) {
  const item = images[index]
  const many = images.length > 1
  // Each picture starts upright.
  const [turn, setTurn] = useState({ index, deg: 0 })
  const deg = turn.index === index ? turn.deg : 0
  const rotate = (by: number) => setTurn({ index, deg: deg + by })
  const sideways = Math.abs(deg / 90) % 2 === 1
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose()
      else if (event.key === "r" || event.key === "R") setTurn({ index, deg: deg + (event.shiftKey ? -90 : 90) })
      else if (event.key === "ArrowLeft" && many) onIndex((index - 1 + images.length) % images.length)
      else if (event.key === "ArrowRight" && many) onIndex((index + 1) % images.length)
    }
    const overflow = document.body.style.overflow
    document.body.style.overflow = "hidden"
    window.addEventListener("keydown", onKey)
    return () => {
      window.removeEventListener("keydown", onKey)
      document.body.style.overflow = overflow
    }
  }, [index, images.length, many, onIndex, onClose, deg])
  if (!item) return null
  const step = (by: number) => (event: React.MouseEvent) => {
    event.stopPropagation()
    onIndex((index + by + images.length) % images.length)
  }
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={item.name}
      className="fixed inset-0 z-[100] animate-in overflow-hidden bg-black/80 backdrop-blur-sm fade-in"
      onClick={onClose}
    >
      <button
        type="button"
        className="absolute top-3 right-3 z-10 rounded-full bg-white/10 p-2 text-white hover:bg-white/20"
        onClick={onClose}
        aria-label="关闭"
      >
        <X className="size-5" />
      </button>
      {many ? (
        <>
          <button
            type="button"
            className="absolute top-1/2 left-3 z-10 -translate-y-1/2 rounded-full bg-white/10 p-2 text-white hover:bg-white/20"
            onClick={step(-1)}
            aria-label="上一张"
          >
            <ChevronLeft className="size-6" />
          </button>
          <button
            type="button"
            className="absolute top-1/2 right-3 z-10 -translate-y-1/2 rounded-full bg-white/10 p-2 text-white hover:bg-white/20"
            onClick={step(1)}
            aria-label="下一张"
          >
            <ChevronRight className="size-6" />
          </button>
        </>
      ) : null}
      {/* The picture sits in its own layer, centred in the space above the
          toolbar; a rotation doesn't change its layout box, so the toolbar
          stays on top and clickable whichever way it is turned. */}
      <div className="pointer-events-none absolute inset-x-0 top-0 bottom-16 flex items-center justify-center">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={imageUrl(item.path)}
          alt={item.name}
          // Turned sideways, the picture's width runs up the screen.
          className={`pointer-events-auto rounded-lg object-contain shadow-2xl transition-transform duration-200 ${
            sideways ? "max-h-[88vw] max-w-[calc(100vh-7rem)]" : "max-h-[calc(100vh-7rem)] max-w-[88vw]"
          }`}
          style={{ transform: `rotate(${deg}deg)` }}
          onClick={(event) => event.stopPropagation()}
        />
      </div>
      <div
        className="absolute bottom-4 left-1/2 z-10 flex max-w-[92vw] -translate-x-1/2 items-center gap-2 rounded-full bg-black/60 px-3 py-1.5 text-xs text-white/85 ring-1 ring-white/10"
        onClick={(event) => event.stopPropagation()}
      >
        <span className="truncate">{item.name}</span>
        {many ? <span className="shrink-0 text-white/50">{index + 1} / {images.length}</span> : null}
        <button
          type="button"
          className="rounded-md p-1 hover:bg-white/10"
          onClick={() => rotate(-90)}
          title="向左转（Shift+R）"
          aria-label="向左转"
        >
          <RotateCcw className="size-4" />
        </button>
        <button
          type="button"
          className="rounded-md p-1 hover:bg-white/10"
          onClick={() => rotate(90)}
          title="向右转（R）"
          aria-label="向右转"
        >
          <RotateCw className="size-4" />
        </button>
        <a
          href={`${imageUrl(item.path)}&download=1`}
          download={item.name}
          className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-white/10"
          title="保存原图到本地"
        >
          <Download className="size-3" />
          保存
        </a>
        <button
          type="button"
          className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-white/10"
          onClick={() => void navigator.clipboard?.writeText(item.path)}
          title={item.path}
        >
          <Copy className="size-3" />
          复制路径
        </button>
      </div>
    </div>,
    document.body,
  )
}

// Under a message: images as pictures, files and folders as their path.
export function MessageFiles({ files, align = "start" }: { files: Attachment[]; align?: "start" | "end" }) {
  const images = files.filter((item) => item.kind === "image")
  const others = files.filter((item) => item.kind !== "image")
  const [viewing, setViewing] = useState<number | null>(null)
  return (
    <div className={`mt-1.5 flex flex-col gap-1.5 ${align === "end" ? "items-end" : "items-start"}`}>
      {images.length > 0 ? (
        <div className={`flex flex-wrap gap-1.5 ${align === "end" ? "justify-end" : ""}`}>
          {images.map((item, index) => (
            <button
              key={item.path}
              type="button"
              className="cursor-zoom-in rounded-xl"
              title={`查看 ${item.name}`}
              onClick={() => setViewing(index)}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={imageUrl(item.path)}
                alt={item.name}
                loading="lazy"
                className="max-h-56 max-w-[min(100%,20rem)] rounded-xl border object-cover"
              />
            </button>
          ))}
        </div>
      ) : null}
      {viewing !== null ? (
        <ImageViewer images={images} index={viewing} onIndex={setViewing} onClose={() => setViewing(null)} />
      ) : null}
      {others.map((item) => (
        <button
          key={item.path}
          type="button"
          className="flex max-w-full items-center gap-2 rounded-xl border bg-background/60 px-2.5 py-1.5 text-left text-xs hover:bg-muted"
          title="复制路径"
          onClick={() => void navigator.clipboard?.writeText(item.path)}
        >
          <Icon kind={item.kind} />
          <span className="min-w-0">
            <span className="block truncate font-medium">{item.name}</span>
            <span className="block truncate font-mono text-[10px] text-muted-foreground">{item.path}</span>
          </span>
          {item.size !== undefined ? <span className="shrink-0 text-[10px] text-muted-foreground">{size(item.size)}</span> : null}
        </button>
      ))}
    </div>
  )
}
