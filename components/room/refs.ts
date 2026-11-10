"use client"

import { useSyncExternalStore } from "react"
import { toast } from "sonner"

import { api } from "@/components/room/api"

// What clicking a reference in a message does (components/room/markdown.tsx):
// a message or task id takes you to it (Thread and RoomApp listen for
// GOTO_EVENT), a file opens in the editor (the room starts it, see
// lib/open-ref.ts), a commit opens in CommitDialog.

export const GOTO_EVENT = "bench:goto"
export type Goto = { kind: "message" | "task"; id: string }

export function goto(kind: Goto["kind"], id: string) {
  window.dispatchEvent(new CustomEvent<Goto>(GOTO_EVENT, { detail: { kind, id } }))
}

export async function openFile(path: string, line: number | undefined, from: string | undefined) {
  try {
    const opened = await api<{ file: string; line: number | null; editor: string }>("/api/v1/open", {
      method: "POST",
      body: JSON.stringify({ as: "human", path, line, from }),
    })
    const name = opened.file.split("/").pop() || opened.file
    toast.success(`在 ${opened.editor} 里打开了 ${name}${opened.line ? ` 第 ${opened.line} 行` : ""}`)
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
