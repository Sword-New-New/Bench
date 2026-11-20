"use client"

import { useCallback, useEffect, useState } from "react"
import { ChevronRight } from "lucide-react"

import { api } from "@/components/room/api"
import { AWAY_AFTER_MS, awayStretch, type AwayLine, type AwayOverview } from "@/lib/away-shared"

// 「你不在的这段时间」: the card at the top of 「等你定」 when the user comes
// back after half an hour. The page notes when it last saw the user
// (localStorage, shared by the tabs); coming back after 30 minutes keeps that
// moment as `awaySince` until 「知道了」. What happened since is asked of the
// room (GET /api/v1/away); nothing is kept on the server about who is here.

const LAST_KEY = "bench:last-active-at"
const AWAY_KEY = "bench:away-since"
const WRITE_EVERY_MS = 60_000

function read(key: string) {
  try {
    const value = Number(window.localStorage.getItem(key))
    return Number.isFinite(value) && value > 0 ? value : 0
  } catch {
    return 0
  }
}

function write(key: string, value: number | null) {
  try {
    if (value === null) window.localStorage.removeItem(key)
    else window.localStorage.setItem(key, String(value))
  } catch {
    // No storage (private window): the card just never shows.
  }
}

// `since` is 0 while the user has not been away. A visit after 30 minutes
// away sets it to the last moment the user was seen; it stays until dismissed.
function useAwaySince() {
  const [since, setSince] = useState(0)
  useEffect(() => {
    const mark = () => {
      if (document.visibilityState !== "visible") return
      const now = Date.now()
      const last = read(LAST_KEY)
      if (last && now - last >= AWAY_AFTER_MS && !read(AWAY_KEY)) write(AWAY_KEY, last)
      if (!last || now - last >= WRITE_EVERY_MS) write(LAST_KEY, now)
      setSince(read(AWAY_KEY))
    }
    mark()
    const onStorage = (event: StorageEvent) => {
      if (event.key === AWAY_KEY) setSince(read(AWAY_KEY))
    }
    const events = ["pointerdown", "keydown", "scroll", "visibilitychange"] as const
    for (const name of events) window.addEventListener(name, mark, { capture: true, passive: true })
    window.addEventListener("storage", onStorage)
    return () => {
      for (const name of events) window.removeEventListener(name, mark, { capture: true })
      window.removeEventListener("storage", onStorage)
    }
  }, [])
  const dismiss = useCallback(() => {
    write(AWAY_KEY, null)
    setSince(0)
  }, [])
  return { since, dismiss }
}

export function AwayCard({
  projectId,
  isFront,
  refreshKey,
  onEnterFull,
  onShowWaiting,
  onOpenProject,
}: {
  projectId: string
  isFront: boolean
  refreshKey: string
  onEnterFull: (taskId?: string) => void
  onShowWaiting: () => void
  onOpenProject: (projectId: string) => void
}) {
  const { since, dismiss } = useAwaySince()
  const [data, setData] = useState<AwayOverview | null>(null)

  useEffect(() => {
    if (!since) return
    let live = true
    // Not on every change of the room: the card only needs to be about right.
    const timer = window.setTimeout(async () => {
      try {
        const query = new URLSearchParams({ since: String(since) })
        if (!isFront) query.set("project", projectId)
        const result = await api<AwayOverview>(`/api/v1/away?${query.toString()}`)
        if (!live) return
        setData(result)
        // Nothing happened anywhere: there is nothing to dismiss.
        if (result.scope === "front" && result.projects.length === 0) dismiss()
      } catch {
        // The card is a nicety: no card if the room cannot say.
      }
    }, 800)
    return () => {
      live = false
      window.clearTimeout(timer)
    }
  }, [since, projectId, isFront, refreshKey, dismiss])

  const count = data ? (data.scope === "front" ? data.projects.length : data.lines.length) : 0
  if (!since || !data || count === 0) return null

  const open = (line: AwayLine, project?: string) => {
    if (project) onOpenProject(project)
    else if (line.target.kind === "task") onEnterFull(line.target.id)
    else if (line.target.kind === "waiting") onShowWaiting()
    else onEnterFull()
  }
  const row = (line: AwayLine, project?: string) => (
    <li key={`${project ?? ""}${line.key}`}>
      <button
        type="button"
        className="group flex w-full items-start gap-1.5 rounded-lg px-1.5 py-1 text-left leading-5 hover:bg-foreground/[0.05]"
        onClick={() => open(line, project)}
      >
        <span className="min-w-0 flex-1 break-words">{line.text}</span>
        <ChevronRight className="mt-0.5 size-3.5 shrink-0 text-muted-foreground opacity-60 group-hover:opacity-100" aria-hidden />
      </button>
    </li>
  )

  return (
    <section
      data-away-card
      aria-label="你不在的这段时间"
      className="rounded-2xl border border-sky-500/30 bg-card px-3.5 py-2.5 text-xs shadow-sm"
    >
      <h3 className="text-[0.8125rem] leading-5 font-semibold">你不在的这段时间</h3>
      <p className="text-[0.6875rem] leading-4 text-muted-foreground">{awayStretch(data.since, data.now)}</p>
      {data.scope === "front" ? (
        <ul className="mt-1.5 space-y-1.5">
          {data.projects.map((project) => (
            <li key={project.projectId}>
              <p className="px-1.5 text-[0.6875rem] font-medium text-muted-foreground">{project.projectName}</p>
              <ul>{project.lines.map((line) => row(line, project.projectId))}</ul>
            </li>
          ))}
        </ul>
      ) : (
        <ul className="mt-1.5">{data.lines.map((line) => row(line))}</ul>
      )}
      <div className="mt-1.5 flex justify-end">
        <button
          type="button"
          className="rounded-full bg-primary px-3 py-1 font-medium text-primary-foreground hover:opacity-90"
          onClick={dismiss}
        >
          知道了
        </button>
      </div>
    </section>
  )
}
