import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"
import { randomBytes } from "node:crypto"

import type { Run, RunStep } from "@/lib/types"

// What each wake did on the way to its answer: the tool calls, their results
// and the text in between. The chat only ever shows the answer; this is what
// the 「过程」 panel reads. Kept in memory, saved to data/runs.json when a run
// ends, and only the most recent runs are kept.

const MAX_RUNS = 80
const MAX_STEPS = 300
const MAX_FIELD = 4000

type RunsGlobal = typeof globalThis & { __benchRuns?: Run[] }

function file() {
  return path.join(process.cwd(), "data", "runs.json")
}

function runs(): Run[] {
  const store = globalThis as RunsGlobal
  if (!store.__benchRuns) {
    try {
      const parsed = JSON.parse(readFileSync(file(), "utf8")) as { runs?: Run[] }
      // A run that was going when the room stopped will never finish.
      store.__benchRuns = (parsed.runs ?? []).map((run) =>
        run.state === "running" ? { ...run, state: "failed", endedAt: run.endedAt ?? run.startedAt } : run,
      )
    } catch {
      store.__benchRuns = []
    }
  }
  return store.__benchRuns
}

function save() {
  try {
    mkdirSync(path.dirname(file()), { recursive: true })
    const tmp = `${file()}.tmp`
    writeFileSync(tmp, JSON.stringify({ runs: runs() }))
    renameSync(tmp, file())
  } catch (error) {
    console.error(error)
  }
}

function clip(text: string | undefined) {
  if (!text) return undefined
  return text.length > MAX_FIELD ? `${text.slice(0, MAX_FIELD)}…（还有 ${text.length - MAX_FIELD} 字）` : text
}

export function startRun(agentId: string, agentName: string, purpose: Run["purpose"]) {
  const run: Run = {
    id: `r_${randomBytes(4).toString("hex")}`,
    agentId,
    agentName,
    purpose,
    state: "running",
    startedAt: Date.now(),
    steps: [],
  }
  const list = runs()
  list.push(run)
  if (list.length > MAX_RUNS) list.splice(0, list.length - MAX_RUNS)
  return run
}

// Adds a step, or updates the one with the same id (a tool call that has
// now finished). Empty fields in the update leave the old ones alone.
export function putStep(run: Run, step: RunStep) {
  const clean = { ...step, input: clip(step.input), output: clip(step.output) }
  const index = run.steps.findIndex((item) => item.id === step.id)
  if (index < 0) {
    if (run.steps.length < MAX_STEPS) run.steps.push({ ...clean, title: clean.title || "工具" })
    return
  }
  const old = run.steps[index]
  run.steps[index] = {
    ...old,
    state: clean.state,
    title: clean.title || old.title,
    input: clean.input ?? old.input,
    output: clean.output ?? old.output,
  }
}

export function endRun(run: Run, state: "done" | "failed", note?: string) {
  run.state = state
  run.endedAt = Date.now()
  // Anything still marked running never got its result.
  for (const step of run.steps) if (step.state === "running") step.state = state
  if (note) putStep(run, { id: "end", at: Date.now(), kind: "note", title: note, state })
  save()
}

export function linkMessage(run: Run, messageId: string) {
  run.messageId = messageId
}

export function getRun(id: string) {
  return runs().find((run) => run.id === id) ?? null
}

// The run a seat is in the middle of, if any.
export function activeRun(agentId: string) {
  return runs().findLast((run) => run.agentId === agentId && run.state === "running") ?? null
}
