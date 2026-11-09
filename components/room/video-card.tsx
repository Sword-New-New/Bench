"use client"

import { useEffect, useRef, useState } from "react"
import { Copy, Download, Film, TriangleAlert } from "lucide-react"

import { inOpenProject } from "@/components/room/api"
import type { Attachment } from "@/lib/types"

// A video attached to a message, played in place with the browser's own
// controls (seek, volume, speed, full screen, picture-in-picture). The file
// comes from /api/v1/files, which answers byte ranges so seeking is instant.
// Starting one pauses any other video or sound that is playing.

// Shared with the audio card: one sound at a time across both.
const PLAYING = "bench-media-playing"

function clock(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return ""
  const whole = Math.round(seconds)
  const h = Math.floor(whole / 3600)
  const m = Math.floor((whole % 3600) / 60)
  const s = String(whole % 60).padStart(2, "0")
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`
}

function sizeOf(bytes?: number) {
  if (bytes === undefined) return ""
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function VideoCard({ item }: { item: Attachment }) {
  const video = useRef<HTMLVideoElement>(null)
  const [length, setLength] = useState<number>()
  const [broken, setBroken] = useState(false)
  const url = inOpenProject(`/api/v1/files?path=${encodeURIComponent(item.path)}`)

  useEffect(() => {
    const onOther = (event: Event) => {
      if ((event as CustomEvent).detail !== video.current) video.current?.pause()
    }
    window.addEventListener(PLAYING, onOther)
    return () => window.removeEventListener(PLAYING, onOther)
  }, [item.path])

  return (
    <figure className="w-[min(100%,22rem)] overflow-hidden rounded-2xl border bg-card shadow-sm">
      {broken ? (
        <div className="flex aspect-video flex-col items-center justify-center gap-1.5 bg-muted/60 px-4 text-center text-xs text-muted-foreground">
          <TriangleAlert className="size-5 text-amber-600 dark:text-amber-400" />
          放不了：文件不在了，或者浏览器不认这种编码（mp4 用 H.264、webm 用 VP9 最稳）
        </div>
      ) : (
        <video
          ref={video}
          src={url}
          controls
          playsInline
          preload="metadata"
          className="block max-h-56 w-full bg-black"
          onLoadedMetadata={(event) => setLength(event.currentTarget.duration)}
          onPlay={(event) => window.dispatchEvent(new CustomEvent(PLAYING, { detail: event.currentTarget }))}
          onError={() => setBroken(true)}
        />
      )}
      <figcaption className="flex items-center gap-2 px-3 py-1.5 text-xs">
        <Film className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-medium" title={item.path}>
          {item.name}
        </span>
        <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">
          {[clock(length ?? NaN), sizeOf(item.size)].filter(Boolean).join(" · ")}
        </span>
        <a
          href={`${url}&download=1`}
          download={item.name}
          className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          title="保存到本地"
          aria-label={`保存 ${item.name}`}
        >
          <Download className="size-3.5" />
        </a>
        <button
          type="button"
          className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          title={`复制路径：${item.path}`}
          aria-label="复制路径"
          onClick={() => void navigator.clipboard?.writeText(item.path)}
        >
          <Copy className="size-3.5" />
        </button>
      </figcaption>
    </figure>
  )
}
