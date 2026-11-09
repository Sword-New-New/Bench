"use client"

import { useEffect, useSyncExternalStore, ViewTransition } from "react"
import { Plus, Settings2 } from "lucide-react"

import { Avatar, seatLook } from "@/components/room/bits"
import { ProjectWreck } from "@/components/room/project-wreck"
import type { BotMood } from "@/components/room/bot"
import type { BenchSeat, Project } from "@/lib/types"

// The projects down the left edge, like a chat app's group list, so what
// happens in the others shows without opening them:
// - a red count: things there waiting on the user (permits, questions,
//   sign-offs; `waiting` from listProjects),
// - a dot: something said there since the user last had it open,
// - who is there: on very wide screens each project is a card with a bench
//   ("并坐") and up to three of its seats sitting on it, the working first;
//   the open project's bench is empty, its seats are out in the room. On
//   narrower ones a column of avatars with a green ring when a seat works.
// - its settings (name, folder, delete): a gear that shows on hover, or a
//   right click on the project.
// Below lg the header's menu does the job.

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

type Item = { project: Project; on: boolean; unread: boolean; notes: string[] }

export function ProjectRail({
  projects,
  current,
  onPick,
  onCreate,
  onEdit,
}: {
  projects: Project[]
  current: string | null
  onPick: (id: string) => void
  onCreate: () => void
  onEdit: (project: Project) => void
}) {
  const seenAt = useSyncExternalStore(subscribe, seenMap, () => EMPTY)

  // The open project counts as read up to now; a project the browser has
  // never recorded starts as read, so a first visit isn't all dots.
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

  const items: Item[] = projects.map((project) => {
    const on = project.id === current
    const unread = !on && project.lastOtherAt > (seenAt[project.id] ?? project.lastOtherAt)
    const notes = [
      project.waiting ? `${project.waiting} 件等你处理` : "",
      project.working ? `${project.working} 个在干活` : "",
      unread ? "有新消息" : "",
    ].filter(Boolean)
    return { project, on, unread, notes }
  })

  return (
    <>
      <nav aria-label="项目" className="hidden w-16 shrink-0 flex-col items-center gap-2 overflow-y-auto py-3 lg:flex xl:hidden">
        {items.map((item) => (
          <Tile key={item.project.id} item={item} onPick={onPick} onEdit={onEdit} />
        ))}
        <NewButton onCreate={onCreate} className="size-11" />
      </nav>
      <nav aria-label="项目" data-tour="project-rail" className="hidden w-[176px] shrink-0 flex-col gap-2 overflow-y-auto py-3 pr-1 pl-3 xl:flex">
        {items.map((item) => (
          <Card key={item.project.id} item={item} onPick={onPick} onEdit={onEdit} />
        ))}
        <NewButton onCreate={onCreate} className="h-11 w-full" label="新建项目" />
      </nav>
      <ProjectWreck />
    </>
  )
}

type Handlers = { onPick: (id: string) => void; onEdit: (project: Project) => void }

// A right click on a project opens its settings, the way a chat app's group
// list does.
function settingsOnRightClick(project: Project, onEdit: (project: Project) => void) {
  return (event: React.MouseEvent) => {
    event.preventDefault()
    onEdit(project)
  }
}

function Tile({ item, onPick, onEdit }: { item: Item } & Handlers) {
  const { project, on, unread, notes } = item
  return (
    <div className="group relative flex w-full justify-center" onContextMenu={settingsOnRightClick(project, onEdit)}>
      <span
        aria-hidden="true"
        className={`absolute top-1/2 left-0 w-1 -translate-y-1/2 rounded-r-full bg-foreground transition-all duration-200 ${
          on ? "h-8" : unread ? "h-2" : "h-0"
        }`}
      />
      <button
        type="button"
        data-wreck={project.id}
        data-wreck-kind="tile"
        onClick={() => onPick(project.id)}
        aria-current={on ? "page" : undefined}
        aria-label={[project.name, ...notes].join("，")}
        title={[project.name, ...notes].join(" · ")}
        className={`relative grid size-11 place-items-center text-base font-semibold text-white transition-all duration-200 ${
          on ? "rounded-xl" : "rounded-2xl hover:rounded-xl"
        } ${project.working ? "ring-2 ring-emerald-500 ring-offset-2 ring-offset-background" : ""}`}
        style={{ background: tint(project.id) }}
      >
        {firstChar(project.name)}
        <Badge waiting={project.waiting} unread={unread} />
      </button>
      <Gear project={project} onEdit={onEdit} className="-bottom-1 left-[calc(50%+12px)] size-5" />
    </div>
  )
}

function Card({ item, onPick, onEdit }: { item: Item } & Handlers) {
  const { project, on, unread, notes } = item
  const rest = Math.max(0, project.seats - project.bench.length)
  return (
    <div
      data-wreck={project.id}
      data-wreck-kind="card"
      className="group relative w-full shrink-0"
      onContextMenu={settingsOnRightClick(project, onEdit)}
    >
      <button
        type="button"
        onClick={() => onPick(project.id)}
        aria-current={on ? "page" : undefined}
        aria-label={[project.name, ...notes].join("，")}
        title={[project.name, ...notes, project.names.length ? `席位：${project.names.join("、")}` : ""].filter(Boolean).join(" · ")}
        className={`relative w-full rounded-2xl px-3 pt-2 pb-2.5 text-left transition-colors duration-200 ${
          on ? "frost ring-1 ring-foreground/15" : "hover:bg-foreground/[0.04]"
        }`}
      >
        <span className="flex items-center gap-1.5">
          <span className="size-2 shrink-0 rounded-full" style={{ background: tint(project.id) }} aria-hidden="true" />
          <span className={`min-w-0 flex-1 truncate text-[13px] leading-5 ${on || unread ? "font-semibold" : "font-medium text-foreground/80"}`}>
            {project.name}
          </span>
          {project.waiting ? (
            <span className="grid h-[18px] min-w-[18px] shrink-0 place-items-center rounded-full bg-destructive px-1 text-[11px] leading-none font-semibold text-white transition-opacity group-hover:opacity-0">
              {project.waiting > 99 ? "99+" : project.waiting}
            </span>
          ) : unread ? (
            <span className="size-2 shrink-0 rounded-full bg-primary transition-opacity group-hover:opacity-0" aria-hidden="true" />
          ) : null}
        </span>
        <Bench seats={on ? [] : project.bench} rest={on ? 0 : rest} note={on ? "都在房间里" : project.seats ? "" : "空房间"} />
      </button>
      {/* Over the red count while the pointer is on the card; the count is in its title too. */}
      <Gear project={project} onEdit={onEdit} className="top-1.5 right-1.5 size-6" />
    </div>
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
    <span className="relative mt-1.5 block h-[50px]" aria-hidden="true">
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

function Badge({ waiting, unread }: { waiting: number; unread: boolean }) {
  if (waiting) {
    return (
      <span className="absolute -top-1.5 -right-1.5 grid h-5 min-w-5 place-items-center rounded-full bg-destructive px-1 text-[11px] leading-none font-semibold text-white ring-2 ring-background">
        {waiting > 99 ? "99+" : waiting}
      </span>
    )
  }
  if (unread) return <span className="absolute -top-0.5 -right-0.5 size-3 rounded-full bg-primary ring-2 ring-background" />
  return null
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

function firstChar(name: string) {
  return Array.from(name.trim())[0]?.toUpperCase() ?? "?"
}

// A steady colour per project, from its id.
function tint(id: string) {
  let hash = 0
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) | 0
  return `oklch(0.62 0.13 ${Math.abs(hash) % 360})`
}
