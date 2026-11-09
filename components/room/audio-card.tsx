"use client"

import { useEffect, useRef, useState } from "react"
import { AudioLines, Download, Loader2, Pause, Play } from "lucide-react"

import { inOpenProject } from "@/components/room/api"
import type { Attachment } from "@/lib/types"

// A sound attached to a message, played in place: play / pause, a bar to
// drag through it, the time, a speed switch and a save button. Starting one
// pauses any other that is playing, so two reports never talk over each other.

// Shared with the video card: one sound at a time across both.
const PLAYING = "bench-media-playing"
const SPEEDS = [1, 1.25, 1.5, 2]

function clock(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return "--:--"
  const whole = Math.floor(seconds)
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

export function AudioCard({ item }: { item: Attachment }) {
  const audio = useRef<HTMLAudioElement>(null)
  const bar = useRef<HTMLDivElement>(null)
  const [playing, setPlaying] = useState(false)
  const [waiting, setWaiting] = useState(false)
  const [time, setTime] = useState(0)
  const [length, setLength] = useState(Number.NaN)
  const [speed, setSpeed] = useState(1)
  const [broken, setBroken] = useState(false)
  const src = inOpenProject(`/api/v1/files?path=${encodeURIComponent(item.path)}`)

  // Another card started: this one stops.
  useEffect(() => {
    const onOther = (event: Event) => {
      if ((event as CustomEvent).detail !== audio.current) audio.current?.pause()
    }
    window.addEventListener(PLAYING, onOther)
    return () => window.removeEventListener(PLAYING, onOther)
  }, [])

  const toggle = () => {
    const node = audio.current
    if (!node || broken) return
    if (node.paused) {
      window.dispatchEvent(new CustomEvent(PLAYING, { detail: node }))
      void node.play().catch(() => setBroken(true))
    } else node.pause()
  }

  // Click or drag on the bar to jump; arrow keys step five seconds.
  const seekTo = (clientX: number) => {
    const node = audio.current
    const box = bar.current?.getBoundingClientRect()
    if (!node || !box || !Number.isFinite(node.duration)) return
    const at = Math.min(1, Math.max(0, (clientX - box.left) / box.width)) * node.duration
    node.currentTime = at
    setTime(at)
  }
  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    seekTo(event.clientX)
  }
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) seekTo(event.clientX)
  }
  const onKey = (event: React.KeyboardEvent) => {
    const node = audio.current
    if (!node || !Number.isFinite(node.duration)) return
    const step = event.key === "ArrowRight" ? 5 : event.key === "ArrowLeft" ? -5 : 0
    if (!step) return
    event.preventDefault()
    node.currentTime = Math.min(node.duration, Math.max(0, node.currentTime + step))
  }

  const nextSpeed = () => {
    const next = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length]
    if (audio.current) audio.current.playbackRate = next
    setSpeed(next)
  }

  const done = Number.isFinite(length) && length > 0 ? Math.min(1, time / length) : 0
  return (
    <div
      className="flex w-[min(100%,22rem)] items-center gap-3 rounded-2xl border bg-background/70 px-3 py-2.5 text-xs shadow-xs"
      title={item.path}
    >
      <audio
        ref={audio}
        src={src}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onWaiting={() => setWaiting(true)}
        onPlaying={() => setWaiting(false)}
        onCanPlay={() => setWaiting(false)}
        onTimeUpdate={(event) => setTime(event.currentTarget.currentTime)}
        onLoadedMetadata={(event) => setLength(event.currentTarget.duration)}
        onDurationChange={(event) => setLength(event.currentTarget.duration)}
        onError={() => setBroken(true)}
      />
      <button
        type="button"
        onClick={toggle}
        disabled={broken}
        aria-label={playing ? `暂停 ${item.name}` : `播放 ${item.name}`}
        className="grid size-9 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground transition-transform hover:scale-105 active:scale-95 disabled:bg-muted disabled:text-muted-foreground"
      >
        {waiting && playing ? (
          <Loader2 className="size-4 animate-spin" />
        ) : playing ? (
          <Pause className="size-4 fill-current" />
        ) : (
          <Play className="size-4 translate-x-px fill-current" />
        )}
      </button>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <AudioLines className={`size-3.5 shrink-0 text-muted-foreground ${playing ? "animate-pulse text-primary" : ""}`} />
          <span className="truncate font-medium">{item.name}</span>
        </div>
        {broken ? (
          <div className="mt-1.5 text-[11px] text-destructive">放不了：文件不在了，或浏览器不认这种格式</div>
        ) : (
          <>
            <div
              ref={bar}
              role="slider"
              tabIndex={0}
              aria-label="播放进度"
              aria-valuemin={0}
              aria-valuemax={Number.isFinite(length) ? Math.round(length) : 0}
              aria-valuenow={Math.round(time)}
              aria-valuetext={`${clock(time)} / ${clock(length)}`}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onKeyDown={onKey}
              className="group/bar relative mt-1.5 h-3 cursor-pointer touch-none outline-none"
            >
              <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-foreground/10" />
              <div
                className="absolute top-1/2 left-0 h-1 -translate-y-1/2 rounded-full bg-primary"
                style={{ width: `${done * 100}%` }}
              />
              <div
                className="absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary opacity-0 shadow transition-opacity group-hover/bar:opacity-100 group-focus-visible/bar:opacity-100"
                style={{ left: `${done * 100}%` }}
              />
            </div>
            <div className="mt-0.5 flex items-center gap-2 font-mono text-[10px] text-muted-foreground tabular-nums">
              <span>
                {clock(time)} / {clock(length)}
              </span>
              {item.size !== undefined ? <span className="font-sans">{sizeOf(item.size)}</span> : null}
            </div>
          </>
        )}
      </div>
      <div className="flex shrink-0 flex-col items-center gap-1">
        <button
          type="button"
          onClick={nextSpeed}
          disabled={broken}
          className="rounded-md px-1 font-mono text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label="切换播放速度"
          title="播放速度"
        >
          {speed}×
        </button>
        <a
          href={`${src}&download`}
          className="rounded-md p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label={`保存 ${item.name}`}
          title="保存"
        >
          <Download className="size-3.5" />
        </a>
      </div>
    </div>
  )
}
