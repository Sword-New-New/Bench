"use client"

import { useSyncExternalStore } from "react"
import { toast } from "sonner"

import { api } from "@/components/room/api"

// What clicking a reference in a message does (components/room/markdown.tsx):
// a message or task id takes you to it (Thread and RoomApp listen for
// GOTO_EVENT), a file opens in the editor (the room starts it, see
// lib/open-ref.ts), a commit opens in CommitDialog.

export const GOTO_EVENT = "bench:goto"

// Open another project, at a to-do there (the front desk's cards, relay-card.tsx).
export const OPEN_PROJECT_EVENT = "bench:open-project"
export type OpenProject = { project: string; task?: string }
export function openProjectAt(project: string, task?: string) {
  window.dispatchEvent(new CustomEvent<OpenProject>(OPEN_PROJECT_EVENT, { detail: { project, task } }))
}
export type Goto = { kind: "message" | "task"; id: string }

// 「t_…」 in a message reads as the to-do's title when this room knows it
// (RoomApp keeps the list here as the room updates); the id is what hovering
// shows. A to-do not in the list, or in another project, stays as its id.
const taskTitles = new Map<string, string>()
const titleListeners = new Set<() => void>()

export function rememberTasks(tasks: { id: string; title: string }[]) {
  let changed = false
  for (const task of tasks) {
    if (taskTitles.get(task.id) === task.title) continue
    taskTitles.set(task.id, task.title)
    changed = true
  }
  if (changed) for (const listener of [...titleListeners]) listener()
}

export function useTaskTitle(id: string | undefined) {
  return useSyncExternalStore(
    (listener) => {
      titleListeners.add(listener)
      return () => {
        titleListeners.delete(listener)
      }
    },
    () => (id ? taskTitles.get(id) : undefined),
    () => undefined,
  )
}

export function goto(kind: Goto["kind"], id: string) {
  window.dispatchEvent(new CustomEvent<Goto>(GOTO_EVENT, { detail: { kind, id } }))
}

// A path in a message: shown in the file manager by default; `editor` opens
// it in the editor at its line instead (Ctrl/⌘-click, components/room/markdown.tsx).
export async function openFile(path: string, line: number | undefined, from: string | undefined, editor = false) {
  try {
    const opened = await api<{ file: string; line: number | null; editor: string }>("/api/v1/open", {
      method: "POST",
      body: JSON.stringify({ as: "human", path, line, from, in: editor ? "editor" : "folder" }),
    })
    const name = opened.file.split("/").pop() || opened.file
    const shortName = name.length > 10 ? `${name.slice(0, 9)}…` : name
    toast.success(editor ? `已打开 ${shortName}` : `已在文件夹里显示 ${shortName}`)
  } catch (error) {
    toast.error((error as Error).message)
  }
}

let commit: { hash: string; from?: string } | null = null
const listeners = new Set<() => void>()

export function showCommit(hash: string, from?: string) {
  commit = { hash, from }
  for (const listener of listeners) listener()
}

export function closeCommit() {
  commit = null
  for (const listener of listeners) listener()
}

export function useCommit() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => commit,
    () => null,
  )
}
