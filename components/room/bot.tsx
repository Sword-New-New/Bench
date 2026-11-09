"use client"

import { useEffect, useRef } from "react"

import GrokBot, { type GrokBotState } from "@/lib/vendor/grokbot"
import type { AgentStatus } from "@/lib/types"

const STATE: Record<AgentStatus, GrokBotState> = {
  idle: "idle",
  working: "working",
  blocked: "sad",
  offline: "sleeping",
}

// A face that says what a seat is up to without the body moving: for small
// bots sitting in a row (the project rail's bench), where status's spinning
// and shape-shifting would be too much. Given a mood, the bot ignores status.
//   worried: waiting on the user (a permit or a question), eyes wide, a drop of sweat
//   busy:    working, focused eyes darting left and right
//   happy:   done and waiting to be checked, eyes squeezed in a smile, blushing
//   asleep:  offline, eyes shut
export type BotMood = "worried" | "busy" | "happy" | "asleep"

const MOOD: Record<BotMood, { state: GrokBotState; face?: string; gaze?: readonly [number, number] }> = {
  // Looking down to the right, like the app icon.
  worried: { state: "idle", face: "round", gaze: [0.55, 0.3] },
  busy: { state: "idle", face: "focused", gaze: [0.6, 0.1] },
  happy: { state: "idle", face: "happy", gaze: [0.2, -0.4] },
  asleep: { state: "sleeping" },
}

// How long busy eyes stay on one side before darting to the other.
const DART_MS = 650

// The shape a bot squishes into while the pointer is on its row. grokbot.js's
// own "pill" is thin and steeply tilted; Grok Bot's hover capsule is chubbier
// (about 0.6 as tall as wide) and nearly level, so we add that shape.
const HOVER_SHAPE = "capsule"

function registerCapsule() {
  if (GrokBot.SHAPES[HOVER_SHAPE]) return
  const radius = 0.6
  const half = 1 - radius
  const tilt = (-6 * Math.PI) / 180
  const inside = (x: number, y: number) => {
    // Undo the tilt, then the distance to the centre segment against the radius.
    const u = x * Math.cos(tilt) + y * Math.sin(tilt)
    const v = -x * Math.sin(tilt) + y * Math.cos(tilt)
    return Math.hypot(u - Math.min(Math.max(u, -half), half), v) < radius
  }
  // Same sampling as grokbot.js: one ray per point from the centre, starting
  // straight up, so this outline morphs point for point into the others.
  const count = GrokBot.SHAPES.circle.pts.length / 2
  const pts = new Float32Array(count * 2)
  for (let i = 0; i < count; i++) {
    const angle = -Math.PI / 2 + (Math.PI * 2 * i) / count
    const dx = Math.cos(angle)
    const dy = Math.sin(angle)
    let lo = 0
    let hi = 1.5
    for (let step = 0; step < 20; step++) {
      const mid = (lo + hi) / 2
      if (inside(dx * mid, dy * mid)) lo = mid
      else hi = mid
    }
    pts[i * 2] = dx * hi
    pts[i * 2 + 1] = dy * hi
  }
  GrokBot.SHAPES[HOVER_SHAPE] = { name: HOVER_SHAPE, label: "Capsule", pts, eye: [0.16, -0.06, 0.95] }
}

registerCapsule()

// How far the eyes may look, as a fraction of grokbot.js's full range. The
// pointer is usually far off to the side along a wide row; at full range the
// eyes would slide to the rim, while a face only glances within its eyes' area.
const GAZE = 0.45

// Where the eyes point for a pointer at (x, y): grokbot.js's own followPointer
// mapping, scaled down by GAZE.
function aim(svg: Element, x: number, y: number) {
  const box = svg.getBoundingClientRect()
  const dx = x - (box.left + box.width / 2)
  const dy = y - (box.top + box.height / 2)
  const reach = Math.max(box.width * 0.8, Math.hypot(dx, dy))
  const clamp = (value: number) => Math.min(Math.max(value, -1), 1)
  return [clamp((dx / reach) * 1.1) * GAZE, clamp((dy / reach) * 1.1) * GAZE] as const
}

// An animated character: it blinks and glances on its own, and works, sleeps
// or sulks along with the seat's status. Only while the pointer is over its
// area (`watch`) do its eyes follow it; `hover` also squishes it into a pill.
export function Bot({
  shape,
  color,
  size,
  status = "idle",
  hover = false,
  watch = hover,
  mood,
}: {
  shape: string
  color: string
  size: number
  status?: AgentStatus
  hover?: boolean
  watch?: boolean
  mood?: BotMood
}) {
  const host = useRef<HTMLSpanElement>(null)
  const bot = useRef<GrokBot | null>(null)
  const state = mood ? MOOD[mood].state : STATE[status]
  // Read when the character is built, so a still one is drawn in its mood.
  const moodNow = useRef(mood)
  useEffect(() => {
    moodNow.current = mood
  }, [mood])

  useEffect(() => {
    const node = host.current
    if (!node) return
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    const first = moodNow.current
    const created = new GrokBot(node, {
      shape,
      color,
      size,
      state,
      still,
      eyeSize: 1.35,
      mischief: !first,
      // A still one mustn't be caught mid-blink while it is settled below.
      autonomous: !(still && first),
    })
    bot.current = created
    // Without motion grokbot draws a single frame as it is built, with its
    // eyes at rest; settle them into the mood and draw that frame again.
    if (still && first) {
      const { face, gaze } = MOOD[first]
      if (face) created.setExpression(face, true)
      if (gaze) created.look(gaze[0], gaze[1], 1e9)
      settle(created)
    }
    return () => {
      created.destroy()
      bot.current = null
    }
    // State changes are applied below without rebuilding the character.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shape, color, size])

  // Finishing work gets a happy bounce before it settles back to idle.
  useEffect(() => {
    const current = bot.current
    if (!current || current.state === state) return
    if (current.state === "working" && state === "idle") {
      current.setState("done")
      const timer = window.setTimeout(() => bot.current?.setState("idle"), 2400)
      return () => window.clearTimeout(timer)
    }
    current.setState(state)
  }, [state])

  // The mood's face goes on after the state, which resets the eyes.
  useEffect(() => {
    const current = bot.current
    if (!current || !mood) return
    const { face, gaze } = MOOD[mood]
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    if (face) current.setExpression(face, still)
    if (gaze) current.look(gaze[0], gaze[1], 1e9)
    if (still) settle(current)
    if (mood !== "busy" || still) return
    let side = 1
    const dart = window.setInterval(() => {
      side = -side
      bot.current?.look(0.65 * side, 0.1, 1e9)
    }, DART_MS)
    return () => window.clearInterval(dart)
  }, [mood, state, shape, color, size])

  useEffect(() => {
    const current = bot.current
    if (!current || current.state !== "idle") return
    current.morph(hover ? HOVER_SHAPE : shape)
  }, [hover, shape])

  // Each move holds the gaze a moment; once the pointer leaves, the hold runs
  // out and the bot goes back to glancing around on its own.
  useEffect(() => {
    const node = host.current
    if (!watch || !node) return
    const follow = (event: PointerEvent) => {
      const current = bot.current
      if (!current || current.state === "sleeping" || current.state === "typing") return
      const [x, y] = aim(node, event.clientX, event.clientY)
      current.look(x, y, 0.4)
    }
    window.addEventListener("pointermove", follow, { passive: true })
    return () => window.removeEventListener("pointermove", follow)
  }, [watch])

  const body = <span ref={host} className="block shrink-0" style={{ width: size, height: size }} aria-hidden="true" />
  if (mood !== "worried" && mood !== "happy") return body
  return (
    <span className="relative block shrink-0" style={{ width: size, height: size }} aria-hidden="true">
      {body}
      {mood === "worried" ? <Sweat size={size} /> : <Blush shape={shape} size={size} />}
    </span>
  )
}

// Two pink cheeks under the eyes, so a smile isn't read as eyes shut asleep.
function Blush({ shape, size }: { shape: string; size: number }) {
  const [x, y, scale] = (GrokBot.SHAPES[shape] ?? GrokBot.SHAPES.circle).eye
  // grokbot's units run from -1.12 to 1.12 across the box.
  const px = (unit: number) => ((unit + 1.12) / 2.24) * size
  const spread = 0.42 * scale
  const r = Math.max(1.5, size * 0.055)
  return (
    <svg width={size} height={size} className="pointer-events-none absolute inset-0">
      {[-1, 1].map((side) => (
        <ellipse
          key={side}
          cx={px(x + 0.08 + side * spread)}
          cy={px(y + 0.2)}
          rx={r * 1.5}
          ry={r}
          fill="#ff5c8a"
          opacity="0.55"
        />
      ))}
    </svg>
  )
}

// A drop of sweat on the left cheek (the eyes look right), the same as on the
// app icon. It slides down a little and comes back, unless motion is off.
function Sweat({ size }: { size: number }) {
  const width = Math.max(5, Math.round(size * 0.2))
  return (
    <svg
      viewBox="0 0 10 14"
      width={width}
      height={Math.round(width * 1.4)}
      className="bot-sweat pointer-events-none absolute"
      style={{ left: size * 0.04, top: size * 0.3 }}
    >
      <path d="M5 0.6C5 0.6 0.8 6.2 0.8 9.1a4.2 4.2 0 0 0 8.4 0C9.2 6.2 5 0.6 5 0.6Z" fill="#7ab8ff" stroke="#3b82f6" strokeWidth="0.9" />
      <ellipse cx="3.6" cy="9.4" rx="1" ry="1.5" fill="#fff" opacity="0.75" />
    </svg>
  )
}

// grokbot keeps its step to itself. A still character is stepped through a
// second and a half at once so its springs reach the face, then drawn.
function settle(bot: GrokBot) {
  const step = (bot as unknown as { _update?: (dt: number, now: number) => void })._update
  for (let frame = 1; frame <= 90; frame++) step?.call(bot, 1 / 60, frame / 60)
}
