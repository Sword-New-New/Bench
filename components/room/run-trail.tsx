"use client"

import { useEffect, useState } from "react"
import { Loader2 } from "lucide-react"

import { api } from "@/components/room/api"
import { StepRow } from "@/components/room/run-panel"
import type { Run } from "@/lib/types"

const POLL_MS = 1500

// Runs that have ended don't change, so each is fetched once per page.
const finished = new Map<string, Run | null>()

function useRun(runId: string) {
  const [run, setRun] = useState<Run | null | undefined>(() => finished.get(runId))
  useEffect(() => {
    if (finished.has(runId)) return
    let stop = false
    let timer = 0
    const load = async () => {
      try {
        const data = await api<{ run: Run }>(`/api/v1/runs/${runId}`)
        if (stop) return
        setRun(data.run)
        if (data.run.state === "running") timer = window.setTimeout(load, POLL_MS)
        else finished.set(runId, data.run)
      } catch {
        // The log keeps only recent runs; an older one is simply gone.
        finished.set(runId, null)
        if (!stop) setRun(null)
      }
    }
    void load()
    return () => {
      stop = true
      window.clearTimeout(timer)
    }
  }, [runId])
  return run
}

function took(run: Run) {
  const s = Math.max(0, Math.round(((run.endedAt ?? Date.now()) - run.startedAt) / 1000))
  return s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${s % 60} 秒`
}

// 「详细」 view: the steps of one wake, shown in the thread above the reply it
// led to (or on their own while it is still going). Only this page shows it;
// it is not a room message, so no agent ever reads it.
export function RunTrail({ runId, answer }: { runId: string; answer?: string }) {
  const run = useRun(runId)
  if (!run) return null
  // What it said last is the reply itself; don't show it twice.
  const steps = run.steps.filter((step) => !(answer && step.kind === "text" && step.output && answer.includes(step.output)))
  const tools = run.steps.filter((step) => step.kind === "tool").length
  return (
    <div className="mb-1.5 rounded-xl border border-dashed bg-background/40 px-1 py-1">
      <p className="flex items-center gap-1.5 px-2 pt-0.5 pb-1 text-[11px] text-muted-foreground">
        {run.state === "running" ? <Loader2 className="size-3 animate-spin" /> : null}
        过程 · {tools} 次工具调用 · {took(run)}
        <span className="ml-auto">只有你看得到</span>
      </p>
      {steps.length === 0 ? (
        <p className="px-2 pb-1 text-[11px] text-muted-foreground">
          {run.state === "running" ? "还没有动静…" : "这次没有记下步骤"}
        </p>
      ) : (
        steps.map((step) => <StepRow key={step.id} step={step} start={run.startedAt} />)
      )}
    </div>
  )
}
