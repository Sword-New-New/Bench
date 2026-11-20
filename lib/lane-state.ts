// Shared read-only view of wake lanes so `lib/store.ts` can expose queue counts
// and pause state on `PublicAgent` without importing `lib/summon.ts`.

export type LaneSnapshot = {
  paused: boolean
  queuedCount: number
  queuedItems: { id: string; line: string }[]
  // A wake that failed on the network, waiting to be tried again: when, and
  // which try of how many (lib/summon.ts).
  retry?: { at: number; n: number; of: number }
}

type LaneReaderGlobal = typeof globalThis & {
  __benchLaneSnapshot?: (agentId: string) => LaneSnapshot | undefined
  __benchLaneIdle?: (agentId: string) => boolean
  __benchSeatUserStopped?: (agentId: string) => boolean
  __benchSummaryHold?: (projectId: string, base: number) => boolean
}

export function registerLaneReader(fn: (agentId: string) => LaneSnapshot | undefined) {
  ;(globalThis as LaneReaderGlobal).__benchLaneSnapshot = fn
}

export function readLaneSnapshot(agentId: string): LaneSnapshot | undefined {
  return (globalThis as LaneReaderGlobal).__benchLaneSnapshot?.(agentId)
}

export function registerLaneIdle(fn: (agentId: string) => boolean) {
  ;(globalThis as LaneReaderGlobal).__benchLaneIdle = fn
}

export function isLaneIdle(agentId: string): boolean {
  const fn = (globalThis as LaneReaderGlobal).__benchLaneIdle
  return fn ? fn(agentId) : true
}

export function registerSeatUserStopped(fn: (agentId: string) => boolean) {
  ;(globalThis as LaneReaderGlobal).__benchSeatUserStopped = fn
}

export function isSeatStoppedByUser(agentId: string): boolean {
  return (globalThis as LaneReaderGlobal).__benchSeatUserStopped?.(agentId) ?? false
}

// The room is still finding someone to write this project's summary
// (lib/summary-auto.ts), so the page holds the 「找谁写」 card back.
export function registerSummaryHold(fn: (projectId: string, base: number) => boolean) {
  ;(globalThis as LaneReaderGlobal).__benchSummaryHold = fn
}

export function summaryHeldFor(projectId: string, base: number): boolean {
  return (globalThis as LaneReaderGlobal).__benchSummaryHold?.(projectId, base) ?? false
}
