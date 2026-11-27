import { randomBytes } from "node:crypto"

import {
  dbDeleteWorkflowRun,
  dbGetWorkflowRun,
  dbListWaitingWorkflowRuns,
  dbListWorkflowRuns,
  dbSaveWorkflowRun,
} from "@/lib/db"
import { ApiError, asRecord, asString } from "@/lib/http"
import { agentState, currentProject, inProject, roomChanged, snapshot } from "@/lib/store"
import { cancelWorkflowJob, enqueueWorkflowJob, type WorkflowJob } from "@/lib/summon"
import type { Workflow, WorkflowRun, WorkflowRunNode, WorkflowRunStage, WorkflowStage } from "@/lib/types"
import { findWorkflow, listWorkflows } from "@/lib/workflows"
import { workflowStages } from "@/lib/workflow-shared"

type WorkflowRunner = {
  enqueue: (job: WorkflowJob) => void
  cancel: (projectId: string, agentId: string, jobId: string) => void
}

const defaultRunner: WorkflowRunner = {
  enqueue: enqueueWorkflowJob,
  cancel: cancelWorkflowJob,
}

let activeRunner: WorkflowRunner = defaultRunner

// Test hook so unit tests can drive multi-stage fan-in, gates, retries and
// replacements deterministically without spawning real CLI processes.
export function setWorkflowRunnerForTest(runner: WorkflowRunner | null) {
  activeRunner = runner ?? defaultRunner
}

function jobIdOf(runId: string, stageIndex: number, nodeId: string, attempt: number) {
  return `${runId}:${stageIndex}:${nodeId}:${attempt}`
}

function clipBlock(text: string, max: number) {
  const clean = text.trim()
  return clean.length <= max ? clean : `${clean.slice(0, max)}\n…（已截断，共 ${clean.length} 字）`
}

function buildStagePrompt(
  run: WorkflowRun,
  stageIndex: number,
  node: WorkflowRunNode,
  extraNote?: string,
) {
  const stage = run.stages[stageIndex]
  const total = run.stages.length
  const parts: string[] = [
    `【独立工作流：${run.workflowName}｜第 ${stageIndex + 1}/${total} 阶段：${stage.title}】`,
    `你的席位是 ${node.seatName}。本轮任务在独立工作流中运行，请直接输出完整、结构化的工作结论或修改汇报，不要调用 bench_say 往群聊刷屏。`,
    "如果执行中拿不准关键设计选择需要用户拍板，可以调用 bench_ask 提问，用户回答后你会继续完成本阶段。",
    "",
    "【用户原始需求】",
    run.requirement,
  ]

  // Attach outputs from all preceding stages so downstream nodes have full context.
  const prevSections: string[] = []
  for (let i = 0; i < stageIndex; i += 1) {
    const prev = run.stages[i]
    const lines = prev.nodes
      .filter((n) => n.output?.trim())
      .map((n) => `#### ${n.seatName}\n${clipBlock(n.output!, 4500)}`)
    if (lines.length > 0) {
      prevSections.push(`### 第 ${i + 1} 阶段：${prev.title}\n${lines.join("\n\n")}`)
    }
  }
  if (prevSections.length > 0) {
    parts.push("", "【前面各阶段产出】", prevSections.join("\n\n"))
  }

  parts.push("", `【本阶段职责（${stage.title}）】`, stage.instruction || "请完成本阶段任务并输出清晰结果。")

  if (stage.nodes.length > 1) {
    const peers = stage.nodes.map((n) => n.seatName).filter((name) => name !== node.seatName)
    if (peers.length > 0) {
      parts.push(`（本阶段与你并行的席位：${peers.join("、")}。你只需专注自己负责的部分，房间会等齐全部并行席位后再推进下一阶段。）`)
    }
  }

  if (stage.gateFeedback) {
    parts.push("", "【用户打回修改意见】", stage.gateFeedback)
  }
  if (extraNote) {
    parts.push("", "【本次重跑补充要求】", extraNote)
  }

  return parts.join("\n")
}

function saveAndNotify(run: WorkflowRun) {
  run.updatedAt = Date.now()
  dbSaveWorkflowRun(run)
  inProject(run.projectId, () => roomChanged())
}

function resolveSeat(projectId: string, seatName: string) {
  return inProject(projectId, () => {
    const found = snapshot().agents.find((a) => a.name === seatName && !a.demo)
    if (!found) return null
    return agentState(found.id)
  })
}

function dispatchNode(runId: string, stageIndex: number, nodeId: string, extraNote?: string) {
  const run = dbGetWorkflowRun(runId)
  if (!run) return
  if (run.status === "paused" || run.status === "stopped") return
  const stage = run.stages[stageIndex]
  const node = stage?.nodes.find((n) => n.id === nodeId)
  if (!stage || !node) return

  const seat = resolveSeat(run.projectId, node.seatName)
  if (!seat) {
    node.status = "failed"
    node.error = `${node.seatName} 未入座`
    node.endedAt = Date.now()
    recomputeStage(run, stageIndex)
    saveAndNotify(run)
    return
  }

  node.seatId = seat.id
  node.status = "running"
  node.error = undefined
  node.attempt += 1
  node.startedAt = Date.now()
  node.endedAt = undefined
  run.status = "running"
  run.currentStage = stageIndex
  const attempt = node.attempt
  const prompt = buildStagePrompt(run, stageIndex, node, extraNote)
  const title = `${run.workflowName} · ${stage.title}`
  saveAndNotify(run)

  activeRunner.enqueue({
    id: jobIdOf(run.id, stageIndex, node.id, attempt),
    projectId: run.projectId,
    agentId: seat.id,
    title,
    prompt,
    onStart: (cliRunId) => {
      const latest = dbGetWorkflowRun(runId)
      const target = latest?.stages[stageIndex]?.nodes.find((n) => n.id === nodeId)
      if (!latest || !target || target.attempt !== attempt) return
      target.runId = cliRunId
      saveAndNotify(latest)
    },
    onFinish: ({ out, failure, stopped, runId: cliRunId }) => {
      onNodeFinished(runId, stageIndex, nodeId, attempt, { out, failure, stopped, cliRunId })
    },
  })
}

function dispatchStage(runId: string, stageIndex: number, onlyUnfinished = false) {
  const run = dbGetWorkflowRun(runId)
  if (!run) return
  const stage = run.stages[stageIndex]
  if (!stage) return
  run.currentStage = stageIndex
  run.status = "running"
  if (!onlyUnfinished) {
    stage.gateStatus = undefined
    for (const node of stage.nodes) {
      node.status = "idle"
      node.output = undefined
      node.error = undefined
      node.runId = undefined
      node.startedAt = undefined
      node.endedAt = undefined
    }
  }
  saveAndNotify(run)

  const targets = onlyUnfinished ? stage.nodes.filter((n) => n.status !== "done") : stage.nodes
  if (targets.length === 0) {
    const latest = dbGetWorkflowRun(runId)
    if (latest) {
      recomputeStage(latest, stageIndex)
      saveAndNotify(latest)
    }
    return
  }
  for (const node of targets) {
    dispatchNode(runId, stageIndex, node.id)
  }
}

function recomputeStage(run: WorkflowRun, stageIndex: number): "advance" | "stay" {
  const stage = run.stages[stageIndex]
  if (!stage) return "stay"
  if (run.status === "paused" || run.status === "stopped") return "stay"

  const states = stage.nodes.map((n) => n.status)
  if (states.some((s) => s === "running" || s === "waiting_help")) {
    run.status = "running"
    return "stay"
  }
  if (states.some((s) => s === "failed")) {
    run.status = "failed"
    return "stay"
  }
  if (states.some((s) => s === "stopped" || s === "idle")) {
    return "stay"
  }
  // All nodes in this stage are `done` (Fan-in complete!).
  if (stage.gate && stage.gateStatus !== "approved") {
    stage.gateStatus = "pending"
    run.status = "waiting_gate"
    return "stay"
  }
  if (stageIndex + 1 < run.stages.length) {
    return "advance"
  }
  run.status = "done"
  run.endedAt = Date.now()
  return "stay"
}

function onNodeFinished(
  runId: string,
  stageIndex: number,
  nodeId: string,
  attempt: number,
  result: { out: string; failure?: string; stopped?: boolean; cliRunId?: string },
) {
  const run = dbGetWorkflowRun(runId)
  if (!run) return
  const stage = run.stages[stageIndex]
  const node = stage?.nodes.find((n) => n.id === nodeId)
  if (!stage || !node || node.attempt !== attempt) return

  if (result.cliRunId) node.runId = result.cliRunId
  node.endedAt = Date.now()

  if (result.stopped || run.status === "paused" || run.status === "stopped") {
    node.status = "stopped"
    saveAndNotify(run)
    return
  }
  if (result.failure) {
    node.status = "failed"
    node.error = result.failure
  } else {
    node.status = "done"
    node.output = result.out.trim() || "（本轮未返回正文）"
    node.error = undefined
  }

  const next = recomputeStage(run, stageIndex)
  saveAndNotify(run)
  if (next === "advance") {
    dispatchStage(run.id, stageIndex + 1, false)
  }
}

export function listWorkflowRuns(projectId: string, limit = 20): WorkflowRun[] {
  return dbListWorkflowRuns(projectId, limit)
}

export function listWaitingWorkflowRuns(): WorkflowRun[] {
  return dbListWaitingWorkflowRuns()
}

export function startWorkflowRun(
  projectId: string,
  input: { workflowId?: unknown; command?: unknown; requirement?: unknown; stages?: unknown; name?: unknown },
): WorkflowRun {
  const requirement = asString(input.requirement) ?? ""
  if (!requirement || requirement.length > 4000) {
    throw new ApiError(400, "请填写工作流需求，最多四千字")
  }

  let wf: Workflow | null = null
  let rawStages: WorkflowStage[]
  let workflowName = asString(input.name) || "临时工作流"
  let kind: Workflow["kind"] = "custom"

  if (Array.isArray(input.stages) && input.stages.length > 0) {
    rawStages = (input.stages as WorkflowStage[]).map((s, idx) => ({
      id: asString(s.id) || `st_${idx + 1}`,
      title: asString(s.title) || `阶段 ${idx + 1}`,
      seats: Array.isArray(s.seats) ? s.seats.filter((x): x is string => typeof x === "string" && x.trim().length > 0) : [],
      instruction: asString(s.instruction) ?? "",
      ...(s.gate === true ? { gate: true } : {}),
    }))
  } else {
    wf = findWorkflow(projectId, { id: input.workflowId, command: input.command })
    workflowName = wf.name
    kind = wf.kind
    rawStages = workflowStages(wf)
  }

  if (rawStages.length === 0) {
    throw new ApiError(400, "这个工作流还没有配置阶段和席位，请先编辑配置")
  }

  // Verify every stage has seated agents before starting so users get instant feedback.
  const seats = inProject(projectId, () => snapshot().agents.filter((a) => !a.demo))
  for (const stage of rawStages) {
    if (stage.seats.length === 0) throw new ApiError(400, `阶段「${stage.title}」还没有选择席位`)
    for (const name of stage.seats) {
      if (!seats.some((s) => s.name === name)) {
        throw new ApiError(400, `阶段「${stage.title}」中的 ${name} 尚未入座，请先添加或修改工作流`)
      }
    }
  }

  const now = Date.now()
  const stages: WorkflowRunStage[] = rawStages.map((stage, sIdx) => ({
    id: stage.id || `st_${sIdx + 1}`,
    title: stage.title,
    instruction: stage.instruction,
    ...(stage.gate ? { gate: true } : {}),
    nodes: stage.seats.map((seatName, nIdx) => ({
      id: `n_${sIdx}_${nIdx}_${randomBytes(3).toString("hex")}`,
      seatName,
      seatId: seats.find((s) => s.name === seatName)?.id,
      status: "idle",
      attempt: 0,
    })),
  }))

  const run: WorkflowRun = {
    id: `wfr_${randomBytes(6).toString("hex")}`,
    projectId,
    workflowId: wf?.id ?? "adhoc",
    workflowName,
    kind,
    requirement,
    status: "running",
    currentStage: 0,
    stages,
    createdAt: now,
    updatedAt: now,
  }
  saveAndNotify(run)
  dispatchStage(run.id, 0, false)
  return dbGetWorkflowRun(run.id) ?? run
}

export function approveWorkflowGate(projectId: string, runId: string): WorkflowRun {
  const run = dbGetWorkflowRun(runId)
  if (!run || run.projectId !== projectId) throw new ApiError(404, "没有找到这条工作流记录")
  if (run.status !== "waiting_gate") throw new ApiError(409, "当前不在等待拍板状态")
  const stage = run.stages[run.currentStage]
  if (!stage) throw new ApiError(400, "阶段不存在")
  stage.gateStatus = "approved"
  if (run.currentStage + 1 < run.stages.length) {
    const nextIdx = run.currentStage + 1
    run.status = "running"
    saveAndNotify(run)
    dispatchStage(run.id, nextIdx, false)
  } else {
    run.status = "done"
    run.endedAt = Date.now()
    saveAndNotify(run)
  }
  return dbGetWorkflowRun(run.id) ?? run
}

export function rejectWorkflowGate(projectId: string, runId: string, feedback: string): WorkflowRun {
  const run = dbGetWorkflowRun(runId)
  if (!run || run.projectId !== projectId) throw new ApiError(404, "没有找到这条工作流记录")
  if (run.status !== "waiting_gate") throw new ApiError(409, "当前不在等待拍板状态")
  const stage = run.stages[run.currentStage]
  if (!stage) throw new ApiError(400, "阶段不存在")
  stage.gateStatus = "rejected"
  stage.gateFeedback = feedback.trim() || "请按更严谨的方式重新输出本阶段结果"
  saveAndNotify(run)
  dispatchStage(run.id, run.currentStage, false)
  return dbGetWorkflowRun(run.id) ?? run
}

export function retryWorkflowNode(
  projectId: string,
  runId: string,
  stageIndex: number,
  nodeId: string,
  note?: string,
): WorkflowRun {
  const run = dbGetWorkflowRun(runId)
  if (!run || run.projectId !== projectId) throw new ApiError(404, "没有找到这条工作流记录")
  if (run.status === "stopped") throw new ApiError(409, "已终止的工作流不能重跑")
  const stage = run.stages[stageIndex]
  const node = stage?.nodes.find((n) => n.id === nodeId)
  if (!stage || !node) throw new ApiError(404, "没有找到这个节点")
  if (node.status === "running") throw new ApiError(409, "这个节点正在运行中")

  // Re-running a node in an earlier stage resets downstream stages so outputs stay consistent.
  for (let i = stageIndex + 1; i < run.stages.length; i += 1) {
    run.stages[i].gateStatus = undefined
    for (const downstream of run.stages[i].nodes) {
      if (downstream.status === "running" && downstream.seatId) {
        activeRunner.cancel(projectId, downstream.seatId, jobIdOf(run.id, i, downstream.id, downstream.attempt))
      }
      downstream.status = "idle"
      downstream.output = undefined
      downstream.error = undefined
      downstream.runId = undefined
      downstream.startedAt = undefined
      downstream.endedAt = undefined
    }
  }
  stage.gateStatus = undefined
  run.status = "running"
  run.endedAt = undefined
  saveAndNotify(run)
  dispatchNode(run.id, stageIndex, nodeId, note?.trim() || undefined)
  return dbGetWorkflowRun(run.id) ?? run
}

export function replaceWorkflowNodeSeat(
  projectId: string,
  runId: string,
  stageIndex: number,
  nodeId: string,
  seatName: string,
  note?: string,
): WorkflowRun {
  const run = dbGetWorkflowRun(runId)
  if (!run || run.projectId !== projectId) throw new ApiError(404, "没有找到这条工作流记录")
  if (run.status === "stopped") throw new ApiError(409, "已终止的工作流不能换人")
  const stage = run.stages[stageIndex]
  const node = stage?.nodes.find((n) => n.id === nodeId)
  if (!stage || !node) throw new ApiError(404, "没有找到这个节点")
  const seat = resolveSeat(projectId, seatName.trim())
  if (!seat) throw new ApiError(400, `${seatName} 尚未入座`)

  if (node.status === "running" && node.seatId) {
    activeRunner.cancel(projectId, node.seatId, jobIdOf(run.id, stageIndex, node.id, node.attempt))
  }
  node.seatName = seat.name
  node.seatId = seat.id
  node.status = "idle"
  node.error = undefined
  saveAndNotify(run)
  return retryWorkflowNode(projectId, runId, stageIndex, nodeId, note)
}

function cancelActiveNodes(run: WorkflowRun) {
  run.stages.forEach((stage, sIdx) => {
    for (const node of stage.nodes) {
      if (node.status === "running" && node.seatId) {
        activeRunner.cancel(run.projectId, node.seatId, jobIdOf(run.id, sIdx, node.id, node.attempt))
        node.status = "stopped"
        node.endedAt = Date.now()
      }
    }
  })
}

export function pauseWorkflowRun(projectId: string, runId: string): WorkflowRun {
  const run = dbGetWorkflowRun(runId)
  if (!run || run.projectId !== projectId) throw new ApiError(404, "没有找到这条工作流记录")
  if (run.status !== "running" && run.status !== "waiting_help") throw new ApiError(409, "当前状态无法暂停")
  run.status = "paused"
  cancelActiveNodes(run)
  saveAndNotify(run)
  return dbGetWorkflowRun(run.id) ?? run
}

export function resumeWorkflowRun(projectId: string, runId: string): WorkflowRun {
  const run = dbGetWorkflowRun(runId)
  if (!run || run.projectId !== projectId) throw new ApiError(404, "没有找到这条工作流记录")
  if (run.status !== "paused") throw new ApiError(409, "工作流没有处于暂停状态")
  run.status = "running"
  saveAndNotify(run)
  dispatchStage(run.id, run.currentStage, true)
  return dbGetWorkflowRun(run.id) ?? run
}

export function stopWorkflowRun(projectId: string, runId: string): WorkflowRun {
  const run = dbGetWorkflowRun(runId)
  if (!run || run.projectId !== projectId) throw new ApiError(404, "没有找到这条工作流记录")
  run.status = "stopped"
  run.endedAt = Date.now()
  cancelActiveNodes(run)
  saveAndNotify(run)
  return dbGetWorkflowRun(run.id) ?? run
}

export function deleteWorkflowRun(projectId: string, runId: string) {
  const run = dbGetWorkflowRun(runId)
  if (!run || run.projectId !== projectId) throw new ApiError(404, "没有找到这条工作流记录")
  if (run.status === "running" || run.status === "waiting_help") {
    cancelActiveNodes(run)
  }
  dbDeleteWorkflowRun(projectId, runId)
  inProject(projectId, () => roomChanged())
}

export function workflowRunAction(input: unknown) {
  const body = asRecord(input)
  if (body.as !== "human") throw new ApiError(403, "只有用户能操作工作流运行")
  const pid = currentProject()
  const action = asString(body.action)
  if (action === "start") {
    return {
      run: startWorkflowRun(pid, {
        workflowId: body.workflowId ?? body.id,
        command: body.command,
        requirement: body.requirement ?? body.text,
        stages: body.stages,
        name: body.name,
      }),
    }
  }
  const runId = asString(body.runId ?? body.id) ?? ""
  if (action === "approve") return { run: approveWorkflowGate(pid, runId) }
  if (action === "reject") return { run: rejectWorkflowGate(pid, runId, asString(body.feedback) ?? "") }
  if (action === "retry") {
    return {
      run: retryWorkflowNode(
        pid,
        runId,
        Number(body.stageIndex ?? 0),
        asString(body.nodeId) ?? "",
        asString(body.note),
      ),
    }
  }
  if (action === "replace") {
    return {
      run: replaceWorkflowNodeSeat(
        pid,
        runId,
        Number(body.stageIndex ?? 0),
        asString(body.nodeId) ?? "",
        asString(body.seatName) ?? "",
        asString(body.note),
      ),
    }
  }
  if (action === "pause") return { run: pauseWorkflowRun(pid, runId) }
  if (action === "resume") return { run: resumeWorkflowRun(pid, runId) }
  if (action === "stop") return { run: stopWorkflowRun(pid, runId) }
  if (action === "delete") {
    deleteWorkflowRun(pid, runId)
    return { ok: true }
  }
  throw new ApiError(400, "未知的工作流运行操作")
}

// Helper for UI / tests to list saved workflows alongside runs.
export function workflowWorkspaceState(projectId: string) {
  return {
    workflows: listWorkflows(projectId),
    runs: listWorkflowRuns(projectId),
  }
}
