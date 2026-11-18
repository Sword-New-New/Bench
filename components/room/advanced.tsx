"use client"

import type { ReactNode } from "react"
import { ChevronRight } from "lucide-react"

import { Reveal } from "@/components/room/reveal"

// Shared collapsible 「高级」 section for dialogs: collapsed by default so
// developer-facing knobs stay out of the main flow without removing any feature.
export function AdvancedSection({
  open,
  onToggle,
  note,
  children,
  className = "",
}: {
  open: boolean
  onToggle: () => void
  note?: string
  children: ReactNode
  className?: string
}) {
  return (
    <div className={`min-w-0 border-t border-border/60 pt-2.5 ${className}`}>
      <button
        type="button"
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 rounded-lg py-1 text-left text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        onClick={onToggle}
      >
        <ChevronRight
          className={`size-3.5 shrink-0 transition-transform duration-200 motion-reduce:transition-none ${open ? "rotate-90" : ""}`}
        />
        <span>高级</span>
        {note && !open ? <span className="truncate font-normal text-muted-foreground/80">· {note}</span> : null}
      </button>
      <Reveal open={open}>
        <div className="mt-2 space-y-3 border-l-2 border-border/60 pt-0.5 pb-1 pl-3">{children}</div>
      </Reveal>
    </div>
  )
}
