"use client"

import { useLayoutEffect, useRef, useSyncExternalStore } from "react"
import { createPortal } from "react-dom"

import { Avatar, seatLook } from "@/components/room/bits"
import type { BenchSeat, Project } from "@/lib/types"

// A deleted project leaves the rail with a bang: its bench snaps in the
// middle, the halves tumble away, and the bots sitting on it are flung off
// the screen, sweating. The real card is hidden at once and a stand-in drawn
// on top of the page plays it out, so the list can drop the project right
// away (project-rail.tsx marks the parts with data-wreck*). Under the avatar
// rail (lg–xl) the tile spins off instead; with no rail showing, nothing.

type Box = { x: number; y: number; w: number; h: number }
type Wreck = {
  key: number
  kind: "card" | "tile"
  box: Box
  shell: HTMLElement
  plank: Box | null
  bots: { seat: BenchSeat; box: Box }[]
}

let wreck: Wreck | null = null
let count = 0
const listeners = new Set<() => void>()

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function show(next: Wreck | null) {
  wreck = next
  for (const listener of listeners) listener()
}

function boxOf(element: Element): Box {
  const rect = element.getBoundingClientRect()
  return { x: rect.x, y: rect.y, w: rect.width, h: rect.height }
}

// Call right after the project is gone on the server, before the list reloads.
export function smashProject(project: Project | undefined) {
  if (!project || typeof document === "undefined") return
  const found = [...document.querySelectorAll<HTMLElement>(`[data-wreck="${CSS.escape(project.id)}"]`)].find(
    (element) => element.offsetParent !== null,
  )
  if (!found) return
  const kind = found.dataset.wreckKind === "tile" ? "tile" : "card"
  const plankElement = found.querySelector("[data-wreck-plank]")
  const bots = [...found.querySelectorAll<HTMLElement>("[data-wreck-seat]")].flatMap((element) => {
    const seat = project.bench.find((item) => item.id === element.dataset.wreckSeat)
    return seat ? [{ seat, box: boxOf(element) }] : []
  })
  // The shell is the card as it looked, minus what flies off on its own.
  const shell = found.cloneNode(true) as HTMLElement
  shell.removeAttribute("data-wreck")
  for (const part of shell.querySelectorAll<HTMLElement>("[data-wreck-seat], [data-wreck-wood]")) part.style.visibility = "hidden"
  shell.querySelectorAll("button").forEach((button) => button.setAttribute("tabindex", "-1"))
  const box = boxOf(found)
  found.style.visibility = "hidden"
  show({ key: ++count, kind, box, shell, plank: plankElement ? boxOf(plankElement) : null, bots })
}

export function ProjectWreck() {
  const current = useSyncExternalStore(subscribe, () => wreck, () => null)
  if (!current) return null
  return createPortal(<Scene key={current.key} wreck={current} />, document.body)
}

const WOOD = "#b98a5e"
const WOOD_DARK = "#8c6440"
const START = 300 // let the settings dialog and its blur fade first

function Scene({ wreck }: { wreck: Wreck }) {
  const root = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const scene = root.current
    if (!scene) return
    const shellHolder = scene.querySelector<HTMLElement>("[data-part=shell]")!
    shellHolder.appendChild(wreck.shell)
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches
    const animations: Animation[] = []
    const play = (selector: string, frames: Keyframe[], options: KeyframeAnimationOptions) => {
      for (const element of scene.querySelectorAll<HTMLElement>(selector)) {
        animations.push(element.animate(frames, { fill: "both", delay: START, ...options }))
      }
    }
    let total = 1000
    if (still) {
      play("[data-part]", [{ opacity: 1 }, { opacity: 0 }], { duration: 200 })
      total = 400
    } else if (wreck.kind === "tile") {
      // The tile gets kicked up and off to the left, spinning, and gravity
      // takes it from there.
      const motion = fall({
        hold: [
          { at: 0, transform: "none" },
          { at: 90, transform: "translate(4px, 3px) scale(1.08, 0.9)" },
        ],
        vx: -420,
        vy: -900,
        spin: -800,
        depth: window.innerHeight + 60 - wreck.box.y,
      })
      play("[data-part=shell]", motion.frames, { duration: motion.duration, easing: "linear" })
      total = motion.duration
    } else {
      // A shiver, then the card fades and sinks behind the wreck.
      play("[data-part=shell]", [
        { transform: "none", opacity: 1 },
        { transform: "translateX(-2px)", offset: 0.04 },
        { transform: "translateX(2px)", offset: 0.08 },
        { transform: "translateX(-2px)", offset: 0.12 },
        { transform: "none", opacity: 1, offset: 0.2 },
        { transform: "translateY(14px) scale(0.94)", opacity: 0 },
      ], { duration: 1000, easing: "ease-in" })
      // The plank snaps at the middle, one of two ways (a coin toss each
      // time): it sags into a V and the bots drop through, or it kicks up
      // into a ∧ and catapults them off the top. Either way the halves then
      // tumble off the bottom, faster and faster.
      const floor = window.innerHeight + 60
      const up = Math.random() < 0.5
      const bend = up ? -14 : 16
      if (wreck.plank) {
        const plank = wreck.plank
        for (const [side, sign] of [["left", 1], ["right", -1]] as const) {
          const motion = fall({
            hold: [
              { at: 0, transform: "none" },
              { at: 150, transform: "none" },
              { at: up ? 260 : 330, transform: `rotate(${bend * sign}deg)` },
            ],
            rotate: bend * sign,
            vx: -50 * sign,
            vy: 0,
            spin: 260 * sign,
            depth: floor - plank.y,
          })
          play(`[data-part=half-${side}]`, motion.frames, { duration: motion.duration, easing: "linear" })
          total = Math.max(total, motion.duration)
        }
      }
      // The bots lose their seat when it snaps: a jolt, then they drop with
      // the halves, or get flung up and out the top (slowing as they rise),
      // the outer ones off to their own side.
      wreck.bots.forEach((bot, index) => {
        const side = wreck.bots.length === 1 ? 0 : index / (wreck.bots.length - 1) - 0.5 // -0.5 … 0.5
        const rise = bot.box.y + bot.box.h + 40
        const motion = up
          ? fall({
              hold: [
                { at: 0, transform: "none" },
                { at: 150 + index * 30, transform: "none" },
                { at: 200 + index * 30, transform: "translateY(4px) scale(1.15, 0.8)" },
              ],
              vx: side * 900 + 30,
              vy: -Math.sqrt(2 * GRAVITY * rise) * 1.25,
              spin: side * 1100 + (index % 2 ? 300 : -300),
              depth: -rise,
            })
          : fall({
          hold: [
            { at: 0, transform: "none" },
            { at: 170 + index * 40, transform: "none" },
            { at: 230 + index * 40, transform: "translateY(3px) scale(1.12, 0.86)" },
          ],
          vx: side * 260 + 10,
          vy: -170,
          spin: side * 900 + (index % 2 ? 140 : -140),
              depth: floor - bot.box.y,
            })
        play(`[data-part=bot-${index}]`, motion.frames, { duration: motion.duration, easing: "linear" })
        total = Math.max(total, motion.duration)
      })
    }
    const done = window.setTimeout(() => show(null), START + total)
    return () => {
      window.clearTimeout(done)
      for (const animation of animations) animation.cancel()
    }
  }, [wreck])

  const { box, plank } = wreck
  const half = plank ? plank.w / 2 : 0
  return (
    <div ref={root} aria-hidden="true" className="pointer-events-none fixed inset-0 z-[100] overflow-hidden">
      <div data-part="shell" className="absolute" style={{ left: box.x, top: box.y, width: box.w, height: box.h }} />
      {plank && wreck.kind === "card" ? (
        <>
          <Half side="left" plank={plank} width={half} />
          <Half side="right" plank={plank} width={half} />
        </>
      ) : null}
      {wreck.bots.map((bot, index) => {
        const look = seatLook(bot.seat)
        return (
          <span
            key={bot.seat.id}
            data-part={`bot-${index}`}
            className="absolute block"
            style={{ left: bot.box.x, top: bot.box.y, width: bot.box.w, height: bot.box.h }}
          >
            <Avatar
              name={bot.seat.name}
              color={look.color}
              label={look.label}
              kind={look.kind}
              size="md"
              mood={look.kind ? "worried" : undefined}
            />
          </span>
        )
      })}
    </div>
  )
}

// Keyframes for something that holds still (or does its `hold` moves) and
// then falls under gravity from where the last hold left it: thrown with
// (vx, vy) px/s and turning `spin` deg/s, until it is `depth` px further
// down (a negative depth: up, on the way up, so vy must carry it that far). Sampled every 30ms with linear steps, so the speed really builds up.
const GRAVITY = 2600 // px/s²
function fall({
  hold,
  rotate = 0,
  vx,
  vy,
  spin,
  depth,
}: {
  hold: { at: number; transform: string }[]
  rotate?: number
  vx: number
  vy: number
  spin: number
  depth: number
}) {
  const from = hold[hold.length - 1].at
  // Time for y = vy·t + g·t²/2 to reach depth (the first time, going up).
  const time =
    depth < 0
      ? (-vy - Math.sqrt(Math.max(vy * vy + 2 * GRAVITY * depth, 0))) / GRAVITY
      : (-vy + Math.sqrt(vy * vy + 2 * GRAVITY * Math.max(depth, 1))) / GRAVITY
  const duration = Math.round(from + time * 1000)
  const frames: Keyframe[] = hold.map((step) => ({ transform: step.transform, offset: step.at / duration }))
  for (let ms = 30; ms < time * 1000 + 30; ms += 30) {
    const t = Math.min(ms / 1000, time)
    const x = vx * t
    const y = vy * t + (GRAVITY * t * t) / 2
    frames.push({
      transform: `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) rotate(${(rotate + spin * t).toFixed(1)}deg)`,
      offset: Math.min(1, (from + t * 1000) / duration),
    })
  }
  frames[frames.length - 1].offset = 1
  return { frames, duration }
}

// Half a plank with its leg, hinged at the outer end so the middle can sag.
function Half({ side, plank, width }: { side: "left" | "right"; plank: Box; width: number }) {
  const left = side === "left"
  return (
    <span
      data-part={`half-${side}`}
      className="absolute block"
      style={{
        left: left ? plank.x : plank.x + width,
        top: plank.y,
        width,
        height: plank.h + 8,
        transformOrigin: left ? "0 0" : "100% 0",
      }}
    >
      <span
        className="absolute inset-x-0 top-0 block"
        style={{
          height: plank.h,
          background: WOOD,
          boxShadow: `0 1px 0 ${WOOD_DARK}`,
          borderRadius: left ? "3px 0 0 3px" : "0 3px 3px 0",
          // A jagged break where the halves meet.
          clipPath: left
            ? "polygon(0 0, 100% 0, calc(100% - 3px) 50%, 100% 100%, 0 100%)"
            : "polygon(0 0, 100% 0, 100% 100%, 0 100%, 3px 50%)",
        }}
      />
      <span
        className="absolute block w-[3px] rounded-b-sm"
        style={{ top: plank.h, height: 8, background: WOOD_DARK, [left ? "left" : "right"]: 12 }}
      />
    </span>
  )
}
