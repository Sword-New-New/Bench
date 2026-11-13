"use client"

import { useEffect, useRef } from "react"

import { pushNotice } from "@/components/room/project-notices"
import type { Project } from "@/lib/types"

// Notices for the projects the user isn't looking at: a toast on the page
// always, and a desktop notification too when that's turned on and the page
// isn't in front. What counts: a seat
// there posted 「【本轮结束】」 (lastEnd), or more things wait on the user
// there (waiting: permits, questions, sign-offs). "Not looking at" is any
// project but the open one, and the open one too while the page is in the
// background. They come from the project list's 5-second poll; a tab in the
// background for minutes gets polled less often by the browser (up to once a
// minute), so a notice can come that much later.
//
// 「别的项目做完时也弹桌面通知」 in the settings menu turns the desktop ones on; kept per
// browser, and needs the browser's own permission, asked for when it's
// turned on. (The first version had only desktop ones, off by default: the
// user never saw any.)

export const NOTIFY_KEY = "bench-notify"
export const NOTIFY_EVENT = "bench-notify"

export function notifySupported() {
  return typeof window !== "undefined" && "Notification" in window
}

// On: the user turned it on here and the browser allows it.
export function notifyOn() {
  if (!notifySupported()) return false
  try {
    return localStorage.getItem(NOTIFY_KEY) === "on" && Notification.permission === "granted"
  } catch {
    return false
  }
}

export function onNotifyChange(listener: () => void) {
  window.addEventListener(NOTIFY_EVENT, listener)
  return () => window.removeEventListener(NOTIFY_EVENT, listener)
}

// Turning it on asks the browser first (it has to come from a click).
// Returns what the user ends up with, or "blocked" if the browser says no.
export async function setNotify(on: boolean): Promise<"on" | "off" | "blocked"> {
  let result: "on" | "off" | "blocked" = "off"
  if (on && notifySupported()) {
    const permission = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission
    result = permission === "granted" ? "on" : "blocked"
  }
  try {
    localStorage.setItem(NOTIFY_KEY, result === "on" ? "on" : "off")
  } catch {}
  window.dispatchEvent(new Event(NOTIFY_EVENT))
  return result
}

type Seen = { end?: string; waiting: number }

export function useProjectNotices(projects: Project[] | null, current: string | null, open: (id: string) => void) {
  const seen = useRef(new Map<string, Seen>())
  const openRef = useRef(open)
  useEffect(() => {
    openRef.current = open
  })

  useEffect(() => {
    if (!projects) return
    const desktop = notifyOn()
    const away = document.hidden || !document.hasFocus()
    for (const project of projects) {
      const before = seen.current.get(project.id)
      seen.current.set(project.id, { end: project.lastEnd?.id, waiting: project.waiting })
      // First sight (page just opened, project just made): what's already
      // there isn't news.
      if (!before) continue
      if (project.id === current && !away) continue
      const go = () => openRef.current(project.id)
      const show = (notice: { title: string; body: string; tag: string; color: string; tone: "done" | "waiting" }) => {
        // On the page: always (project-notices.tsx). The tag is its id, so a
        // repeat takes the old one's place.
        pushNotice({
          id: notice.tag,
          project: project.name,
          title: notice.title,
          body: notice.body,
          color: notice.color,
          tone: notice.tone,
          open: project.id === current ? undefined : go,
        })
        // On the desktop too when it's turned on and the page isn't in front.
        if (!desktop || !away) return
        try {
          // The same tag in two open tabs shows once.
          const desk = new Notification(`「${project.name}」${notice.title}`, { body: notice.body, tag: notice.tag, icon: "/bench.png" })
          desk.onclick = () => {
            window.focus()
            go()
            desk.close()
          }
        } catch {}
      }
      const end = project.lastEnd
      if (end && end.id !== before.end) {
        show({ title: `${end.name} 做完了`, body: end.text || "这一轮结束了", tag: `bench-end-${end.id}`, color: end.color || "#22c55e", tone: "done" })
      }
      if (project.waiting > before.waiting) {
        show({ title: `${project.waiting} 件等你处理`, body: "权限、提问或待验收", tag: `bench-wait-${project.id}`, color: "#f59e0b", tone: "waiting" })
      }
    }
  }, [projects, current])
}
