"use client"

import "@xterm/xterm/css/xterm.css"

import { useEffect, useRef, useState } from "react"
import { Loader2, Power } from "lucide-react"
import type { Terminal } from "@xterm/xterm"

import { api, storedHumanKey } from "@/components/room/api"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"

// The live terminal is an advanced, not yet accepted feature: tagged Beta
// wherever it shows (seat menu, roster line, this dialog's title).
export function BetaTag() {
  return (
    <span className="shrink-0 rounded-full bg-violet-500/15 px-1.5 py-px text-[10px] leading-4 font-medium tracking-wide text-violet-700 dark:text-violet-300">
      Beta
    </span>
  )
}

// A seat's session in its client's own screen, live (lib/terminal.ts). Opened
// from the seat menu with this event; closing the dialog leaves it running.
export const TERMINAL_OPEN = "bench-terminal-open"
export type TerminalOpenDetail = { id: string; name: string }

export function openTerminalFor(id: string, name: string) {
  window.dispatchEvent(new CustomEvent<TerminalOpenDetail>(TERMINAL_OPEN, { detail: { id, name } }))
}

type State = "starting" | "live" | "ended" | "failed"

const send = (id: string, body: Record<string, unknown>) =>
  api(`/api/v1/terminal/${id}`, { method: "POST", body: JSON.stringify({ as: "human", ...body }) })

export function TerminalDialog() {
  const [seat, setSeat] = useState<TerminalOpenDetail | null>(null)
  const [state, setState] = useState<State>("starting")
  const [error, setError] = useState("")
  const [host, setHost] = useState<HTMLDivElement | null>(null)
  const term = useRef<Terminal | null>(null)

  useEffect(() => {
    const show = (event: Event) => {
      setSeat((event as CustomEvent<TerminalOpenDetail>).detail)
      setState("starting")
      setError("")
    }
    window.addEventListener(TERMINAL_OPEN, show)
    return () => window.removeEventListener(TERMINAL_OPEN, show)
  }, [])

  useEffect(() => {
    if (!seat || !host) return
    const id = seat.id
    let gone = false
    const reader = new AbortController()
    let observer: ResizeObserver | undefined
    let dispose = () => {}

    void (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")])
      if (gone) return
      const xterm = new Terminal({
        cursorBlink: true,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, \"Noto Sans Mono CJK SC\", \"Source Han Mono SC\", \"Source Han Mono\", \"Sarasa Mono SC\", monospace",
        fontSize: 13,
        scrollback: 5000,
        theme: { background: "#141413", foreground: "#ecebe7" },
      })
      const fit = new FitAddon()
      xterm.loadAddon(fit)
      xterm.open(host)
      fit.fit()
      term.current = xterm

      try {
        await send(id, { action: "open", cols: xterm.cols, rows: xterm.rows })
      } catch (err) {
        if (gone) return
        setError(err instanceof Error ? err.message : "终端没开起来")
        setState("failed")
        return
      }

      // Keys go out together, a frame at a time: a paste is one request.
      let typed = ""
      let queued = 0
      const flush = () => {
        queued = 0
        const data = typed
        typed = ""
        if (data) void send(id, { action: "input", data }).catch(() => {})
      }
      const typing = xterm.onData((data) => {
        typed += data
        queued ||= requestAnimationFrame(flush)
      })
      let sized = 0
      observer = new ResizeObserver(() => {
        fit.fit()
        window.clearTimeout(sized)
        sized = window.setTimeout(() => void send(id, { action: "resize", cols: xterm.cols, rows: xterm.rows }).catch(() => {}), 150)
      })
      observer.observe(host)
      dispose = () => {
        typing.dispose()
        cancelAnimationFrame(queued)
        window.clearTimeout(sized)
        xterm.dispose()
      }

      // The screen: an EventSource can't carry the user's key, so read the stream by hand.
      try {
        const res = await fetch(`/api/v1/terminal/${id}`, {
          headers: { "x-bench-human": storedHumanKey() },
          cache: "no-store",
          signal: reader.signal,
        })
        if (!res.ok || !res.body) {
          const data = (await res.json().catch(() => ({}))) as { error?: string }
          throw new Error(data.error || "读不到终端画面")
        }
        setState("live")
        xterm.focus()
        const decoder = new TextDecoder()
        const stream = res.body.getReader()
        let buffer = ""
        for (;;) {
          const { value, done } = await stream.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          let cut: number
          while ((cut = buffer.indexOf("\n\n")) >= 0) {
            const event = buffer.slice(0, cut)
            buffer = buffer.slice(cut + 2)
            if (event.startsWith("event: exit")) {
              setState("ended")
              continue
            }
            const line = event.split("\n").find((part) => part.startsWith("data: "))
            if (line) xterm.write(JSON.parse(line.slice(6)) as string)
          }
        }
      } catch (err) {
        if (gone) return
        setError(err instanceof Error ? err.message : "读不到终端画面")
        setState("failed")
      }
    })()

    return () => {
      gone = true
      reader.abort()
      observer?.disconnect()
      dispose()
      term.current = null
    }
  }, [seat, host])

  const close = async () => {
    if (!seat) return
    if (!window.confirm(`关掉 ${seat.name} 的终端？它在做的事会停下。会话本身不丢，之后点名照常唤起。`)) return
    try {
      await send(seat.id, { action: "close" })
    } catch {}
  }

  return (
    <Dialog open={seat !== null} onOpenChange={(open) => !open && setSeat(null)}>
      <DialogContent className="flex h-[calc(100dvh-3rem)] flex-col gap-3 sm:max-w-[min(1200px,calc(100vw-3rem))]">
        <DialogHeader className="flex-row items-center gap-2 pr-8">
          <div className="min-w-0 flex-1">
            <DialogTitle className="flex items-center gap-2">
              {seat?.name} 的终端
              <BetaTag />
              {state === "starting" ? <Loader2 className="size-4 animate-spin text-muted-foreground" /> : null}
            </DialogTitle>
            <DialogDescription className="truncate">
              {state === "ended"
                ? "终端已经关了。会话还在，点名会照常在后台唤起它。"
                : state === "failed"
                  ? error
                  : "它自己的界面，你可以直接打字接管。关掉这个窗口终端还开着；开着时点名它，话会打进这里。"}
            </DialogDescription>
          </div>
          {state === "live" ? (
            <Button type="button" variant="outline" size="sm" onClick={close}>
              <Power />
              关掉终端
            </Button>
          ) : null}
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-hidden rounded-lg bg-[#141413] p-2">
          <div ref={setHost} className="size-full" />
        </div>
      </DialogContent>
    </Dialog>
  )
}
