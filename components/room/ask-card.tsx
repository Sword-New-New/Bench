"use client"

import { useState } from "react"
import { Check, CircleHelp, Loader2, Send } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/components/room/api"
import type { Message } from "@/lib/types"

// A question an agent asked with bench_ask, under its message. Pick an option
// (several, when it allows) or write an answer; it goes out as a reply to the
// question, which hands it back to the asker.
export function AskCard({ message }: { message: Message }) {
  const ask = message.ask
  const [picked, setPicked] = useState<string[]>([])
  const [text, setText] = useState("")
  const [sending, setSending] = useState(false)
  if (!ask) return null

  if (ask.state === "answered") {
    return (
      <div className="mt-1.5 flex max-w-full items-start gap-2 rounded-2xl border border-emerald-500/30 bg-emerald-500/8 px-3 py-2 text-xs">
        <Check className="mt-0.5 size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
        <span className="min-w-0">
          <span className="text-muted-foreground">你回答了：</span>
          <span className="font-medium break-words whitespace-pre-wrap">{ask.answer}</span>
        </span>
      </div>
    )
  }

  const send = async (answer: string) => {
    const clean = answer.trim()
    if (!clean || sending) return
    setSending(true)
    try {
      await api("/api/v1/say", {
        method: "POST",
        body: JSON.stringify({ as: "human", text: clean, replyTo: message.id }),
      })
      setText("")
      setPicked([])
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "没发出去")
    } finally {
      setSending(false)
    }
  }
  const options = ask.options ?? []
  const toggle = (label: string) =>
    setPicked((list) => (list.includes(label) ? list.filter((item) => item !== label) : [...list, label]))

  return (
    <div className="mt-1.5 w-full max-w-md rounded-2xl border border-amber-500/40 bg-card px-3 py-2.5 text-xs shadow-sm ring-2 ring-amber-500/10">
      <p className="flex items-center gap-1.5 font-medium text-amber-700 dark:text-amber-400">
        <CircleHelp className="size-3.5" />
        {message.authorName} 在等你回答{ask.multi ? "（可多选）" : ""}
      </p>
      {options.length > 0 ? (
        <div className="mt-2 flex flex-col gap-1.5">
          {options.map((option) => {
            const on = picked.includes(option.label)
            return (
              <button
                key={option.label}
                type="button"
                disabled={sending}
                className={`flex items-start gap-2 rounded-xl border px-2.5 py-1.5 text-left transition-colors hover:bg-muted disabled:opacity-60 ${
                  on ? "border-primary bg-primary/8" : "bg-background/60"
                }`}
                onClick={() => (ask.multi ? toggle(option.label) : void send(option.label))}
              >
                {ask.multi ? (
                  <span
                    className={`mt-0.5 grid size-3.5 shrink-0 place-items-center rounded border ${on ? "border-primary bg-primary text-primary-foreground" : ""}`}
                  >
                    {on ? <Check className="size-2.5" /> : null}
                  </span>
                ) : null}
                <span className="min-w-0">
                  <span className="block font-medium">{option.label}</span>
                  {option.detail ? <span className="block text-muted-foreground">{option.detail}</span> : null}
                </span>
              </button>
            )
          })}
          {ask.multi ? (
            <button
              type="button"
              disabled={sending || picked.length === 0}
              className="self-end rounded-full bg-primary px-3 py-1 font-medium text-primary-foreground disabled:opacity-50"
              onClick={() => void send(options.filter((option) => picked.includes(option.label)).map((option) => option.label).join("、"))}
            >
              选好了（{picked.length}）
            </button>
          ) : null}
        </div>
      ) : null}
      <form
        className="mt-2 flex items-center gap-1.5"
        onSubmit={(event) => {
          event.preventDefault()
          void send(text)
        }}
      >
        <input
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder={options.length ? "都不对？自己写…" : "写下你的回答…"}
          aria-label={`回答 ${message.authorName} 的问题`}
          className="h-7 min-w-0 flex-1 rounded-full border bg-background/70 px-3 outline-none focus:border-primary"
        />
        <button
          type="submit"
          disabled={sending || !text.trim()}
          className="grid size-7 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground disabled:opacity-50"
          aria-label="发出回答"
        >
          {sending ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
        </button>
      </form>
    </div>
  )
}
