#!/usr/bin/env node
// When the room's stream parser (lib/events.ts) decides a turn is over.
// node scripts/test-events.mjs [captured.jsonl …]
import { register } from "node:module"
register("./ts-alias.mjs", import.meta.url)
import { readFileSync } from "node:fs"

const { createParser } = await import("../lib/events.ts")

let failed = 0
function check(ok, what) {
  console.log(`${ok ? "ok " : "FAIL"} ${what}`)
  if (!ok) failed++
}

// Feeds lines; returns the 1-based line the turn ended on (0: never) and the answer.
function run(lines) {
  const parser = createParser()
  let endedAt = 0
  lines.forEach((line, i) => {
    const was = parser.ended()
    parser.feed(typeof line === "string" ? line : JSON.stringify(line))
    if (!was && parser.ended() && !endedAt) endedAt = i + 1
  })
  return { endedAt, answer: parser.answer() }
}

const session = "00000000-0000-4000-8000-000000000000"
function result(turns, text) {
  return { type: "result", subtype: "success", is_error: false, num_turns: turns, result: text, session_id: session }
}
function say(text) {
  return { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: text }] }, session_id: session }
}

// Claude Code resumed after a turn that left background tasks: the "stopped"
// notice is replayed first and closed with an empty result (num_turns 0), and
// only then comes the message's own turn (recorded 2026-11-16, claude -p 2.1.325).
{
  const { endedAt, answer } = run([
    { type: "system", subtype: "task_notification", session_id: session },
    { type: "system", subtype: "init", session_id: session },
    result(0, ""),
    { type: "system", subtype: "init", session_id: session },
    say("hello"),
    result(1, "hello"),
  ])
  check(endedAt === 6, `残留通知的空 result 不算答完，真正的 result 才算（停在第 ${endedAt} 行）`)
  check(answer === "hello", `答案是这一轮说的话（${JSON.stringify(answer)}）`)
}

// An ordinary turn ends on its result.
{
  const { endedAt, answer } = run([{ type: "system", subtype: "init", session_id: session }, say("hi"), result(1, "hi")])
  check(endedAt === 3 && answer === "hi", "普通一轮照常在 result 处结束")
}

// A real turn that said nothing still ends (num_turns ≥ 1).
check(run([result(1, "")]).endedAt === 1, "说了 0 个字但跑过一轮的 result 仍算结束")

// num_turns 0 that carries an answer (not seen; kept as an end to be safe).
check(run([result(0, "done")]).endedAt === 1, "num_turns 0 但带了答案的 result 仍算结束")

// Other clients' ends are untouched.
check(run([{ type: "turn.completed" }]).endedAt === 1, "Codex 的 turn.completed 照常结束")
check(run([{ event: "result", result: { response: "x" } }]).endedAt === 1, "Antigravity 的 result 照常结束")

// Captured streams given on the command line: print where each ended.
for (const file of process.argv.slice(2)) {
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean)
  const { endedAt, answer } = run(lines)
  console.log(`${file}: ${lines.length} 行，停在第 ${endedAt} 行，答案 ${JSON.stringify(answer.slice(0, 60))}`)
}

if (failed) {
  console.log(`events: ${failed} failed`)
  process.exit(1)
}
console.log("events ok")
