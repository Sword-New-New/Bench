"use client"

import { useEffect, useRef, useState } from "react"
import { ListTree, Loader2, SendHorizontal } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/components/room/api"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Textarea } from "@/components/ui/textarea"
import type { PublicAgent, Run } from "@/lib/types"

const POLL_MS = 1500

// Talking to one seat alone: nothing here goes into the room. Each thing you
// said is one private wake; its answer and steps are kept on that run.
export function WhisperDialog({
  agent,
  onClose,
  onOpenRun,
}: {
  agent: PublicAgent | null
  onClose: () => void
  onOpenRun: (runId: string) => void
}) {
  const [runs, setRuns] = useState<Run[]>([])
  const [text, setText] = useState("")
  const [sending, setSending] = useState(false)
  const list = useRef<HTMLDivElement>(null)
  const agentId = agent?.id ?? null

  const [shownId, setShownId] = useState(agentId)
  if (agentId !== shownId) {
    setShownId(agentId)
    setRuns([])
    setText("")
  }

  useEffect(() => {
    if (!agentId) return
    let stop = false
    let timer = 0
    const load = async () => {
      try {
        const data = await api<{ runs: Run[] }>(`/api/v1/agents/${agentId}`)
        if (!stop) setRuns(data.runs)
      } catch {}
      if (!stop) timer = window.setTimeout(load, POLL_MS)
    }
    void load()
    return () => {
      stop = true
      window.clearTimeout(timer)
    }
  }, [agentId])

  const lastState = runs.at(-1)?.state
  useEffect(() => {
    const node = list.current
    if (node) node.scrollTop = node.scrollHeight
  }, [runs.length, lastState])

  const send = async () => {
    const clean = text.trim()
    if (!agent || !clean || sending) return
    setSending(true)
    try {
      const result = await api<{ interrupted: boolean }>(`/api/v1/agents/${agent.id}`, {
        method: "POST",
        body: JSON.stringify({ as: "human", action: "whisper", text: clean }),
      })
      setText("")
      if (result.interrupted) toast.message(`${agent.name} 先停下手上的事来回你，回完会接着做`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "没送到")
    } finally {
      setSending(false)
    }
  }

  return (
    <Dialog open={agent !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>单独和 {agent?.name} 说</DialogTitle>
          <DialogDescription>
            这里的话不进群聊，它的回答也只在这里。它正在忙时会先停下来回你，回完接着做原来的事；不着急就在群里 @
            它，排在它手上的事后面。
          </DialogDescription>
        </DialogHeader>
        <div ref={list} className="-mx-1 min-h-32 flex-1 space-y-3 overflow-y-auto px-1 py-1">
          {runs.length === 0 ? (
            <p className="py-8 text-center text-xs text-muted-foreground">还没单独说过话</p>
          ) : null}
          {runs.map((run) => (
            <div key={run.id} className="space-y-1.5">
              <p className="ml-auto w-fit max-w-[85%] rounded-2xl rounded-br-md bg-primary px-3 py-1.5 text-sm whitespace-pre-wrap text-primary-foreground">
                {run.ask}
              </p>
              <div className="max-w-[90%]">
                {run.state === "running" ? (
                  <p className="flex items-center gap-1.5 text-xs text-sky-700 dark:text-sky-300">
                    <Loader2 className="size-3 animate-spin" />
                    {agent?.runId === run.id && agent.doing ? agent.doing : "在想…"}
                  </p>
                ) : run.answer ? (
                  <p className="w-fit rounded-2xl rounded-bl-md bg-muted px-3 py-1.5 text-sm whitespace-pre-wrap">{run.answer}</p>
                ) : (
                  <p className="text-xs text-muted-foreground">{run.steps.at(-1)?.title ?? "没回出东西"}</p>
                )}
                <button
                  type="button"
                  className="mt-0.5 flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
                  onClick={() => onOpenRun(run.id)}
                >
                  <ListTree className="size-3" />
                  查看过程
                </button>
              </div>
            </div>
          ))}
        </div>
        <form
          className="flex items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            void send()
          }}
        >
          <Textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault()
                void send()
              }
            }}
            placeholder={agent?.runId ? "它正在忙，说一句会先打断它…" : "单独对它说…"}
            aria-label={`单独对 ${agent?.name ?? ""} 说`}
            className="max-h-40 min-h-10 flex-1 resize-none text-sm"
            rows={1}
          />
          <Button type="submit" size="icon" disabled={sending || !text.trim()} aria-label="发送">
            {sending ? <Loader2 className="animate-spin" /> : <SendHorizontal />}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  )
}
