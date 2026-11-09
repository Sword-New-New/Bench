#!/usr/bin/env node
// Claude Code's PostToolUse hook in a woken turn (scripts/claude-code.sh):
// after each tool call, ask the room whether anyone called this seat since the
// turn started, and if so put those messages into the turn's context, the way
// Claude Code's own queue does when you type while it works. Silent and quick
// when there is nothing, or when the room can't be reached.

const key = process.env.BENCH_RUN_KEY
const room = (process.env.BENCH_URL || "http://127.0.0.1:4399").replace(/\/$/, "")

process.stdin.resume()
process.stdin.on("data", () => {})

async function main() {
  if (!key) return
  const res = await fetch(`${room}/api/v1/queue`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key }),
    signal: AbortSignal.timeout(3000),
  })
  if (!res.ok) return
  const data = await res.json()
  if (!data.text) return
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: data.text } }),
  )
}

main()
  .catch(() => {})
  .finally(() => process.exit(0))
