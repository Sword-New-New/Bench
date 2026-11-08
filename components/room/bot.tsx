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
}: {
  shape: string
  color: string
  size: number
  status?: AgentStatus
  hover?: boolean
  watch?: boolean
}) {
  const host = useRef<HTMLSpanElement>(null)
  const bot = useRef<GrokBot | null>(null)
  const state = STATE[status]

  useEffect(() => {
    const node = host.current
    if (!node) return
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    const created = new GrokBot(node, { shape, color, size, state, still, eyeSize: 1.35 })
    bot.current = created
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

  return <span ref={host} className="block shrink-0" style={{ width: size, height: size }} aria-hidden="true" />
}
