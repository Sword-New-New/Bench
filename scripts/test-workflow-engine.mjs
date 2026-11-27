// Isolated unit tests for the v2 multi-stage workflow engine (M1):
// fan-in synchronization, human approval gates (reject + approve), single-node
// retry, seat replacement, pause/resume/stop, and zero group-chat pollution.
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { register } from "node:module"
import os from "node:os"
import path from "node:path"

register("./ts-alias.mjs", import.meta.url)
const dir = mkdtempSync(path.join(os.tmpdir(), "bench-wf-engine-"))
process.env.BENCH_DATA_DIR = dir

const { createProject, inProject, join, snapshot } = await import("../lib/store.ts")
const { saveWorkflow } = await import("../lib/workflows.ts")
const {
  approveWorkflowGate,
  listWorkflowRuns,
  pauseWorkflowRun,
  rejectWorkflowGate,
  replaceWorkflowNodeSeat,
  resumeWorkflowRun,
  retryWorkflowNode,
  setWorkflowRunnerForTest,
  startWorkflowRun,
  stopWorkflowRun,
} = await import("../lib/workflow-engine.ts")

// Deterministic manual runner: records queued jobs so tests control exact completion order.
const queued = []
const cancelled = []
setWorkflowRunnerForTest({
  enqueue(job) {
    queued.push(job)
    job.onStart?.(`run_${job.id}`)
  },
  cancel(_pid, _aid, jobId) {
    cancelled.push(jobId)
  },
})

try {
  const created = createProject({ name: "EngineTest", dir })
  const pid = created.project?.id ?? created.id
  inProject(pid, () => {
    join({ name: "Alpha", model: "m1", role: "规划", agentName: "claude", uuid: "s1" })
    join({ name: "Beta", model: "m2", role: "前端", agentName: "codex", uuid: "s2" })
    join({ name: "Gamma", model: "m3", role: "后端", agentName: "codex", uuid: "s3" })
    join({ name: "Delta", model: "m4", role: "汇总", agentName: "dsh", uuid: "s4" })
    join({ name: "Backup", model: "m5", role: "替补", agentName: "antigravity", uuid: "s5" })
  })

  const chatBefore = inProject(pid, () => snapshot().messages.length)

  // Save a 3-stage custom workflow with a human gate after stage 1 and 2 parallel seats in stage 2.
  const wf = saveWorkflow(pid, {
    name: "规划-并行-汇总",
    kind: "custom",
    stages: [
      { title: "方案规划", seats: ["Alpha"], instruction: "只出计划", gate: true },
      { title: "并行开发", seats: ["Beta", "Gamma"], instruction: "并行干活" },
      { title: "最终汇总", seats: ["Delta"], instruction: "汇总收尾" },
    ],
  })
  assert.equal(wf.stages?.length, 3)

  // 1. Start -> dispatches only stage 0 (Alpha).
  let run = startWorkflowRun(pid, { workflowId: wf.id, requirement: "实现工作流 2.0" })
  assert.equal(run.status, "running")
  assert.equal(run.currentStage, 0)
  assert.equal(queued.length, 1)
  assert.equal(queued[0].title, "规划-并行-汇总 · 方案规划")

  // Stage 0 completes -> pauses at human gate (`waiting_gate`), does NOT dispatch stage 1 yet.
  queued.shift().onFinish({ out: "初版方案 V1", runId: "r_a1" })
  run = listWorkflowRuns(pid)[0]
  assert.equal(run.status, "waiting_gate")
  assert.equal(run.stages[0].gateStatus, "pending")
  assert.equal(queued.length, 0)

  // 2. Reject gate with feedback -> re-runs stage 0 with feedback injected in prompt.
  run = rejectWorkflowGate(pid, run.id, "请补充错误处理边界")
  assert.equal(run.status, "running")
  assert.equal(queued.length, 1)
  assert.ok(queued[0].prompt.includes("请补充错误处理边界"))
  queued.shift().onFinish({ out: "完善方案 V2", runId: "r_a2" })
  run = listWorkflowRuns(pid)[0]
  assert.equal(run.status, "waiting_gate")

  // 3. Approve gate -> advances to stage 1 (Beta + Gamma in parallel).
  run = approveWorkflowGate(pid, run.id)
  assert.equal(run.status, "running")
  assert.equal(run.currentStage, 1)
  assert.equal(queued.length, 2)
  assert.ok(queued[0].prompt.includes("完善方案 V2"))
  assert.ok(queued[1].prompt.includes("完善方案 V2"))

  // 4. Fan-in check: Beta finishes, Gamma fails with 503 -> stage 2 MUST NOT start yet.
  const betaJob = queued.shift()
  const gammaJob = queued.shift()
  betaJob.onFinish({ out: "前端完成", runId: "r_b1" })
  run = listWorkflowRuns(pid)[0]
  assert.equal(run.status, "running")
  assert.equal(queued.length, 0)

  gammaJob.onFinish({ out: "", failure: "服务暂无容量（503）", runId: "r_g1" })
  run = listWorkflowRuns(pid)[0]
  assert.equal(run.status, "failed")
  assert.equal(run.stages[1].nodes[0].status, "done")
  assert.equal(run.stages[1].nodes[1].status, "failed")
  assert.equal(queued.length, 0)

  // 5. Single-node retry on Gamma: only Gamma is dispatched; Beta output is preserved!
  const gammaNodeId = run.stages[1].nodes[1].id
  run = retryWorkflowNode(pid, run.id, 1, gammaNodeId, "换轻量模式再试")
  assert.equal(run.status, "running")
  assert.equal(queued.length, 1)
  assert.ok(queued[0].prompt.includes("换轻量模式再试"))
  assert.equal(run.stages[1].nodes[0].output, "前端完成")

  // 6. Replace Gamma mid-run with Backup seat -> cancels old attempt & dispatches Backup.
  const oldGammaJob = queued.shift()
  assert.ok(oldGammaJob)
  run = replaceWorkflowNodeSeat(pid, run.id, 1, gammaNodeId, "Backup")
  assert.equal(run.stages[1].nodes[1].seatName, "Backup")
  assert.equal(queued.length, 1)
  assert.ok(cancelled.length >= 1)

  // Backup succeeds -> fan-in complete -> automatically dispatches stage 2 (Delta) with BOTH outputs!
  queued.shift().onFinish({ out: "后端替补完成", runId: "r_bk1" })
  run = listWorkflowRuns(pid)[0]
  assert.equal(run.currentStage, 2)
  assert.equal(run.status, "running")
  assert.equal(queued.length, 1)
  assert.ok(queued[0].prompt.includes("前端完成"))
  assert.ok(queued[0].prompt.includes("后端替补完成"))

  // 7. Pause & resume on stage 2.
  const deltaJob1 = queued.shift()
  assert.ok(deltaJob1)
  run = pauseWorkflowRun(pid, run.id)
  assert.equal(run.status, "paused")
  run = resumeWorkflowRun(pid, run.id)
  assert.equal(run.status, "running")
  assert.equal(queued.length, 1)

  // Stage 2 completes -> entire workflow done!
  queued.shift().onFinish({ out: "最终汇总报告完成", runId: "r_d2" })
  run = listWorkflowRuns(pid)[0]
  assert.equal(run.status, "done")
  assert.ok(run.endedAt)

  // 8. Stop test on a fresh run.
  const run2 = startWorkflowRun(pid, { workflowId: wf.id, requirement: "测试终止" })
  const stopped = stopWorkflowRun(pid, run2.id)
  assert.equal(stopped.status, "stopped")

  // 9. Verify ZERO group chat messages were polluted by the independent workflow engine.
  const chatAfter = inProject(pid, () => snapshot().messages.length)
  assert.equal(chatAfter, chatBefore)

  console.log("PASS workflow-engine: multi-stage fan-in, gate reject/approve, retry, replace, pause/resume/stop, zero chat pollution")
} finally {
  setWorkflowRunnerForTest(null)
  try { globalThis.__benchSqlite?.db?.close() } catch {}
  rmSync(dir, { recursive: true, force: true })
}
