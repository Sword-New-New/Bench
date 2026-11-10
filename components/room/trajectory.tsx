"use client"

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { Music2 } from "lucide-react"

import { human } from "@/components/room/api"
import { previewText } from "@/components/room/attachments"
import { seatLook } from "@/components/room/bits"
import { goto } from "@/components/room/refs"
import { clock } from "@/lib/status"
import type { Message, PublicAgent } from "@/lib/types"

// The ruler in the blank to the left of the thread: one tick per message, top
// to bottom in the thread's order, newest at the bottom; few of them spread
// out and centered. A
// tick has its speaker's color and is longer the longer the message is; the
// stretch you are reading is lit, the ticks near the pointer grow like a dock,
// hovering shows who said what, a click goes there. A breathing dot under the
// ticks for each seat at work right now. When nobody is working and the
// computer is playing something, the ticks themselves stretch with the sound
// (lib/audio.ts, useBeat). The right side stays empty on purpose.

const CONTENT = 768 // the thread's max-w-3xl
const MIN_RULER = 64
const MIN_RHYTHM = 150
const STEP = 9 // px between ticks, at the tightest
const MAX_STEP = 18 // and at the loosest, when there are few
const RHYTHM_KEY = "bench-rhythm"

function readPref(key: string) {
  try {
    return typeof window === "undefined" ? null : localStorage.getItem(key)
  } catch {
    return null
  }
}

// 4 characters → 6px, a page → about 26px.
function tickLength(message: Message) {
  const size = message.text.length + (message.attachments?.length ?? 0) * 40
  return Math.round(6 + Math.min(20, Math.log2(1 + size / 8) * 2.6))
}

export function Trajectory({
  agents,
  messages,
  onOpenRun,
}: {
  agents: PublicAgent[]
  messages: Message[]
  onOpenRun: (runId: string) => void
}) {
  const box = useRef<HTMLDivElement>(null)
  const rail = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [height, setHeight] = useState(0)
  useLayoutEffect(() => {
    const node = box.current
    const track = rail.current
    if (!node) return
    const observer = new ResizeObserver(() => {
      setWidth(node.clientWidth)
      if (track) setHeight(track.clientHeight)
    })
    observer.observe(node)
    if (track) observer.observe(track)
    return () => observer.disconnect()
  }, [])
  const gutter = (width - CONTENT) / 2
  const shown = gutter >= MIN_RULER

  const [rhythm, setRhythm] = useState(() => readPref(RHYTHM_KEY) !== "off")
  const busy = agents.filter((agent) => agent.runId && !agent.demo)
  const level = useRhythm(gutter >= MIN_RHYTHM && rhythm && busy.length === 0)
  // The ticks themselves stretch with the music, low notes at the bottom.
  useBeat(rail, level, Math.max(0, Math.min(gutter - 80, 150)))

  const seats = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents])
  const said = useMemo(() => messages.filter((message) => message.kind !== "system" && !message.recalled), [messages])
  const fit = Math.max(1, Math.floor((height - 4) / STEP))
  const ticks = said.slice(-fit)
  const earlier = said.length - ticks.length
  const lit = useInView(box, said)

  // Where the pointer is on the rail, for the dock effect and the card.
  const [pointer, setPointer] = useState<number | null>(null)
  // Few messages: spread them out first, then center what still doesn't fill.
  const step = ticks.length > 0 ? Math.min(MAX_STEP, Math.max(STEP, (height - 4) / ticks.length)) : STEP
  const top = Math.max(0, (height - ticks.length * step) / 2)
  const hovered = pointer === null ? -1 : Math.round((pointer - top - step / 2) / step)
  const card = hovered >= 0 && hovered < ticks.length ? ticks[hovered] : null

  const colorOf = (message: Message) => {
    const agent = seats.get(message.authorId)
    return agent ? seatLook(agent).color : "var(--foreground)"
  }
  const railLeft = Math.max(20, Math.min(40, gutter * 0.18))

  return (
    <div ref={box} className="pointer-events-none absolute inset-0 hidden lg:block" aria-hidden={!shown}>
      <div
        className={`absolute top-14 bottom-[calc(var(--dock,8rem)+1.25rem)] ${shown ? "" : "invisible"}`}
        style={{ left: railLeft, width: Math.max(0, Math.min(gutter - railLeft - 16, 220)) }}
      >
        {gutter >= MIN_RHYTHM ? (
          <button
            type="button"
            className={`pointer-events-auto absolute -top-7 left-0 grid size-5 place-items-center rounded-full hover:bg-foreground/6 ${
              rhythm ? "text-muted-foreground" : "text-muted-foreground/40"
            }`}
            title={rhythm ? "没人干活时跟着电脑正在放的声音律动（点一下关掉）" : "律动关着（点一下打开）"}
            aria-pressed={rhythm}
            onClick={() => {
              setRhythm(!rhythm)
              try {
                localStorage.setItem(RHYTHM_KEY, rhythm ? "off" : "on")
              } catch {}
            }}
          >
            <Music2 className="size-3" />
          </button>
        ) : null}

        <div className="absolute inset-0">
          {/* The rail: generous to hover, the ticks only as wide as they are. */}
          <div
            ref={rail}
            className="pointer-events-auto absolute top-0 bottom-8 left-0 w-12 cursor-pointer"
            onPointerMove={(event) => setPointer(event.clientY - event.currentTarget.getBoundingClientRect().top)}
            onPointerLeave={() => setPointer(null)}
            onClick={() => card && goto("message", card.id)}
          >
            {earlier > 0 ? (
              <span className="absolute left-0 text-[9px] leading-none text-muted-foreground/60 tabular-nums" style={{ top: top - 14 }}>
                ↑{earlier}
              </span>
            ) : null}
            {ticks.map((message, index) => {
              const y = top + index * step + step / 2
              const near = pointer === null ? 0 : Math.exp(-(((pointer - y) / 30) ** 2))
              const on = lit.has(message.id)
              const base = tickLength(message)
              return (
                <span
                  key={message.id}
                  data-tick=""
                  className="absolute left-0 h-[2px] -translate-y-1/2 rounded-full transition-[width,opacity] duration-100 ease-out"
                  style={{
                    top: y,
                    // --beat: how far the music pushes it out (useBeat).
                    width: `calc(${base * (1 + near * 1.1) + (on ? 4 : 0)}px + var(--beat, 0) * 1px)`,
                    background: colorOf(message),
                    opacity: index === hovered ? 1 : on ? 1 : 0.5 + near * 0.4,
                  }}
                />
              )
            })}
          </div>

          {/* Seats at work: a breathing dot each, under the newest tick. */}
          <div className="pointer-events-auto absolute bottom-0 left-0 flex h-6 items-center gap-1.5">
            {busy.map((agent) => {
              const { color } = seatLook(agent)
              return (
                <button
                  key={agent.id}
                  type="button"
                  className="relative grid size-3 place-items-center"
                  title={`${agent.name} 正在做，点开看过程`}
                  onClick={() => agent.runId && onOpenRun(agent.runId)}
                >
                  <span className="absolute inset-0 animate-ping rounded-full opacity-40 motion-reduce:animate-none" style={{ background: color }} />
                  <span className="size-2 rounded-full" style={{ background: color, boxShadow: `0 0 8px ${color}` }} />
                </button>
              )
            })}
          </div>
        </div>


        {/* Who said what, beside the tick under the pointer. */}
        {card ? (
          <div
            className="notice pointer-events-none absolute z-20 w-72 -translate-y-1/2 rounded-2xl px-3 py-2 text-xs"
            style={{ left: 56, top: Math.min(Math.max(top + hovered * step + step / 2, 40), height - 30) }}
          >
            <p className="flex items-center gap-1.5">
              <span className="size-2 shrink-0 rounded-full" style={{ background: colorOf(card) }} />
              <span className="font-medium">{card.authorName}</span>
              <span className="text-muted-foreground tabular-nums">{clock(card.createdAt)}</span>
            </p>
            <p className="mt-1 line-clamp-3 leading-5 text-muted-foreground">{previewText(card).replace(/\s+/g, " ").slice(0, 240)}</p>
          </div>
        ) : null}
      </div>
    </div>
  )
}

// Which messages are on screen in the thread: their holders
// ([data-message], thread.tsx) inside the thread's scroll box, between its
// top and the composer. Checked on scroll and when the messages change.
function useInView(box: React.RefObject<HTMLDivElement | null>, messages: Message[]) {
  const [lit, setLit] = useState<Set<string>>(() => new Set())
  useEffect(() => {
    const host = box.current?.parentElement
    if (!host) return
    let frame = 0
    const measure = () => {
      frame = 0
      const scroller = host.querySelector<HTMLElement>(".overflow-y-auto")
      if (!scroller) return
      const view = scroller.getBoundingClientRect()
      const dock = parseFloat(getComputedStyle(host).getPropertyValue("--dock")) || 0
      const next = new Set<string>()
      for (const holder of host.querySelectorAll<HTMLElement>("[data-message]")) {
        const target = holder.firstElementChild?.getBoundingClientRect()
        if (target && target.bottom > view.top + 8 && target.top < view.bottom - dock - 8) next.add(holder.dataset.message!)
      }
      setLit((current) => (current.size === next.size && [...next].every((id) => current.has(id)) ? current : next))
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure)
    }
    schedule()
    host.addEventListener("scroll", schedule, true)
    window.addEventListener("resize", schedule)
    return () => {
      host.removeEventListener("scroll", schedule, true)
      window.removeEventListener("resize", schedule)
      cancelAnimationFrame(frame)
    }
  }, [box, messages])
  return lit
}

// ---- The rhythm ----

type Level = { bands: Float32Array; playing: boolean }

// Band levels from /api/v1/audio while `on` and the tab is visible. Smoothed
// here: a band jumps up at once and falls back slowly. `playing` turns on
// after a moment of sound and off after a few seconds of quiet.
function useRhythm(on: boolean): Level {
  const shared = useRef<Level>({ bands: new Float32Array(20), playing: false })
  const [playing, setPlaying] = useState(false)
  useEffect(() => {
    const state = shared.current
    if (!on || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return
    let abort: AbortController | null = null
    let loud = 0
    let quietSince = 0
    const connect = async () => {
      if (document.visibilityState !== "visible" || abort) return
      abort = new AbortController()
      try {
        const res = await fetch("/api/v1/audio", { headers: human(), signal: abort.signal })
        if (res.status !== 200 || !res.body) return
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
        let rest = ""
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          rest += value
          const lines = rest.split("\n")
          rest = lines.pop() ?? ""
          const last = lines.at(-1)
          if (!last) continue
          const frame = JSON.parse(last) as { bands: number[]; level: number }
          const bands = shared.current.bands
          frame.bands.forEach((value, index) => {
            bands[index] = Math.max(value, bands[index] * 0.86)
          })
          const now = Date.now()
          if (frame.level > 0.18) {
            loud = Math.min(loud + 1, 30)
            quietSince = 0
          } else {
            loud = Math.max(loud - 1, 0)
            if (!quietSince) quietSince = now
          }
          const next = shared.current.playing ? !(quietSince && now - quietSince > 4000) : loud >= 15
          if (next !== shared.current.playing) {
            shared.current.playing = next
            setPlaying(next)
          }
        }
      } catch {
      } finally {
        abort = null
      }
    }
    const visibility = () => {
      if (document.visibilityState === "visible") void connect()
      else abort?.abort()
    }
    void connect()
    document.addEventListener("visibilitychange", visibility)
    return () => {
      document.removeEventListener("visibilitychange", visibility)
      abort?.abort()
      state.playing = false
      state.bands.fill(0)
      setPlaying(false)
    }
  }, [on])
  return { bands: shared.current.bands, playing: on && playing }
}

// While something plays, push each tick out by the loudness of the band at
// its height (bottom tick = lowest band, top = highest, in between blended),
// every frame, straight on the DOM so React doesn't redraw 100 ticks 30 times
// a second. Stops and lets them settle back when the music does.
function useBeat(rail: React.RefObject<HTMLDivElement | null>, level: Level, reach: number) {
  const { playing, bands } = level
  useEffect(() => {
    const node = rail.current
    if (!node || !playing || reach <= 0) return
    let frame = 0
    const draw = () => {
      const ticks = node.querySelectorAll<HTMLElement>("[data-tick]")
      const count = ticks.length
      ticks.forEach((tick, index) => {
        const at = count > 1 ? (1 - index / (count - 1)) * (bands.length - 1) : 0
        const low = Math.floor(at)
        const high = Math.min(bands.length - 1, low + 1)
        const value = bands[low] + (bands[high] - bands[low]) * (at - low)
        tick.style.setProperty("--beat", (Math.pow(value, 1.8) * reach).toFixed(1))
      })
      frame = requestAnimationFrame(draw)
    }
    frame = requestAnimationFrame(draw)
    return () => {
      cancelAnimationFrame(frame)
      node.querySelectorAll<HTMLElement>("[data-tick]").forEach((tick) => tick.style.removeProperty("--beat"))
    }
  }, [rail, playing, bands, reach])
}
