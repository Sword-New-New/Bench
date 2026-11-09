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
      // A run that was going when the room stopped will never finish: it is
      // marked cut off, and the room lists it so the user can wake it again.
      store.__benchRuns = (parsed.runs ?? []).map((run) => {
        if (run.state !== "running") return run
        const at = Date.now()
        const steps = run.steps.map((step) => (step.state === "running" ? { ...step, state: "failed" as const } : step))
        steps.push({ id: "end", at, kind: "note", title: "服务器重启，这次唤起被打断了", state: "failed" })
        return { ...run, state: "failed" as const, endedAt: at, interrupted: true, steps }
      })
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

const MAX_BODY = 12_000

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
  const list = runs()
  list.push(run)
  if (list.length > MAX_RUNS) list.splice(0, list.length - MAX_RUNS)
  save()
  return run
}

// Cut off by a restart and not yet told to the room; told once.
export function takeUnannounced() {
  const list = runs().filter((run) => run.interrupted && !run.announced)
  if (list.length === 0) return list
  for (const run of list) run.announced = true
  save()
  return list
}

export function markResumed(run: Run) {
  run.resumedAt = Date.now()
  save()
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

export function listRuns(agentId: string, purpose: Run["purpose"]) {
  return runs().filter((run) => run.agentId === agentId && run.purpose === purpose)
}
