"use client"

import { useEffect, useRef, useSyncExternalStore, ViewTransition } from "react"
import { Plus, Settings2 } from "lucide-react"

import { Avatar, seatLook } from "@/components/room/bits"
import type { BotMood } from "@/components/room/bot"
import type { BenchSeat, Project } from "@/lib/types"

// The projects, as the 「项目」 tier of the left column (left-pane.tsx), so
// what happens in the others shows without opening them:
// - a red count: things there waiting on the user (permits, questions,
//   sign-offs; `waiting` from listProjects),
// - a dot: something said there since the user last had it open,
// - who is there: a bench ("并坐") with up to three of its seats sitting on
//   it, the working first, and how many seats and how many at work,
// - its settings (name, folder, delete): a gear that shows on hover, or a
//   right click on the project.
// Below lg the header's menu switches too.

// When the user last had each project open, kept in this browser.
const SEEN_KEY = "bench-project-seen"
let seen: Record<string, number> | null = null
const listeners = new Set<() => void>()

function seenMap(): Record<string, number> {
  if (seen) return seen
  seen = {}
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(SEEN_KEY) ?? "{}")
    if (parsed && typeof parsed === "object") seen = parsed as Record<string, number>
  } catch {}
  return seen
}

function saveSeen(next: Record<string, number>) {
  seen = next
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(next))
  } catch {}
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const EMPTY: Record<string, number> = {}

// A seat's bot on a bench and its lamp in the roster share this name. When a
// project switch swaps both in one transition (room-app.tsx), the old
// project's seats fly from the roster back onto its bench and the new one's
// leave their bench for the roster (CSS: bench-in / bench-out in globals.css).
export function seatFlight(id: string) {
  return `seat-${id.replace(/[^\w-]/g, "_")}`
}

// Seats hop once when they said something after the page loaded.
const PAGE_AT = typeof window === "undefined" ? 0 : Date.now()

// `anchor`: the card the room grows out of and shrinks back into (left-pane.tsx):
// the one clicked, or else the open project. Only it carries the shared
// names, so nothing else is lifted out while the tiers swap.
type Item = { project: Project; on: boolean; anchor: boolean; unread: boolean; notes: string[] }

// The 「项目」 tier of the left column (left-pane.tsx): a card per project,
// then 「新建项目」. `picking`: clicked, on its way in; the other cards fade
// off away from it at once (CSS: .tier-leaving), before its room is there.
export function ProjectList({
  projects,
  current,
  picking,
  motion,
  cardRef,
  onPick,
  onPrefetch,
  onCreate,
  onEdit,
}: {
  projects: Project[]
  current: string | null
  picking: string | null
  // "out": the tier just opened; the cards come in outwards from the anchor.
  motion: "in" | "out" | null
  // The anchor card's button, for focus when the tier opens.
  cardRef: React.Ref<HTMLButtonElement>
  onPick: (id: string) => void
  // Fetch a project's room ahead, while the pointer is on it.
  onPrefetch?: (id: string) => void
  onCreate: () => void
  onEdit: (project: Project) => void
}) {
  const seenAt = useSyncExternalStore(subscribe, seenMap, () => EMPTY)
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current)
  }, [])
  const handlers: Handlers = {
    onPick,
    onEdit,
    // A short rest on a project before fetching, so sweeping the pointer
    // across the list doesn't fetch every room; a press fetches at once.
    ahead: (id, now) => {
      if (hoverTimer.current) clearTimeout(hoverTimer.current)
      hoverTimer.current = null
      if (!onPrefetch || id === null || id === current) return
      if (now) onPrefetch(id)
      else hoverTimer.current = setTimeout(() => onPrefetch(id), AHEAD_AFTER)
    },
  }
  useSeen(projects, current)

  const anchorId = picking ?? current
  const items: Item[] = projects.map((project) => {
    const on = project.id === current
    const unread = !on && project.lastOtherAt > (seenAt[project.id] ?? project.lastOtherAt)
    const notes = [
      project.waiting ? `${project.waiting} 件等你处理` : "",
      project.working ? `${project.working} 个在干活` : "",
      unread ? "有新消息" : "",
    ].filter(Boolean)
    return { project, on, anchor: project.id === anchorId, unread, notes }
  })
  const at = Math.max(0, items.findIndex((item) => item.anchor))

  return (
    <div className={`flex flex-col gap-2 ${picking ? "tier-leaving" : ""}`}>
      {items.map((item, index) => (
        <div
          key={item.project.id}
          className="tier-card"
          // Which side of the anchor and how far: the cards leave away from
          // it and come back outwards from it, one after another (globals.css).
          style={{ "--dir": Math.sign(index - at), "--far": Math.min(Math.abs(index - at), 6) } as React.CSSProperties}
          data-anchor={item.anchor || undefined}
          data-motion={motion === "out" && !item.anchor ? "in" : undefined}
        >
          <Card item={item} buttonRef={item.anchor ? cardRef : undefined} {...handlers} />
        </div>
      ))}
      <div className="tier-card" style={{ "--dir": 1, "--far": Math.min(items.length - at, 6) } as React.CSSProperties} data-motion={motion === "out" ? "in" : undefined}>
        <NewButton onCreate={onCreate} className="h-11 w-full" label="新建项目" />
      </div>
    </div>
  )
}

// The open project counts as read up to now; a project the browser has
// never recorded starts as read, so a first visit isn't all dots.
export function useSeen(projects: Project[], current: string | null) {
  useEffect(() => {
    const next = { ...seenMap() }
    let changed = false
    for (const project of projects) {
      const was = next[project.id]
      if (project.id === current) {
        if (was === undefined || was < project.lastOtherAt) {
          next[project.id] = Math.max(project.lastOtherAt, Date.now())
          changed = true
        }
      } else if (was === undefined) {
        next[project.id] = project.lastOtherAt
        changed = true
      }
    }
    if (changed) saveSeen(next)
  }, [projects, current])
}

type Handlers = {
  onPick: (id: string) => void
  onEdit: (project: Project) => void
  // Pointer on a project (now: pressed), or off it (null).
  ahead: (id: string | null, now?: boolean) => void
}

const AHEAD_AFTER = 120

function aheadProps(id: string, ahead: Handlers["ahead"]) {
  return {
    onPointerEnter: () => ahead(id),
    onPointerLeave: () => ahead(null),
    onPointerDown: () => ahead(id, true),
  }
}

// A right click on a project opens its settings, the way a chat app's group
// list does.
function settingsOnRightClick(project: Project, onEdit: (project: Project) => void) {
  return (event: React.MouseEvent) => {
    event.preventDefault()
    onEdit(project)
  }
}

// The project's dot and name: on the anchor card they share a name with the
// room's title (left-pane.tsx), and slide there when the room opens.
export function ProjectTitle({ project, shared, strong }: { project: Pick<Project, "id" | "name">; shared: boolean; strong: boolean }) {
  const title = (
    <span className="inline-flex max-w-full min-w-0 items-center gap-1.5 align-middle">
      <span className="size-2 shrink-0 rounded-full" style={{ background: tint(project.id) }} aria-hidden="true" />
      <span className={`min-w-0 truncate text-[13px] leading-5 ${strong ? "font-semibold" : "font-medium text-foreground/80"}`}>{project.name}</span>
    </span>
  )
  if (!shared) return title
  return (
    <ViewTransition name="tier-title" share="tier-title" default="none">
      {title}
    </ViewTransition>
  )
}

function Card({ item, buttonRef, onPick, onEdit, ahead }: { item: Item; buttonRef?: React.Ref<HTMLButtonElement> } & Handlers) {
  const { project, on, anchor, unread, notes } = item
  const rest = Math.max(0, project.seats - project.bench.length)
  const card = (
    <div
      data-wreck={project.id}
      data-wreck-kind="card"
      className="group relative w-full shrink-0"
      onContextMenu={settingsOnRightClick(project, onEdit)}
    >
      <button
        ref={buttonRef}
        type="button"
        onClick={() => onPick(project.id)}
        {...aheadProps(project.id, ahead)}
        aria-current={on ? "page" : undefined}
        aria-label={[project.name, on ? "当前项目，点了回到房间" : "", ...notes].filter(Boolean).join("，")}
        title={[project.name, ...notes, project.names.length ? `席位：${project.names.join("、")}` : ""].filter(Boolean).join(" · ")}
        className={`relative w-full rounded-2xl px-3 pt-2 pb-2.5 text-left transition-colors duration-200 ${
          on || anchor ? "frost ring-1 ring-foreground/15" : "bg-foreground/[0.03] ring-1 ring-foreground/[0.06] hover:bg-foreground/[0.06]"
        }`}
      >
        <span className="flex items-center gap-1.5">
          <span className="min-w-0 flex-1">
            <ProjectTitle project={project} shared={anchor} strong={on || anchor || unread} />
          </span>
          {project.waiting ? (
            <span className="grid h-[18px] min-w-[18px] shrink-0 place-items-center rounded-full bg-destructive px-1 text-[11px] leading-none font-semibold text-white transition-opacity group-hover:opacity-0">
              {project.waiting > 99 ? "99+" : project.waiting}
            </span>
          ) : unread ? (
            <span className="size-2 shrink-0 rounded-full bg-primary transition-opacity group-hover:opacity-0" aria-hidden="true" />
          ) : null}
        </span>
        <span className="flex items-end gap-3">
          <Bench seats={project.bench} rest={rest} note={project.seats ? "" : "空房间"} />
          <span className="mb-[-4px] ml-auto shrink-0 text-right text-[11px] leading-4 text-muted-foreground">
            {project.working ? <span className="block text-cyan-700 dark:text-cyan-300">{project.working} 个在做</span> : null}
            <span className="block">{project.seats ? `${project.seats} 个席位` : ""}</span>
            {on ? <span className="block font-medium text-foreground/70">当前</span> : null}
          </span>
        </span>
      </button>
      {/* Over the red count while the pointer is on the card; the count is in its title too. */}
      <Gear project={project} onEdit={onEdit} className="top-1.5 right-1.5 size-6" />
    </div>
  )
  if (!anchor) return card
  // Grows into the room's panel, and the panel shrinks back into it.
  return (
    <ViewTransition name="tier-pane" share="tier-pane" default="none">
      {card}
    </ViewTransition>
  )
}

// The settings button: out of sight until the pointer is on the project, or
// the keyboard reaches it.
function Gear({ project, onEdit, className }: { project: Project; onEdit: (project: Project) => void; className: string }) {
  return (
    <button
      type="button"
      onClick={() => onEdit(project)}
      title={`「${project.name}」的设置：改名、换文件夹、删除`}
      aria-label={`「${project.name}」的设置`}
      className={`absolute grid place-items-center rounded-full bg-background/90 text-muted-foreground opacity-0 shadow-sm ring-1 ring-foreground/10 transition-opacity group-hover:opacity-100 hover:text-foreground focus-visible:opacity-100 ${className}`}
    >
      <Settings2 className="size-3.5" />
    </button>
  )
}

// A plank on two legs, with the seats resting on it: bots have no legs, so
// they sink a little into the top edge instead. Fewer than three get faint
// empty places; more than three show as a +N tag at the plank's end.
function Bench({ seats, rest, note }: { seats: BenchSeat[]; rest: number; note: string }) {
  const free = note ? 0 : 3 - seats.length
  // Working seats jump in a quick wave, in seat order.
  let turns = 0
  return (
    <span className="relative mt-1.5 block h-[50px] w-[150px] shrink-0" aria-hidden="true">
      {note ? (
        <span className="absolute inset-x-0 bottom-1 text-center text-[11px] leading-none text-muted-foreground">{note}</span>
      ) : (
        <span className="absolute inset-x-0 -bottom-[3px] flex h-[38px] items-end gap-1 pl-1.5">
          {seats.map((seat) => (
            <Sitter key={seat.id} seat={seat} turn={seat.status === "working" ? turns++ : -1} />
          ))}
          {Array.from({ length: free }, (_, index) => (
            <span key={index} className="mb-[3px] block size-7 rounded-full border border-dashed border-foreground/20" />
          ))}
        </span>
      )}
      <span data-wreck-plank data-wreck-wood className="absolute inset-x-0 bottom-[-6px] h-[6px] rounded-[3px] bg-[#b98a5e] shadow-[0_1px_0_#8c6440] dark:bg-[#8c6440] dark:shadow-[0_1px_0_#5e4128]" />
      <span data-wreck-wood className="absolute bottom-[-14px] left-3 h-2 w-[3px] rounded-b-sm bg-[#8c6440] dark:bg-[#5e4128]" />
      <span data-wreck-wood className="absolute right-3 bottom-[-14px] h-2 w-[3px] rounded-b-sm bg-[#8c6440] dark:bg-[#5e4128]" />
      {rest ? (
        <span className="absolute right-0 bottom-[3px] grid h-[18px] min-w-[26px] place-items-center rounded-full bg-foreground/10 px-1.5 text-[11px] leading-none font-semibold text-foreground/70">
          +{rest}
        </span>
      ) : null}
    </span>
  )
}

// The face says what the seat is up to (bot.tsx moods): worried while it
// waits on the user, busy at work, happy with a task up for sign-off,
// asleep when gone. Otherwise no mood, and the bot idles as usual.
function moodOf(seat: BenchSeat): BotMood | undefined {
  if (seat.waiting) return "worried"
  if (seat.status === "working") return "busy"
  if (seat.review) return "happy"
  if (seat.status === "offline") return "asleep"
  return undefined
}

function Sitter({ seat, turn }: { seat: BenchSeat; turn: number }) {
  const look = seatLook(seat)
  const away = seat.status === "offline"
  const hop = (seat.saidAt ?? 0) > PAGE_AT
  const mood = look.kind ? moodOf(seat) : undefined
  return (
    <ViewTransition name={seatFlight(seat.id)} share="bench-in" default="none">
      <span
        className={`relative block ${turn >= 0 ? "origin-bottom animate-[bench-turn_2.4s_ease-in-out_infinite]" : ""}`}
        data-wreck-seat={seat.id}
        style={turn > 0 ? { animationDelay: `${turn * 0.12}s` } : undefined}
        title={seat.name}
      >
        {/* Keyed by when it last spoke, so each new message replays the hop. */}
        <span key={hop ? seat.saidAt : "still"} className={`block ${hop ? "animate-[bench-hop_0.6s_ease-out_1]" : ""}`}>
          {/* Grey when away, but the "!" above stays red. */}
          <span className={`block transition-[filter,opacity] duration-300 ${away ? "opacity-60 grayscale" : ""}`}>
            <Avatar
              name={seat.name}
              color={look.color}
              label={look.label}
              kind={look.kind}
              size="md"
              status={look.kind && !mood ? seat.status : undefined}
              mood={mood}
            />
          </span>
        </span>
        {seat.waiting ? (
          <span className="absolute -top-2 left-1/2 grid size-3.5 -translate-x-1/2 place-items-center rounded-full bg-destructive text-[9px] leading-none font-bold text-white ring-2 ring-background">
            !
          </span>
        ) : null}
      </span>
    </ViewTransition>
  )
}

function NewButton({ onCreate, className, label }: { onCreate: () => void; className: string; label?: string }) {
  return (
    <button
      type="button"
      onClick={onCreate}
      aria-label="新建项目"
      title="新建项目"
      className={`flex shrink-0 items-center justify-center gap-1.5 rounded-2xl border border-dashed border-foreground/25 text-sm text-muted-foreground transition-all duration-200 hover:rounded-xl hover:border-foreground/50 hover:text-foreground ${className}`}
    >
      <Plus className="size-5" />
      {label ? <span>{label}</span> : null}
    </button>
  )
}

// A steady colour per project, from its id.
export function tint(id: string) {
  let hash = 0
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) | 0
  return `oklch(0.62 0.13 ${Math.abs(hash) % 360})`
}
