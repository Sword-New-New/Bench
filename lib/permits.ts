import { randomBytes } from "node:crypto"

import { activeRun } from "@/lib/runs"
import type { PermitRequest } from "@/lib/types"

// Permission prompts of woken Claude Code turns, answered on the page.
// `claude -p --permission-prompt-tool mcp__bench__bench_permit` hands every
// prompt to the bridge, which asks here and blocks until the user decides. A
// seat can also ask for full permission for the rest of its wake
// (bench_elevate), or the user can grant or take it back while it runs.
// In memory only: a prompt outlives neither its wake nor the server.

export type Decision = { allow: boolean; full?: boolean; note?: string }

type Pending = PermitRequest & { project: string; settle: (decision: Decision) => void }

type Permits = {
  pending: Map<string, Pending>
  // Seat id → the wake the grant is for; it lapses when that wake ends.
  grants: Map<string, string>
}

const store = globalThis as typeof globalThis & { __benchPermits?: Permits }

function permits() {
  return (store.__benchPermits ??= { pending: new Map(), grants: new Map() })
}

// The wake a grant is tied to; a seat outside a wake (its own window) has none.
function wakeOf(agentId: string) {
  return activeRun(agentId)?.id ?? "seat"
}

export function hasFull(agentId: string) {
  return permits().grants.get(agentId) === wakeOf(agentId)
}

export function setFull(agentId: string, on: boolean) {
  if (on) permits().grants.set(agentId, wakeOf(agentId))
  else permits().grants.delete(agentId)
  // Granting full settles what that seat is waiting on.
  if (on) for (const item of permits().pending.values()) if (item.agentId === agentId) settle(item.id, { allow: true })
}

export function permitsFor(project: string): PermitRequest[] {
  return [...permits().pending.values()]
    .filter((item) => item.project === project)
    .map(({ id, agentId, agentName, runId, kind, tool, input, reason, at }) => ({
      id,
      agentId,
      agentName,
      runId,
      kind,
      tool,
      input,
      reason,
      at,
    }))
}

// What the tool would do, in one readable piece: the command, the file, or the input.
export function describe(tool: string, input: unknown) {
  const record = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {}
  const pick = (key: string) => (typeof record[key] === "string" ? (record[key] as string) : undefined)
  const text =
    pick("command") ?? pick("file_path") ?? pick("notebook_path") ?? pick("url") ?? pick("pattern") ?? JSON.stringify(input ?? {}, null, 1)
  return text.length > 800 ? `${text.slice(0, 800)}…` : text
}

function settle(id: string, decision: Decision) {
  const item = permits().pending.get(id)
  if (!item) return null
  permits().pending.delete(id)
  item.settle(decision)
  return item
}

export function decide(id: string, decision: Decision) {
  const item = permits().pending.get(id)
  if (!item) return null
  // Allowing a request for full permission grants it, whichever button said so.
  if (decision.allow && (decision.full || item.kind === "full")) setFull(item.agentId, true)
  return settle(id, decision) ?? item
}

// Ask the user, and wait for the answer, the time limit, or the caller leaving.
export function ask(
  input: Omit<PermitRequest, "id" | "at" | "runId"> & { project: string },
  { timeoutMs, signal, changed }: { timeoutMs: number; signal?: AbortSignal; changed: () => void },
) {
  if (input.kind === "tool" && hasFull(input.agentId)) return Promise.resolve<Decision>({ allow: true, full: true })
  return new Promise<Decision>((resolve) => {
    const id = `p_${randomBytes(4).toString("hex")}`
    const finish = (decision: Decision) => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
      resolve(decision)
      changed()
    }
    const timer = setTimeout(
      () => settle(id, { allow: false, note: `jinbao ${Math.round(timeoutMs / 60_000)} 分钟内没有回应` }),
      timeoutMs,
    )
    const onAbort = () => settle(id, { allow: false, note: "已取消" })
    signal?.addEventListener("abort", onAbort)
    permits().pending.set(id, { ...input, id, at: Date.now(), runId: activeRun(input.agentId)?.id, settle: finish })
    changed()
  })
}
