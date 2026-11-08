"use client"

import { KINDS } from "@/lib/kinds"

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
  return (
    <div className="ambient" aria-hidden="true">
      {KINDS.map((kind, index) => {
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
