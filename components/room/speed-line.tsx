"use client"

import { useEffect, useState } from "react"

import { api } from "@/components/room/api"
import { SPEED_OPEN } from "@/components/room/speed-panel"
import { ago } from "@/lib/status"
import type { Speed } from "@/lib/speed"

// One line under a client's entry in the roster: how fast its latest reply
// came out, read natively from local session transcripts (lib/speed.ts).
// Nothing shows for clients without recorded transcripts in the last 24h.
const EVERY = 30_000
// Like the board's floating window: after three quiet minutes the number greys.
const IDLE_AFTER = 180_000

export function useSpeeds() {
  const [list, setList] = useState<Speed[]>([])
  useEffect(() => {
    let alive = true
    const load = () => {
      if (document.visibilityState !== "visible") return
      api<{ speeds: Speed[] }>("/api/v1/speed")
        .then((data) => alive && setList(data.speeds))
        .catch(() => {})
    }
    load()
    const timer = window.setInterval(load, EVERY)
    document.addEventListener("visibilitychange", load)
    return () => {
      alive = false
      window.clearInterval(timer)
      document.removeEventListener("visibilitychange", load)
    }
  }, [])
  return list
}

export function SpeedLine({ speed, color, now }: { speed: Speed | undefined; color: string; now: number }) {
  if (!speed) return null
  const idle = now - speed.at > IDLE_AFTER
  const wait = speed.ttft === null ? "" : speed.firstChunk ? `首块 ≤${speed.ttft.toFixed(1)}s` : `首 token ${speed.ttft.toFixed(1)}s`
  // The line is narrow: "首 ≤5.0s" there, spelled out on hover.
  const short = speed.ttft === null ? "" : `首 ${speed.firstChunk ? "≤" : ""}${speed.ttft.toFixed(1)}s`
  const when = ago(speed.at, now)
  return (
    // Inside the entry's button, so a click here must not also @ the client.
    // The settings menu opens the same board for keyboards.
    <span
      className="mt-1 flex cursor-pointer items-baseline gap-1.5 text-[11px] leading-4 text-muted-foreground hover:text-foreground"
      title={`最近一次 ${speed.tps} tok/s（${speed.model}），近 30 次中位 ${speed.median} tok/s${wait ? `，${wait}` : ""}，${when}。点开测速台`}
      onClick={(event) => {
        event.stopPropagation()
        window.dispatchEvent(new Event(SPEED_OPEN))
      }}
    >
      <span className="font-semibold tabular-nums" style={idle ? undefined : { color }}>
        {speed.tps.toFixed(speed.tps >= 100 ? 0 : 1)}
      </span>
      <span>tok/s</span>
      {short ? <span className="shrink-0">· {short}</span> : null}
      <span className="truncate">· {when}</span>
    </span>
  )
}
