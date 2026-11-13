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
// ticks for each seat at work right now. When the computer is playing
// something, the ticks themselves stretch with the sound
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
    // The rail ends above the composer (--dock), which grows and shrinks with
    // an animation (the reply bar, the @ list). The ticks sit at percentages
    // of the rail and ride along by themselves; laying them out again (a
    // render of every tick) waits until it settles. Doing that every frame
    // cost 13-17ms a frame while the reply bar opened (2026-11-12).
    let settle = 0
    const observer = new ResizeObserver(() => {
      setWidth(node.clientWidth)
      if (!track) return
      const next = track.clientHeight
      setHeight((current) => (current === 0 ? next : current))
      window.clearTimeout(settle)
      settle = window.setTimeout(() => setHeight(next), 150)
    })
    observer.observe(node)
    if (track) observer.observe(track)
    return () => {
      observer.disconnect()
      window.clearTimeout(settle)
    }
  }, [])
  const gutter = (width - CONTENT) / 2
  const shown = gutter >= MIN_RULER

  const [rhythm, setRhythm] = useState(() => readPref(RHYTHM_KEY) !== "off")
  const busy = agents.filter((agent) => agent.runId && !agent.demo)
  // Moves with the music whether or not anyone is working.
  const level = useRhythm(gutter >= MIN_RHYTHM && rhythm)
  // The ticks themselves stretch with the music, low notes at the bottom.
  useBeat(rail, level, Math.max(0, Math.min(gutter - 80, 150)))

  const seats = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents])
  const said = useMemo(() => messages.filter((message) => message.kind !== "system" && !message.recalled), [messages])
  const fit = Math.max(1, Math.floor((height - 4) / STEP))
  const ticks = said.slice(-fit)
  const earlier = said.length - ticks.length
  const lit = useInView(box, said)

  // Few messages: spread them out first, then center what still doesn't fill.
  const step = ticks.length > 0 ? Math.min(MAX_STEP, Math.max(STEP, (height - 4) / ticks.length)) : STEP
  const top = Math.max(0, (height - ticks.length * step) / 2)
  // Where on the rail, as a share of it: see the ResizeObserver above.
  const at = (y: number) => (height > 0 ? `${((y / height) * 100).toFixed(3)}%` : y)
  // The tick under the pointer, for the card; React only hears when it
  // changes. The dock effect follows the pointer itself (useDock).
  const [hovered, setHovered] = useState(-1)
  const dock = useDock(rail)
  const card = hovered >= 0 && hovered < ticks.length ? ticks[hovered] : null
  useLayoutEffect(() => dock.redraw())

  const colorOf = (message: Message) => {
    const agent = seats.get(message.authorId)
    return agent ? seatLook(agent).color : "var(--foreground)"
  }
  const railLeft = Math.max(20, Math.min(40, gutter * 0.18))

  return (
    <div ref={box} className="pointer-events-none absolute inset-0 hidden lg:block" aria-hidden={!shown}>
      <div
        data-dock="bottom 1.25rem"
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
            data-ruler=""
            data-playing={level.playing ? "" : undefined}
            style={{ "--reach": Math.max(1, Math.min(gutter - 80, 150)) } as React.CSSProperties}
            className="group/rail pointer-events-auto absolute top-0 bottom-8 left-0 w-12 cursor-pointer"
            onPointerMove={(event) => {
              const y = event.clientY - event.currentTarget.getBoundingClientRect().top
              dock.move(y)
              setHovered(Math.round((y - top - step / 2) / step))
            }}
            onPointerLeave={() => {
              dock.move(null)
              setHovered(-1)
            }}
            onClick={() => card && goto("message", card.id)}
          >
            {earlier > 0 ? (
              <span className="absolute left-0 text-[9px] leading-none text-muted-foreground/60 tabular-nums" style={{ top: at(top - 14) }}>
                ↑{earlier}
              </span>
            ) : null}
            {ticks.map((message, index) => {
              const y = top + index * step + step / 2
              const on = lit.has(message.id)
              const base = tickLength(message)
              return (
                <span
                  key={message.id}
                  data-tick=""
                  data-ruler-tick=""
                  data-lit={on ? "" : undefined}
                  data-y={y}
                  // No transition while the pointer is on the rail or music is
                  // playing: each pointer move / each beat frame restarted it
                  // on every tick (the 65-tick rail then ran at a third of the
                  // frame rate, and the ticks only caught up once things
                  // stopped). Easing back when they do.
                  className="absolute left-0 h-[2px] origin-left -translate-y-1/2 rounded-full transition-[transform,opacity] duration-150 ease-out group-data-[docking]/rail:transition-none group-data-[playing]/rail:transition-none group-data-[playing]/rail:will-change-transform"
                  style={{
                    top: at(y),
                    // --near: how close the pointer is (useDock); --beat: how
                    // far the music pushes it out (useBeat).
                    // Fixed width, stretched with scaleX: changing the width
                    // every frame (pointer, music) made the browser lay out
                    // every tick each time. Same length as before:
                    // base*(1+near*1.1) + lit 4px + beat px.
                    width: base,
                    transform: `scaleX(calc(1 + var(--near, 0) * 1.1 + (${on ? 4 : 0} + var(--beat, 0)) / ${base}))`,
                    // The speaker's color; the dark theme decides how much of
                    // it to show (globals.css, [data-ruler-tick]).
                    "--tc": colorOf(message),
                    opacity: index === hovered || on ? 1 : "calc(0.5 + var(--near, 0) * 0.4)",
                  } as React.CSSProperties}
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
      // The rail ends 1.25rem (20px) above the composer (composer.tsx sets its bottom).
      const rail = box.current?.querySelector<HTMLElement>("[data-dock]")
      const dock = rail ? Math.max(0, (parseFloat(getComputedStyle(rail).bottom) || 0) - 20) : 0
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
    // The levels arrive 30 times a second (lib/audio.ts), the screen draws 60
    // to 144. Drawn as they come, the ticks step at 30. So what is shown
    // chases the latest level every screen frame: quickly up, slowly down,
    // by elapsed time, so it looks the same at any refresh rate. Costs
    // nothing extra: the loop was running and writing every frame already.
    const shown = new Float32Array(bands.length)
    const written = new Map<HTMLElement, number>()
    let last = performance.now()
    const draw = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000)
      last = now
      const up = 1 - Math.exp(-dt / 0.03)
      const down = 1 - Math.exp(-dt / 0.11)
      for (let i = 0; i < shown.length; i++) shown[i] += (bands[i] - shown[i]) * (bands[i] > shown[i] ? up : down)
      const ticks = node.querySelectorAll<HTMLElement>("[data-tick]")
      const count = ticks.length
      ticks.forEach((tick, index) => {
        const at = count > 1 ? (1 - index / (count - 1)) * (shown.length - 1) : 0
        const low = Math.floor(at)
        const high = Math.min(shown.length - 1, low + 1)
        const value = shown[low] + (shown[high] - shown[low]) * (at - low)
        const beat = Math.round(Math.pow(value, 1.8) * reach * 10) / 10
        // Settled ticks cost nothing: write only what changed.
        if (written.get(tick) !== beat) {
          written.set(tick, beat)
          tick.style.setProperty("--beat", beat.toFixed(1))
        }
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

// The dock effect, written straight onto the ticks once a frame (`--near`,
// 0 to 1 by distance from the pointer) instead of through React state, so
// the ticks keep up with the pointer as it moves. `data-docking` on the rail
// turns the ticks' transition off meanwhile.
function useDock(rail: React.RefObject<HTMLDivElement | null>) {
  const state = useRef<{ y: number | null; frame: number }>({ y: null, frame: 0 })
  const [api] = useState(() => {
    const draw = () => {
      state.current.frame = 0
      const node = rail.current
      if (!node) return
      const y = state.current.y
      if (y === null) node.removeAttribute("data-docking")
      else node.setAttribute("data-docking", "")
      node.querySelectorAll<HTMLElement>("[data-tick]").forEach((tick) => {
        if (y === null) {
          tick.style.removeProperty("--near")
          return
        }
        const near = Math.exp(-(((y - Number(tick.dataset.y)) / 30) ** 2))
        tick.style.setProperty("--near", near < 0.005 ? "0" : near.toFixed(3))
      })
    }
    return {
      move(y: number | null) {
        state.current.y = y
        if (!state.current.frame) state.current.frame = requestAnimationFrame(draw)
      },
      redraw() {
        if (state.current.y !== null && !state.current.frame) state.current.frame = requestAnimationFrame(draw)
      },
    }
  })
  useEffect(() => () => cancelAnimationFrame(state.current.frame), [])
  return api
}
