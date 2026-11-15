"use client"

import { useSyncExternalStore } from "react"

import { FONT_SIZE_KEY as KEY, FONT_SIZES, type FontSizeId } from "@/lib/font-size"

export { FONT_SIZES, type FontSizeId }

// The size lists, the key and the <head> script are in lib/font-size.ts, which
// the server-side layout can import.
const listeners = new Set<() => void>()

function read(): FontSizeId {
  try {
    const saved = localStorage.getItem(KEY)
    return FONT_SIZES.find((size) => size.id === saved)?.id ?? "m"
  } catch {
    return "m"
  }
}

export function setFontSize(id: FontSizeId) {
  const size = FONT_SIZES.find((item) => item.id === id) ?? FONT_SIZES[1]
  document.documentElement.style.fontSize = size.percent === 100 ? "" : `${size.percent}%`
  try {
    if (size.id === "m") localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, size.id)
  } catch {}
  for (const listener of listeners) listener()
}

export function useFontSize() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    read,
    () => "m" as FontSizeId,
  )
}
