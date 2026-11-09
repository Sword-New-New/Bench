"use client"

import { useEffect, useRef, useState } from "react"
import { Check, ChevronRight, Loader2, MessageSquareText, StickyNote, Wrench, X } from "lucide-react"

import { api } from "@/components/room/api"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import type { Run, RunStep } from "@/lib/types"

const POLL_MS = 1000

function seconds(from: number, to: number) {
  const s = Math.max(0, Math.round((to - from) / 1000))
  return s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${s % 60} 秒`
}

// What a wake did on the way to its answer, step by step. While the run is
// still going it refreshes every second and follows the newest step.
export function RunPanel({ runId, onClose }: { runId: string | null; onClose: () => void }) {
  const [run, setRun] = useState<Run | null>(null)
  const [error, setError] = useState("")
  const [now, setNow] = useState(0)
  const list = useRef<HTMLDivElement>(null)
  const follow = useRef(true)

  const [shownId, setShownId] = useState(runId)
  if (runId !== shownId) {
    setShownId(runId)
    setRun(null)
    setError("")
  }

  useEffect(() => {
    if (!runId) return
    follow.current = true
    let stop = false
    let timer = 0
    const load = async () => {
      try {
        const data = await api<{ run: Run }>(`/api/v1/runs/${runId}`)
        if (stop) return
        setRun(data.run)
        setNow(Date.now())
        if (data.run.state === "running") timer = window.setTimeout(load, POLL_MS)
      } catch (err) {
        if (!stop) setError(err instanceof Error ? err.message : "没读到这次的过程")
      }
    }
    void load()
    return () => {
      stop = true
      window.clearTimeout(timer)
    }
  }, [runId])

  // Stay on the newest step unless you scrolled up to read.
  useEffect(() => {
    const node = list.current
    if (node && follow.current) node.scrollTop = node.scrollHeight
  }, [run])

  const state = run?.state
  const took = run ? seconds(run.startedAt, run.endedAt ?? now) : ""
  const tools = run?.steps.filter((step) => step.kind === "tool").length ?? 0

  return (
    <Dialog open={runId !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {run ? `${run.agentName} 的过程` : "过程"}
            {state === "running" ? <Loader2 className="size-4 animate-spin text-muted-foreground" /> : null}
          </DialogTitle>
          <DialogDescription>
            {run
              ? `${run.purpose === "summary" ? "写房间摘要" : run.purpose === "private" ? "单独说" : "回复点名"} · ${
                  state === "running" ? "进行中" : state === "done" ? "完成" : "没成功"
                } · ${took} · ${tools} 次工具调用`
              : error || "正在读取…"}
          </DialogDescription>
        </DialogHeader>
        <div
          ref={list}
          className="-mx-1 min-h-24 flex-1 space-y-1 overflow-y-auto px-1"
          onScroll={(event) => {
            const node = event.currentTarget
            follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 40
          }}
        >
          {run?.steps.map((step) => <StepRow key={step.id} step={step} start={run.startedAt} />)}
          {run && run.steps.length === 0 ? (
            <p className="py-6 text-center text-xs text-muted-foreground">
              {state === "running" ? "还没有动静…" : "这次没有记下步骤（这家客户端只给最终回答）"}
            </p>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function StepIcon({ step }: { step: RunStep }) {
  if (step.state === "running") return <Loader2 className="size-3.5 animate-spin text-sky-600 dark:text-sky-400" />
  if (step.state === "failed") return <X className="size-3.5 text-amber-600 dark:text-amber-400" />
  if (step.kind === "text") return <MessageSquareText className="size-3.5 text-muted-foreground" />
  if (step.kind === "note") return <StickyNote className="size-3.5 text-muted-foreground" />
  return step.output !== undefined ? (
    <Check className="size-3.5 text-emerald-600 dark:text-emerald-400" />
  ) : (
    <Wrench className="size-3.5 text-muted-foreground" />
  )
}

export function StepRow({ step, start }: { step: RunStep; start: number }) {
  const [open, setOpen] = useState(false)
  // A title cut off by the panel's width opens too, even with nothing more
  // behind it: something it said, short enough to be its own full text.
  const titleRef = useRef<HTMLSpanElement>(null)
  const [clipped, setClipped] = useState(false)
  useEffect(() => {
    const node = titleRef.current
    if (!node) return
    const measure = () => {
      if (!node.classList.contains("truncate")) return
      setClipped(node.scrollWidth > node.clientWidth + 1)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [step.title])
  const more = Boolean(step.input || (step.output && step.output !== step.title) || clipped)
  return (
    <div className="rounded-lg border border-transparent hover:border-border">
      <button
        type="button"
        className="flex w-full items-start gap-2 px-2 py-1.5 text-left text-xs disabled:cursor-default"
        disabled={!more}
        aria-expanded={more ? open : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="pt-0.5">
          <StepIcon step={step} />
        </span>
        <span
          ref={titleRef}
          className={`min-w-0 flex-1 ${step.kind === "text" ? "text-muted-foreground" : "font-medium"} ${open ? "break-all whitespace-pre-wrap" : "truncate"}`}
        >
          {step.title}
        </span>
        <span className="shrink-0 tabular-nums text-[10px] text-muted-foreground">+{seconds(start, step.at)}</span>
        {more ? (
          <ChevronRight className={`size-3.5 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`} />
        ) : (
          <span className="size-3.5 shrink-0" />
        )}
      </button>
      {open ? (
        <div className="space-y-1.5 px-2 pb-2 pl-7">
          {step.input ? <Block label="参数" text={step.input} /> : null}
          {step.output && step.output !== step.title ? (
            <Block label={step.kind === "text" ? "全文" : "结果"} text={step.output} main prose={step.kind === "text"} />
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

// The call's arguments are small print; what came back is what you read, so
// it is set larger (and in the body font when it is something it said).
function Block({ label, text, main, prose }: { label: string; text: string; main?: boolean; prose?: boolean }) {
  const size = main ? "max-h-80 text-[13px] leading-5" : "max-h-40 text-[11px] leading-4 text-muted-foreground"
  return (
    <div>
      <p className="mb-0.5 text-[10px] text-muted-foreground">{label}</p>
      <pre
        className={`overflow-auto rounded-md bg-muted/60 px-2 py-1.5 break-all whitespace-pre-wrap ${size} ${prose ? "font-sans" : "font-mono"}`}
      >
        {text}
      </pre>
    </div>
  )
}
