"use client"

import { useSyncExternalStore } from "react"
import { ArrowLeft, ConciergeBell } from "lucide-react"

import { unreadIn, useSeenAt } from "@/components/room/project-rail"
import { Button } from "@/components/ui/button"
import type { Project, ProjectInfo } from "@/lib/types"

// The front desk (前台): one seat that looks across every project for the
// user. Its room is a project marked `front` (lib/store.ts), pinned at the top
// of the project rail (project-rail.tsx FrontCard). It doesn't stand between
// the user and the rooms: every room goes on as before, and any of them is a
// click away. First stage: it only looks (bench_overview / bench_peek), it
// can't hand out work, sign off or answer permits.

// What a seat opened as the front desk does, as its 分工.
export const FRONT_ROLE = "前台：替你看各项目"
export const FRONT_SEAT = "前台"

// The seat on duty at the desk: the one opened for it (its 分工 starts with
// 前台), else the first there.
export function deskSeat<T extends { demo?: boolean; role?: string }>(agents: T[]) {
  const seats = agents.filter((agent) => !agent.demo)
  return seats.find((agent) => agent.role?.startsWith(FRONT_SEAT)) ?? seats[0]
}

// The last project open before the desk, for 「回到」; kept in this browser so
// a reload at the desk still knows.
const BACK_KEY = "bench-front-back"
const backListeners = new Set<() => void>()

export function rememberBack(id: string) {
  try {
    if (localStorage.getItem(BACK_KEY) === id) return
    localStorage.setItem(BACK_KEY, id)
  } catch {
    return
  }
  for (const listener of backListeners) listener()
}

function readBack() {
  try {
    return localStorage.getItem(BACK_KEY)
  } catch {
    return null
  }
}

export function useBack() {
  return useSyncExternalStore(
    (listener) => {
      backListeners.add(listener)
      return () => backListeners.delete(listener)
    },
    readBack,
    () => null,
  )
}

// The header's way in and back out: 「前台」 from any project, 「回到〈刚才的
// 项目〉」 from the desk. A red count when something there waits on the user,
// a dot when something was said there since the user last looked. Before
// there is a desk it offers to open one.
export function FrontButton({
  front,
  current,
  back,
  onEnter,
  onBack,
  onEnable,
}: {
  front: Project | undefined
  current: ProjectInfo | null
  // Where 「回到」 goes: the project open before the desk.
  back: Project | undefined
  onEnter: () => void
  onBack: () => void
  onEnable: () => void
}) {
  const seenAt = useSeenAt()
  const inFront = Boolean(current?.front)
  const pill = "flex h-7 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium transition-colors"

  if (inFront) {
    if (!back) return null
    return (
      <button
        type="button"
        onClick={onBack}
        title={`回到「${back.name}」`}
        aria-label={`回到「${back.name}」`}
        className={`${pill} max-w-48 text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground`}
      >
        <ArrowLeft className="size-3.5 shrink-0" />
        <span className="shrink-0">回到</span>
        <span className="hidden min-w-0 truncate sm:inline">{back.name}</span>
      </button>
    )
  }

  if (!front) {
    return (
      <button
        type="button"
        onClick={onEnable}
        title="开启前台：挑一个 AI 值班，你只跟它说话，它替你看所有项目做到哪了、什么在等你"
        aria-label="开启前台"
        className={`${pill} text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground`}
      >
        <ConciergeBell className="size-3.5" />
        <span className="hidden sm:inline">前台</span>
      </button>
    )
  }

  const unread = unreadIn(front, seenAt, current?.id ?? null)
  const notes = [front.waiting ? `${front.waiting} 件等你` : "", unread ? "有新消息" : ""].filter(Boolean)
  return (
    <button
      type="button"
      onClick={onEnter}
      data-tour="front"
      title={["去前台：问它各项目做到哪了、什么在等你", ...notes].join(" · ")}
      aria-label={["前台", ...notes].join("，")}
      className={`${pill} relative text-foreground/80 ring-1 ring-primary/25 hover:bg-primary/[0.08] hover:text-foreground`}
    >
      <ConciergeBell className="size-3.5 text-primary" />
      <span className="hidden sm:inline">前台</span>
      {front.waiting ? (
        <span className="grid h-4 min-w-4 place-items-center rounded-full bg-destructive px-1 text-[10px] leading-none font-semibold text-white">
          {front.waiting > 99 ? "99+" : front.waiting}
        </span>
      ) : unread ? (
        <span className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-primary ring-2 ring-background" aria-hidden="true" />
      ) : null}
    </button>
  )
}

// The front room's empty state: what to ask it now, and what it can't do yet.
export function FrontWelcome({
  seat,
  onExample,
  onStaff,
}: {
  seat: string | null
  onExample: (text: string) => void
  onStaff?: () => void
}) {
  const examples = ["各项目现在做到哪了？", "有什么在等我处理？", "哪些席位停着还欠着活？"]
  return (
    <div className="frost mb-6 rounded-2xl px-5 py-6">
      <h2 className="flex items-center gap-2 text-base font-semibold">
        <ConciergeBell className="size-4 text-primary" />
        前台 · 只读阶段
      </h2>
      <p className="mt-1.5 text-sm leading-6 text-muted-foreground">
        {seat ? `${seat} 在这里值班，` : "先接一个 AI 进来值班，"}
        替你看所有项目：各项目做到哪了、谁停着、有什么在等你。每件事都会带上项目名和编号，要处理的它会告诉你去哪个房间。
      </p>
      <p className="mt-1 text-xs leading-5 text-muted-foreground/80">
        现在它只能看：还不能替你派活、验收或批权限。别的房间照常，随时能直接进去。
      </p>
      {seat ? (
        <div className="mt-4 flex flex-wrap gap-2">
          {examples.map((example) => (
            <button
              key={example}
              type="button"
              className="pill chip rounded-full px-3 py-1.5 text-left text-xs"
              onClick={() => onExample(`@${seat} ${example}`)}
            >
              {example}
            </button>
          ))}
        </div>
      ) : onStaff ? (
        <Button type="button" size="sm" className="mt-4 rounded-full" onClick={onStaff}>
          <ConciergeBell />
          挑一个 AI 来值班
        </Button>
      ) : null}
    </div>
  )
}
