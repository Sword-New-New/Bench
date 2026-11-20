#!/usr/bin/env node
// In-process + restart verification that a usage limit is resumed once per seat (t_16ecccd4,
// lib/summon.ts armResume / fireResume / takeBack / limitChoice):
//   1) a seat cut off on two wakes before the reset gets one timer: at the reset it is woken once,
//      with both, and the chat gets one line「X 的额度恢复了，已经接着做」;
//   2) the timers come back after a restart (phase 2 is a new process) and still wake once;
//   3) a check cut off by the limit can't be scheduled or retried (its checker is replaced instead).
// Isolated temp directories and fake client scripts only (never touches live data or real clients).

import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

const stamp = Date.now().toString(36)
const root = mkdtempSync(path.join(os.tmpdir(), `bench-limit-resume-${stamp}-`))
const workDir = path.join(root, "work")
const dataDir = path.join(workDir, "data")
const stateDir = path.join(root, "state")
mkdirSync(dataDir, { recursive: true })
mkdirSync(stateDir, { recursive: true })

const wakeLog = path.join(root, "wakes.jsonl")
const backFlag = path.join(root, "back")
// The reset: this very minute, on the local clock, so the timer is due within a minute.
const limitScript = path.join(root, "limit.mjs")
writeFileSync(
  limitScript,
  [
    `import { appendFileSync, existsSync } from "node:fs"`,
    `appendFileSync(${JSON.stringify(wakeLog)}, JSON.stringify({ prompt: process.argv[3] || "" }) + "\\n", "utf8")`,
    `if (existsSync(${JSON.stringify(backFlag)})) { console.log("【本轮结束】接着做完了"); process.exit(0) }`,
    `const now = new Date(); const h = now.getHours() % 12 || 12; const m = String(now.getMinutes()).padStart(2, "0")`,
    `console.log("You've hit your session limit · resets " + h + ":" + m + (now.getHours() < 12 ? "am" : "pm"))`,
    `process.exit(1)`,
  ].join("\n"),
  "utf8",
)
const checkLimitScript = path.join(root, "check-limit.mjs")
writeFileSync(checkLimitScript, `console.log("You've hit your session limit · resets 3pm"); process.exit(1)\n`, "utf8")
const okScript = path.join(root, "ok.mjs")
writeFileSync(okScript, `console.log("【本轮结束】好")\n`, "utf8")
writeFileSync(
  path.join(workDir, "agents.json"),
  JSON.stringify(
    {
      agents: [
        { name: "mock_lim", command: `node '${limitScript}' {uuid} {text}`, reply: "stdout" },
        { name: "mock_chk_lim", command: `node '${checkLimitScript}' {uuid} {text}`, reply: "stdout" },
        { name: "mock_ok", command: `node '${okScript}' {uuid} {text}`, reply: "stdout" },
      ],
    },
    null,
    2,
  ),
  "utf8",
)

const repoRootUrl = pathToFileURL(process.cwd() + "/").href
const aliasHref = pathToFileURL(path.join(process.cwd(), "scripts/ts-alias.mjs")).href
const head = `
import assert from "node:assert/strict"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { register } from "node:module"
register(${JSON.stringify(aliasHref)}, import.meta.url)
const root = ${JSON.stringify(repoRootUrl)}
const store = await import(new URL("lib/store.ts", root).href)
const summon = await import(new URL("lib/summon.ts", root).href)
const runs = await import(new URL("lib/runs.ts", root).href)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const wakes = () => (existsSync(${JSON.stringify(wakeLog)}) ? readFileSync(${JSON.stringify(wakeLog)}, "utf8").trim().split("\\n").filter(Boolean).map((l) => JSON.parse(l).prompt) : [])
async function until(what, fn, ms) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const got = fn()
    if (got) return got
    await sleep(100)
  }
  throw new Error("等不到：" + what)
}
summon.ensureSummon()
`

const phase1 = path.join(root, "phase1.mjs")
writeFileSync(
  phase1,
  `${head}
const project = store.createProject({ as: "human", name: "撞额度房" }).project
const seat = store.inProject(project.id, () => store.join({ name: "额度员", model: "mock", role: "开发", agentName: "mock_lim", uuid: "u_lim" }))
store.inProject(project.id, () => store.say({ as: "human", text: "@额度员 先做第一件：整理目录" }))
await until("第一轮撞额度", () => runs.pendingResumes().filter((r) => r.agentId === seat.agent.id).length >= 1, 15_000)
store.inProject(project.id, () => store.say({ as: "human", text: "@额度员 再做第二件：补说明" }))
const due = await until("两轮都撞额度并定了时", () => {
  const list = runs.pendingResumes().filter((r) => r.agentId === seat.agent.id)
  return list.length >= 2 ? list : null
}, 15_000)
assert.equal(new Set(due.map((r) => r.limited.resumeAt)).size, 1, "同一个席位同一次重置，恢复时间应相同")
assert.ok(due[0].limited.resumeAt - Date.now() < 90_000, "测试假定恢复时间在一分半之内")

// A check cut off by the limit: no timer, no retry; its checker is replaced instead.
const p2 = store.createProject({ as: "human", name: "检查撞额度房" }).project
const owner = store.inProject(p2.id, () => store.join({ name: "负责人", model: "mock", role: "开发", agentName: "mock_ok", uuid: "u_owner" }))
const checker = store.inProject(p2.id, () => store.join({ name: "检查员", model: "mock", role: "检查", agentName: "mock_chk_lim", uuid: "u_chk" }))
store.inProject(p2.id, () => store.setChecker(checker.agent.id, true))
const taskId = store.inProject(p2.id, () => {
  const as = { agentId: owner.agent.id, token: owner.token }
  const task = store.createTask({ ...as, title: "要查的一件", owner: owner.agent.name, steps: ["做完", "请用户验收"] }).task
  store.actOnTask({ ...as, taskId: task.id, action: "step", step: 1, state: "done", note: "完" })
  store.actOnTask({ ...as, taskId: task.id, action: "review", note: "打开页面就能看到" })
  return task.id
})
const card = await until("检查撞额度出卡", () => store.inProject(p2.id, () => store.snapshot().messages.find((m) => m.limited?.agentId === checker.agent.id)), 15_000)
assert.notEqual(card.limited.state, "scheduled", "检查撞额度不该自动定时")
assert.throws(() => summon.limitChoice(card.limited.runId, "schedule"), /检查/, "检查撞额度的卡不能定时")
assert.throws(() => summon.limitChoice(card.limited.runId, "now"), /检查/, "检查撞额度的卡也不能现在重试")
assert.ok(!runs.pendingResumes().some((r) => r.agentId === checker.agent.id), "检查不该留下定时")
void taskId
writeFileSync(${JSON.stringify(path.join(root, "p1.json"))}, JSON.stringify({ project: project.id, seat: seat.agent.id, at: due[0].limited.resumeAt, before: wakes().length }))
process.exit(0)
`,
  "utf8",
)

const phase2 = path.join(root, "phase2.mjs")
writeFileSync(
  phase2,
  `${head}
const p1 = JSON.parse(readFileSync(${JSON.stringify(path.join(root, "p1.json"))}, "utf8"))
writeFileSync(${JSON.stringify(backFlag)}, "1")
const lines = () => store.inProject(p1.project, () => store.snapshot().messages.filter((m) => m.kind === "system" && /额度恢复了/.test(m.text)))
await until("到点叫醒", () => lines().length > 0, Math.max(0, p1.at - Date.now()) + 30_000)
await until("叫醒的这一轮跑完", () => !store.inProject(p1.project, () => store.snapshot().agents.find((a) => a.id === p1.seat)?.runId) && wakes().length > p1.before, 15_000)
await sleep(3000)
const said = lines()
assert.equal(said.length, 1, "对话里只该有一行，实际：" + said.map((m) => m.text).join(" | "))
assert.equal(said[0].text, "额度员 的额度恢复了，已经接着做")
const after = wakes().slice(p1.before)
assert.equal(after.length, 1, "两轮被拦下的活应一次叫醒带上，实际叫了 " + after.length + " 次")
assert.ok(after[0].includes("整理目录") && after[0].includes("补说明"), "这一次要把两轮的活都带上")
assert.ok(!runs.pendingResumes().some((r) => r.agentId === p1.seat), "叫过以后不该还留着定时")
assert.ok(!store.inProject(p1.project, () => store.snapshot().messages.some((m) => /没成功|没接上/.test(m.text))), "不该出叫醒没成功的行")
process.exit(0)
`,
  "utf8",
)

try {
  const env = { ...process.env, BENCH_DATA_DIR: dataDir, XDG_STATE_HOME: stateDir }
  execFileSync(process.execPath, ["--no-warnings", phase1], { cwd: workDir, env, stdio: "inherit" })
  execFileSync(process.execPath, ["--no-warnings", phase2], { cwd: workDir, env, stdio: "inherit" })
} finally {
  rmSync(root, { recursive: true, force: true })
}
console.log("limit resume ok")
