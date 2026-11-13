"use client"

import { useEffect, useRef, useState, useSyncExternalStore } from "react"

// The notices about other projects (notify.ts): glass capsules that drop in
// in the middle of the top bar, newest on top, at most three.
//
// In: the capsule falls from above with a small overshoot, out of a blur;
// its dot pops a beat later and sends one ring out; the words follow from
// the left (globals.css, 「Project notices」).
// Staying: LIFE ms, then it goes by itself; no buttons (the user: only
// there to tell, nothing more to handle). The time holds while the pointer
// is on it or the tab is in the background. A click on it, if one wants,
// walks into that project.
// Out: it lifts, shrinks and blurs away while its row closes, so the ones
// under it slide up instead of jumping.

export type Notice = {
  id: string
  project: string
  title: string
  body: string
  // The seat's color for 「做完了」, amber for 「等你处理」.
  color: string
  tone: "done" | "waiting"
  // Not there for the open project (it is where the user already is).
  open?: () => void
}

// How long one stays: long enough to read a line, short enough not to be
// in the way. Nothing to click to make it go.
const LIFE = 6000
const MAX = 3

let notices: (Notice & { key: number; leaving?: boolean })[] = []
let made = 0
const listeners = new Set<() => void>()
const emit = () => {
  for (const listener of listeners) listener()
}

export function pushNotice(notice: Notice) {
  // The same id again (a repeat) takes the old one's place.
  // A new key: it comes in fresh, with its full time.
  notices = [{ ...notice, key: ++made }, ...notices.filter((item) => item.id !== notice.id)]
  // Past three, the oldest leaves.
  notices = notices.map((item, index) => (index >= MAX ? { ...item, leaving: true } : item))
  emit()
}

function dismiss(id: string) {
  notices = notices.map((item) => (item.id === id ? { ...item, leaving: true } : item))
  emit()
}

function remove(id: string) {
  notices = notices.filter((item) => item.id !== id)
  emit()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const EMPTY: typeof notices = []

export function ProjectNotices() {
  const items = useSyncExternalStore(subscribe, () => notices, () => EMPTY)
  return (
    <div aria-live="polite" className="pointer-events-none fixed inset-x-0 top-2 z-50 flex flex-col items-center px-4">
      {items.map((item) => (
        <NoticeRow key={item.key} item={item} />
      ))}
    </div>
  )
}

// One capsule. Its time holds while the pointer is on it or the tab is in
// the background, so it isn't used up unseen.
function NoticeRow({ item }: { item: (typeof notices)[number] }) {
  const [held, setHeld] = useState(false)
  const [hidden, setHidden] = useState(() => typeof document !== "undefined" && document.hidden)
  useEffect(() => {
    const update = () => setHidden(document.hidden)
    document.addEventListener("visibilitychange", update)
    return () => document.removeEventListener("visibilitychange", update)
  }, [])
  const left = useRef(LIFE)
  useEffect(() => {
    if (held || hidden || item.leaving) return
    const started = performance.now()
    const timer = setTimeout(() => dismiss(item.id), left.current)
    return () => {
      clearTimeout(timer)
      left.current -= performance.now() - started
    }
  }, [held, hidden, item.leaving, item.id])

  return (
    <div
      className="pn-row"
      data-leaving={item.leaving ? "" : undefined}
      onTransitionEnd={(event) => {
        if (item.leaving && event.target === event.currentTarget) remove(item.id)
      }}
    >
      <div className="pn-clip">
        <div
          role="status"
          title={item.open ? `点一下进「${item.project}」` : undefined}
          className={`pn raised pointer-events-auto flex h-11 w-fit max-w-[min(560px,calc(100vw-32px))] items-center gap-2.5 rounded-full pr-5 pl-3.5 ${item.open ? "cursor-pointer" : ""}`}
          style={{ "--pn-c": item.color } as React.CSSProperties}
          onPointerEnter={() => setHeld(true)}
          onPointerLeave={() => setHeld(false)}
          onClick={() => {
            if (!item.open) return
            item.open()
            dismiss(item.id)
          }}
        >
          <span className="pn-dot relative grid size-5 shrink-0 place-items-center" aria-hidden="true">
            <span className="pn-ring absolute inset-0 rounded-full" />
            <span className="pn-core size-2.5 rounded-full" />
          </span>
          <span className="pn-words flex min-w-0 items-baseline gap-2">
            <span className="max-w-[9rem] shrink-0 truncate text-[11px] font-medium text-muted-foreground">{item.project}</span>
            <span className="shrink-0 text-[13px] font-semibold text-foreground">{item.title}</span>
            <span className="min-w-0 truncate text-[13px] text-muted-foreground">{item.body}</span>
          </span>
        </div>
      </div>
    </div>
  )
}
