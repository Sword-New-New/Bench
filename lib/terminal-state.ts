// Which seats have a live terminal open (lib/terminal.ts), kept apart with no
// imports so the store and the wake queue can ask without a cycle.

type State = { open: Set<string>; closed: Set<(agentId: string) => void> }
const g = globalThis as typeof globalThis & { __benchTermState?: State }

function state(): State {
  return (g.__benchTermState ??= { open: new Set(), closed: new Set() })
}

export function terminalOpen(agentId: string) {
  return state().open.has(agentId)
}

export function markTerminal(agentId: string, open: boolean) {
  if (open) state().open.add(agentId)
  else {
    state().open.delete(agentId)
    for (const listener of state().closed) listener(agentId)
  }
}

// The wake queue picks up what waited while the terminal was open.
export function onTerminalClosed(listener: (agentId: string) => void) {
  state().closed.add(listener)
}
