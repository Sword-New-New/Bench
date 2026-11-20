#!/usr/bin/env node
// In-process verification for wakes that go quiet (t_16ecccd4, lib/events.ts repliedAt, lib/summon.ts launch):
//   1) Antigravity said its last reply (no tool call after it) and then neither printed "result" nor
//      exited: after BENCH_REPLIED_END_MS the room takes the reply as the answer and ends the process;
//   2) a wake whose last output was a tool call that never came back is NOT ended; the seat shows
//      「已经 N 分钟没动静」 (BENCH_SILENT_NOTE_MS), and it clears when output comes again.
// Isolated temp directories and fake client scripts only (never touches live data or real clients).

import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

const stamp = Date.now().toString(36)
const root = mkdtempSync(path.join(os.tmpdir(), `bench-agy-end-${stamp}-`))
const workDir = path.join(root, "work")
const dataDir = path.join(workDir, "data")
const stateDir = path.join(root, "state")
mkdirSync(dataDir, { recursive: true })
mkdirSync(stateDir, { recursive: true })

const line = (o) => JSON.stringify(JSON.stringify(o))
const reply = (i, state, delta) => ({ event: "step_update", step_update: { step_index: i, step_type: "agent_response", state, text_delta: delta } })
const tool = (i, state) => ({ event: "step_update", step_update: { step_index: i, step_type: "tool", state, tool_info: { name: "run_command", parameters: { CommandLine: "sleep 999" } } } })
// Said its answer, then stays up and silent (no "result").
const hangScript = path.join(root, "agy-hang.mjs")
writeFileSync(
  hangScript,
  [
    `console.log(${line(reply(0, "ACTIVE", "看完了，"))})`,
    `console.log(${line(reply(0, "DONE", "两处都改好了。"))})`,
    `setInterval(() => {}, 1000)`,
  ].join("\n"),
  "utf8",
)
// A tool call that never comes back; after a while one more line.
const toolScript = path.join(root, "agy-tool.mjs")
writeFileSync(
  toolScript,
  [
    `console.log(${line(reply(0, "DONE", "先跑一下测试。"))})`,
    `console.log(${line(tool(1, "ACTIVE"))})`,
    `setTimeout(() => console.log(${line(tool(1, "DONE"))}), 4000)`,
    `setInterval(() => {}, 1000)`,
  ].join("\n"),
  "utf8",
)
writeFileSync(
  path.join(workDir, "agents.json"),
  JSON.stringify(
    {
      agents: [
        { name: "mock_agy_hang", command: `node '${hangScript}' {uuid} {text}`, reply: "stdout" },
        { name: "mock_agy_tool", command: `node '${toolScript}' {uuid} {text}`, reply: "stdout" },
      ],
    },
    null,
    2,
  ),
  "utf8",
)

const repoRootUrl = pathToFileURL(process.cwd() + "/").href
const aliasHref = pathToFileURL(path.join(process.cwd(), "scripts/ts-alias.mjs")).href
const phase = path.join(root, "phase.mjs")
writeFileSync(
  phase,
  `
import assert from "node:assert/strict"
import { register } from "node:module"
register(${JSON.stringify(aliasHref)}, import.meta.url)
const root = ${JSON.stringify(repoRootUrl)}
const store = await import(new URL("lib/store.ts", root).href)
const summon = await import(new URL("lib/summon.ts", root).href)
const runs = await import(new URL("lib/runs.ts", root).href)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(what, fn, ms) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const got = fn()
    if (got) return got
    await sleep(50)
  }
  throw new Error("等不到：" + what)
}
summon.ensureSummon()
const p = store.createProject({ as: "human", name: "安静的一轮房" }).project
const seatOf = (id) => store.inProject(p.id, () => store.snapshot().agents.find((a) => a.id === id))

// 1) Said its answer and hung: ended, the answer posted.
const hang = store.inProject(p.id, () => store.join({ name: "说完不走", model: "mock", role: "开发", agentName: "mock_agy_hang", uuid: "u_hang" }))
const m1 = store.inProject(p.id, () => store.say({ as: "human", text: "@说完不走 改两处" }).message)
const started = Date.now()
await until("说完的一轮被收掉", () => seatOf(hang.agent.id)?.runId === undefined && Date.now() - started > 300, 15_000)
const took = Date.now() - started
assert.ok(took >= 1200, "要等够一段安静时间再收，实际 " + took + "ms")
const posted = store.inProject(p.id, () => store.snapshot().messages.find((m) => m.authorId === hang.agent.id))
assert.ok(posted?.text?.includes("两处都改好了"), "说完的话要照常贴回房间：" + JSON.stringify(posted?.text))
const call = store.inProject(p.id, () => store.snapshot().messages.find((m) => m.id === m1.id)?.calls?.find((c) => c.id === hang.agent.id))
assert.equal(call?.state, "answered", "这一轮应算答了")

// 2) A tool call that never came back: not ended, only shown.
const busy = store.inProject(p.id, () => store.join({ name: "工具没回来", model: "mock", role: "开发", agentName: "mock_agy_tool", uuid: "u_tool" }))
store.inProject(p.id, () => store.say({ as: "human", text: "@工具没回来 跑测试" }))
const shown = await until("席位上写没动静", () => (/没动静/.test(seatOf(busy.agent.id)?.doing ?? "") ? seatOf(busy.agent.id) : null), 8000)
assert.ok(shown.runId, "工具没回来的一轮不能被房间收掉")
const runId = shown.runId
await sleep(1500)
assert.equal(seatOf(busy.agent.id)?.runId, runId, "等过了答完收尾的时间，还在跑工具的一轮也不能收")
await until("又有动静后不再写没动静", () => runs.getRun(runId)?.steps?.some((s) => s.id === "silent" && s.state === "done"), 8000)
store.inSeat(busy.agent.id, () => summon.stopAgent(busy.agent.id))
process.exit(0)
`,
  "utf8",
)

try {
  execFileSync(process.execPath, ["--no-warnings", phase], {
    cwd: workDir,
    env: { ...process.env, BENCH_DATA_DIR: dataDir, XDG_STATE_HOME: stateDir, BENCH_REPLIED_END_MS: "1500", BENCH_SILENT_NOTE_MS: "1000" },
    stdio: "inherit",
  })
} finally {
  rmSync(root, { recursive: true, force: true })
}
console.log("agy end ok")
