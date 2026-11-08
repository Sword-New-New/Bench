import { useState, type ReactNode } from "react"

// Opens and closes its content with a height animation, so whatever sits
// above or below glides instead of jumping. While closing it keeps showing
// the last content it had, since the caller has usually dropped it by then.
export function Reveal({ open, children, className = "" }: { open: boolean; children: ReactNode; className?: string }) {
  const [last, setLast] = useState<ReactNode>(open ? children : null)
  if (open && children !== last) setLast(children)

  return (
    <div
      className={`grid transition-[grid-template-rows,opacity] duration-300 ease-[cubic-bezier(.2,.9,.3,1)] motion-reduce:transition-none ${
        open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
      }`}
      aria-hidden={!open}
      inert={!open}
    >
      <div className="min-h-0 overflow-hidden">
        <div
          className={`transition-transform duration-300 ease-[cubic-bezier(.34,1.45,.64,1)] motion-reduce:transition-none ${
            open ? "translate-y-0" : "translate-y-2"
          } ${className}`}
        >
          {open ? children : last}
        </div>
      </div>
    </div>
  )
}
