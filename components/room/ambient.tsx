"use client"

import { useEffect, useRef } from "react"

import { makeAurora } from "@/components/room/aurora"
import { KINDS } from "@/lib/kinds"

// 「背景缓慢流动」 in the settings menu: the dark wallpaper's ribbons drift.
// Off unless turned on; kept per browser.
export const FLOW_KEY = "bench-aurora-flow"
export const FLOW_EVENT = "bench-aurora-flow"

export function flowOn() {
  try {
    return localStorage.getItem(FLOW_KEY) === "on"
  } catch {
    return false
  }
}

export function setFlow(on: boolean) {
  try {
    localStorage.setItem(FLOW_KEY, on ? "on" : "off")
  } catch {}
  window.dispatchEvent(new Event(FLOW_EVENT))
}

// While flowing, frames per second: slow drift needs few.
const FLOW_FPS = 24

// Where each colored light starts and which way it drifts.
const LIGHTS = [
  { left: "-12%", top: "-18%", dx: "18vw", dy: "10vh" },
  { left: "62%", top: "-22%", dx: "-14vw", dy: "16vh" },
  { left: "30%", top: "38%", dx: "12vw", dy: "-14vh" },
  { left: "-16%", top: "58%", dx: "16vw", dy: "-8vh" },
  { left: "70%", top: "56%", dx: "-18vw", dy: "-12vh" },
]

// Slow light in the five agents' colors, behind everything. Glass needs
// something behind it to bend; a flat page makes it look like plain plastic.
export function Ambient() {
  const box = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  useAurora(box, canvas)
  return (
    <div ref={box} className="ambient" aria-hidden="true">
      {/* The dark theme's wallpaper (aurora.ts); hidden in the light one. */}
      <canvas ref={canvas} className="ambient-gl" />
      {KINDS.filter((kind) => kind.core).map((kind, index) => {
        const light = LIGHTS[index % LIGHTS.length]
        return (
          <span
            key={kind.id}
            style={
              {
                left: light.left,
                top: light.top,
                "--c": kind.color,
                "--dx": light.dx,
                "--dy": light.dy,
                animationDelay: `${index * -7}s`,
              } as React.CSSProperties
            }
          />
        )
      })}
    </div>
  )
}

// Draws the dark wallpaper: once, and again only when the window's size
// changes; every 1/FLOW_FPS s while 「背景缓慢流动」 is on, the page is
// dark and visible, and motion isn't reduced. Without WebGL the box gets
// data-gl="off" and CSS shows the old image instead.
function useAurora(box: React.RefObject<HTMLDivElement | null>, canvas: React.RefObject<HTMLCanvasElement | null>) {
  useEffect(() => {
    const node = canvas.current
    const holder = box.current
    if (!node || !holder) return
    const aurora = makeAurora(node)
    if (!aurora) {
      holder.setAttribute("data-gl", "off")
      return
    }
    holder.setAttribute("data-gl", "on")
    const still = window.matchMedia("(prefers-reduced-motion: reduce)")
    let frame = 0
    let last = 0
    // The drift's own clock: runs only while flowing, so turning it on or
    // off (or leaving the tab) carries on from where the ribbons are.
    let held = 0
    let since: number | null = null
    const clock = () => held + (since === null ? 0 : (performance.now() - since) / 1000)
    const flowing = () => flowOn() && !still.matches && !document.hidden && document.documentElement.classList.contains("dark")
    const tick = (at: number) => {
      frame = 0
      if (!flowing()) return
      if (at - last >= 1000 / FLOW_FPS) {
        last = at
        aurora.draw(clock())
      }
      frame = requestAnimationFrame(tick)
    }
    const redraw = () => {
      if (flowing()) {
        if (since === null) since = performance.now()
      } else if (since !== null) {
        held = clock()
        since = null
      }
      aurora.draw(clock())
      if (flowing() && !frame) frame = requestAnimationFrame(tick)
    }
    redraw()
    let resizing = 0
    const onResize = () => {
      cancelAnimationFrame(resizing)
      resizing = requestAnimationFrame(redraw)
    }
    window.addEventListener("resize", onResize)
    window.addEventListener(FLOW_EVENT, redraw)
    document.addEventListener("visibilitychange", redraw)
    still.addEventListener("change", redraw)
    // Switching to the dark theme starts the flow if it is on.
    const themes = new MutationObserver(redraw)
    themes.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] })
    return () => {
      cancelAnimationFrame(frame)
      cancelAnimationFrame(resizing)
      window.removeEventListener("resize", onResize)
      window.removeEventListener(FLOW_EVENT, redraw)
      document.removeEventListener("visibilitychange", redraw)
      still.removeEventListener("change", redraw)
      themes.disconnect()
      aurora.dispose()
    }
  }, [box, canvas])
}
