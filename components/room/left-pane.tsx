"use client"

import {
  addTransitionType,
  startTransition,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  ViewTransition,
  type ReactNode,
} from "react"
import { ChevronLeft } from "lucide-react"

import { ProjectList, ProjectTitle, seatFlight } from "@/components/room/project-rail"
import { ProjectWreck } from "@/components/room/project-wreck"
import type { Project, ProjectInfo } from "@/lib/types"

// The left column has two tiers, one at a time, 300 wide like the right one:
// - 「房间」: the open project's seats (roster.tsx), with 「← 项目」 at the top;
// - 「项目」: a card per project with its bench (project-rail.tsx).
// A click on a card walks into that room, 「← 项目」 walks back out. The
// middle and the right column always show the open project; looking around
// the 项目 tier changes nothing there until another project is clicked.
//
// Walking in (globals.css, 「Left column tiers」): the other cards fade off
// away from the clicked one (`picking`, CSS, LEAD ms), then one transition
// swaps the tiers: the card grows into the panel (`tier-pane`), its name
// slides up into the title (`tier-title`), the seats on its bench fly to
// their rows (seatFlight, staggered by `flightDelays`), and the rows fade in
// (`motion` "in"). Walking out runs it backwards, quicker. Another project's
// room comes in the same transition as its snapshot (room-app.tsx
// openProject `then`), so the seats have their rows to fly to.

export type Tier = "room" | "projects"

// The tour switches tiers to show what it points at.
export const LEFT_TIER = "bench-left-tier"

// The other cards' fade before the tiers swap.
const LEAD = 110
// How long the rows' entrance classes stay on.
const SETTLE = 700

// Starting a new swap while one is still playing jumps to the new one:
// the running one is finished at once instead of queued behind.
function skipRunning() {
  const running = (document as Document & { activeViewTransition?: { skipTransition(): void } | null }).activeViewTransition
  running?.skipTransition()
}

export function LeftPane({
  projects,
  current,
  className,
  onOpen,
  onPrefetch,
  onCreate,
  onEdit,
  roster,
}: {
  projects: Project[]
  current: ProjectInfo
  className: string
  // Open another project; `then` runs in the same transition as its room.
  onOpen: (id: string, then?: () => void) => void
  onPrefetch: (id: string) => void
  onCreate: () => void
  onEdit: (project: Project) => void
  // The room tier: the roster, with this at the top of it.
  roster: (head: ReactNode) => ReactNode
}) {
  const [tier, setTier] = useState<Tier>("room")
  const [motion, setMotion] = useState<"in" | "out" | null>(null)
  const [picking, setPicking] = useState<string | null>(null)
  const lead = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Each swap's number: a late one (a room that arrived after the user moved
  // on) doesn't switch tiers.
  const turn = useRef(0)
  const moved = useRef(false)
  const backRef = useRef<HTMLButtonElement>(null)
  const cardRef = useRef<HTMLButtonElement>(null)

  const cancelLead = () => {
    if (lead.current) clearTimeout(lead.current)
    lead.current = null
  }
  useEffect(() => cancelLead, [])

  const enter = (id: string) => {
    skipRunning()
    cancelLead()
    const mine = ++turn.current
    setPicking(id)
    const swap = () => {
      if (turn.current !== mine) return
      moved.current = true
      addTransitionType("tier-enter")
      setTier("room")
      setMotion("in")
      setPicking(null)
    }
    if (id === current.id) {
      lead.current = setTimeout(() => startTransition(swap), LEAD)
    } else {
      onPrefetch(id)
      lead.current = setTimeout(() => onOpen(id, swap), LEAD)
    }
  }

  const leave = () => {
    skipRunning()
    cancelLead()
    turn.current++
    // A project still on its way is called off.
    onOpen(current.id)
    moved.current = true
    startTransition(() => {
      addTransitionType("tier-leave")
      setTier("projects")
      setMotion("out")
      setPicking(null)
    })
  }

  useEffect(() => {
    if (!motion) return
    const timer = setTimeout(() => setMotion(null), SETTLE)
    return () => clearTimeout(timer)
  }, [motion])

  // Keyboard: in the room the focus goes to 「← 项目」, back out to the card.
  // Before the new tier is captured, so the list is already scrolled to it.
  useLayoutEffect(() => {
    if (!moved.current) return
    moved.current = false
    if (tier === "room") backRef.current?.focus({ preventScroll: true })
    else {
      cardRef.current?.scrollIntoView({ block: "nearest" })
      cardRef.current?.focus({ preventScroll: true })
    }
  }, [tier])

  // The tour asks for a tier.
  const tierRef = useRef(tier)
  useEffect(() => {
    tierRef.current = tier
  })
  useEffect(() => {
    const onTier = (event: Event) => {
      const want = (event as CustomEvent<Tier>).detail
      if (want === tierRef.current) return
      cancelLead()
      turn.current++
      setPicking(null)
      startTransition(() => setTier(want))
    }
    window.addEventListener(LEFT_TIER, onTier)
    return () => window.removeEventListener(LEFT_TIER, onTier)
  }, [])

  // What the room tier can't show of the others: how much waits there, and
  // whether anyone works there.
  const others = projects.filter((project) => project.id !== current.id)
  const waiting = others.reduce((sum, project) => sum + project.waiting, 0)
  const busy = others.some((project) => project.working > 0)

  // The seats on the anchor's bench take off one after another.
  const anchor = projects.find((project) => project.id === (picking ?? current.id))
  const flightDelays = (anchor?.bench ?? [])
    .map(
      (seat, index) =>
        `html:active-view-transition-type(tier-enter)::view-transition-group(${seatFlight(seat.id)}){animation-delay:${40 + index * 25}ms !important}`,
    )
    .join("\n")

  const head = (
    <span className="flex min-w-0 items-center gap-2">
      <button
        ref={backRef}
        type="button"
        onClick={leave}
        title={[
          "回到项目列表（Esc）",
          waiting ? `别的项目里有 ${waiting} 件等你处理` : "",
          busy ? "别的项目里有人在做" : "",
        ]
          .filter(Boolean)
          .join(" · ")}
        aria-label={["项目列表", waiting ? `别的项目里 ${waiting} 件等你处理` : "", busy ? "有人在做" : ""].filter(Boolean).join("，")}
        className="tier-back relative -ml-1.5 flex h-6 shrink-0 items-center gap-0.5 rounded-full pr-2 pl-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
      >
        <ChevronLeft className="size-4" />
        项目
        {waiting ? (
          <span className="ml-1 grid h-4 min-w-4 place-items-center rounded-full bg-destructive px-1 text-[10px] leading-none font-semibold text-white">
            {waiting > 99 ? "99+" : waiting}
          </span>
        ) : null}
        {busy ? <span className="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-cyan-500" aria-hidden="true" /> : null}
      </button>
      <span className="min-w-0">
        <ProjectTitle project={current} shared strong />
      </span>
    </span>
  )

  return (
    <div
      className={`${className} ${motion === "in" ? "tier-in" : ""}`}
      onKeyDown={(event) => {
        if (event.key === "Escape" && tier === "room" && !event.defaultPrevented) {
          event.preventDefault()
          leave()
        }
      }}
    >
      {flightDelays ? <style>{`@media (prefers-reduced-motion: no-preference) {\n${flightDelays}\n}`}</style> : null}
      {tier === "room" ? (
        <ViewTransition name="tier-pane" share="tier-pane" default="none">
          <div data-tour="roster" className="frost h-full min-h-0 overflow-hidden lg:rounded-2xl">
            {roster(head)}
          </div>
        </ViewTransition>
      ) : (
        <nav aria-label="项目" data-tour="project-rail" className="flex h-full min-h-0 flex-col">
          <div className="flex h-12 shrink-0 items-center gap-2 px-4 pt-2">
            <h2 className="flex-1 text-xs font-semibold tracking-wider text-muted-foreground uppercase">项目</h2>
            <span className="text-[11px] text-muted-foreground/80">点一个进去</span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-1 pt-1 pb-3">
            <ProjectList
              projects={projects}
              current={current.id}
              picking={picking}
              motion={motion}
              cardRef={cardRef}
              onPick={enter}
              onPrefetch={onPrefetch}
              onCreate={onCreate}
              onEdit={onEdit}
            />
          </div>
        </nav>
      )}
      <ProjectWreck />
    </div>
  )
}
