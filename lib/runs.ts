import { randomBytes } from "node:crypto"

import {
  dbGetRun,
  dbLastRunOf,
  dbListRuns,
  dbMarkColdRunningInterrupted,
  dbPendingResumes,
  dbSaveRunMeta,
  dbSaveRunStep,
  dbTakeUnannouncedInterrupted,
} from "@/lib/db"
import type { Run, RunStep } from "@/lib/types"

// What each wake did on the way to its answer: the tool calls, their results
// and the text in between. Live runs stay in memory for zero-cost snapshots,
// while every run and step is persisted incrementally to SQLite (`runs` +
// `run_steps`) with no 80-run eviction cap.

const MAX_STEPS = 300
const MAX_FIELD = 4000
const MAX_BODY = 12_000

type RunsGlobal = typeof globalThis & {
  __benchActiveRuns?: Map<string, Run>
  __benchRunsBooted?: boolean
  // Legacy field from before SQLite migration, inspected if hot-reloading mid-run.
  __benchRuns?: Run[]
}

function liveMap(): Map<string, Run> {
  const g = globalThis as RunsGlobal
  if (!g.__benchActiveRuns) {
    g.__benchActiveRuns = new Map()
    // Preserve any in-flight runs across HMR, otherwise mark cold-disk running rows interrupted.
    const hotRunning = (g.__benchRuns ?? []).filter((r) => r.state === "running")
    if (hotRunning.length > 0) {
      for (const r of hotRunning) g.__benchActiveRuns.set(r.id, r)
    } else if (!g.__benchRunsBooted) {
      dbMarkColdRunningInterrupted()
    }
    g.__benchRunsBooted = true
  }
  return g.__benchActiveRuns
}

function clip(text: string | undefined) {
  if (!text) return undefined
  return text.length > MAX_FIELD ? `${text.slice(0, MAX_FIELD)}…（还有 ${text.length - MAX_FIELD} 字）` : text
}

// Saved as soon as it starts, so a restart mid-run still knows about it.
export function startRun(
  agentId: string,
  agentName: string,
  purpose: Run["purpose"],
  extra: Pick<Run, "project" | "body" | "replyTo" | "ask"> = {},
) {
  const run: Run = {
    id: `r_${randomBytes(4).toString("hex")}`,
    agentId,
    agentName,
    purpose,
    state: "running",
    startedAt: Date.now(),
    ...extra,
    body: extra.body && extra.body.length > MAX_BODY ? extra.body.slice(-MAX_BODY) : extra.body,
    steps: [],
  }
  liveMap().set(run.id, run)
  dbSaveRunMeta(run)
  return run
}

// Cut off by a restart and not yet told to the room; told once.
export function takeUnannounced() {
  liveMap()
  return dbTakeUnannouncedInterrupted()
}

// Runs the user asked to be woken again after a usage limit, not yet done.
export function pendingResumes() {
  liveMap()
  return dbPendingResumes()
}

export function setLimited(run: Run, limited: Run["limited"]) {
  run.limited = limited
  const live = liveMap().get(run.id)
  if (live) live.limited = limited
  dbSaveRunMeta(run)
}

export function markResumed(run: Run) {
  const at = Date.now()
  run.resumedAt = at
  const live = liveMap().get(run.id)
  if (live) live.resumedAt = at
  dbSaveRunMeta(run)
}

// Adds a step, or updates the one with the same id (a tool call that has
// now finished). Empty fields in the update leave the old ones alone.
export function putStep(run: Run, step: RunStep) {
  const clean = { ...step, input: clip(step.input), output: clip(step.output) }
  const index = run.steps.findIndex((item) => item.id === step.id)
  if (index < 0) {
    if (run.steps.length < MAX_STEPS) {
      const added: RunStep = { ...clean, title: clean.title || "工具" }
      const nextIdx = run.steps.length
      run.steps.push(added)
      dbSaveRunStep(run.id, nextIdx, added)
    }
    return
  }
  const old = run.steps[index]
  const updated: RunStep = {
    ...old,
    state: clean.state,
    title: clean.title || old.title,
    input: clean.input ?? old.input,
    output: clean.output ?? old.output,
  }
  run.steps[index] = updated
  dbSaveRunStep(run.id, index, updated)
}

export function endRun(run: Run, state: "done" | "failed", note?: string) {
  run.state = state
  run.endedAt = Date.now()
  // Anything still marked running never got its result.
  for (let i = 0; i < run.steps.length; i++) {
    const step = run.steps[i]
    if (step.state === "running") {
      step.state = state
      dbSaveRunStep(run.id, i, step)
    }
  }
  if (note) putStep(run, { id: "end", at: Date.now(), kind: "note", title: note, state })
  liveMap().delete(run.id)
  dbSaveRunMeta(run)
}

export function linkMessage(run: Run, messageId: string) {
  run.messageId = messageId
  dbSaveRunMeta(run)
}

export function getRun(id: string) {
  return liveMap().get(id) ?? dbGetRun(id)
}

// The run a seat is in the middle of, if any.
export function activeRun(agentId: string) {
  let latest: Run | null = null
  for (const run of liveMap().values()) {
    if (run.agentId === agentId && run.state === "running") latest = run
  }
  return latest
}

// A seat's latest wake of any kind: what the self-check shows (lib/selfcheck.ts).
export function lastRunOf(agentId: string) {
  const active = activeRun(agentId)
  if (active) return active
  return dbLastRunOf(agentId)
}

export function listRuns(agentId: string, purpose: Run["purpose"]) {
  const persisted = dbListRuns(agentId, purpose)
  const seen = new Set(persisted.map((r) => r.id))
  for (const run of liveMap().values()) {
    if (run.agentId === agentId && run.purpose === purpose && !seen.has(run.id)) {
      persisted.push(run)
    }
  }
  return persisted
}
