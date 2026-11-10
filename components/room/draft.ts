"use client"

import { useSyncExternalStore } from "react"

// What is being typed in the composer. Kept out of RoomApp's state: there,
// every key redrew the whole room (thread, roster, tasks, rail, the bots),
// and typing lagged. Now only the composer listens; the room reads it when
// it sends, and writes it for @-mentions, edits and clearing.
let value = ""
const listeners = new Set<() => void>()

export const draft = {
  get: () => value,
  set(next: string | ((current: string) => string)) {
    const text = typeof next === "function" ? next(value) : next
    if (text === value) return
    value = text
    for (const listener of listeners) listener()
  },
  subscribe(listener: () => void) {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
}

export function useDraft() {
  return useSyncExternalStore(draft.subscribe, draft.get, () => "")
}
