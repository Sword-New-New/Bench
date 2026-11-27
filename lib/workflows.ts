import { randomBytes } from "node:crypto"

import { dbDeleteWorkflow, dbListWorkflows, dbSaveWorkflow } from "@/lib/db"
import { ApiError, asRecord, asString } from "@/lib/http"
import type { Workflow, WorkflowStage } from "@/lib/types"
import { workflowStages } from "@/lib/workflow-shared"

const RESERVED_COMMANDS = new Set(["goal", "compact", "stop"])
const SEAT_NAME = /^[\p{L}\p{N}_-]{1,24}$/u

function seatName(value: unknown, label: string): string {
  const name = asString(value)
  if (!name || !SEAT_NAME.test(name) || ["所有人", "everyone", "human", "room"].includes(name)) {
    throw new ApiError(400, `${label}要填一个席位名`)
  }
  return name
}

function seatNames(value: unknown, label: string, min = 1): string[] {
  if (!Array.isArray(value) || value.length < min || value.length > 8) {
    throw new ApiError(400, `${label}至少要${min === 2 ? "两" : "一"}个席位，最多八个`)
  }
  const names = value.map((v) => seatName(v, label))
  if (new Set(names).size !== names.length) throw new ApiError(400, `${label}不能重复`)
  return names
}

function parseStages(value: unknown): WorkflowStage[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 6) {
    throw new ApiError(400, "工作流至少要有 1 个阶段，最多 6 个阶段")
  }
  return value.map((raw, index) => {
    const rec = asRecord(raw)
    const title = asString(rec.title)
    if (!title || title.length > 40) throw new ApiError(400, `第 ${index + 1} 阶段名称要填写，最多四十字`)
    const seats = seatNames(rec.seats, `第 ${index + 1} 阶段「${title}」`, 1)
    const instruction = asString(rec.instruction) ?? ""
    if (instruction.length > 1000) throw new ApiError(400, `第 ${index + 1} 阶段指令最多一千字`)
    const id = asString(rec.id) || `st_${randomBytes(4).toString("hex")}`
    return {
      id,
      title,
      seats,
      instruction,
      ...(rec.gate === true ? { gate: true } : {}),
    }
  })
}

export function listWorkflows(projectId: string): Workflow[] {
  return dbListWorkflows(projectId)
}

export function saveWorkflow(projectId: string, input: unknown): Workflow {
  const body = asRecord(input)
  const all = listWorkflows(projectId)
  const id = asString(body.id)
  const old = id ? all.find((item) => item.id === id) : undefined
  if (id && !old) throw new ApiError(404, "没有这条工作流")
  const name = asString(body.name)
  if (!name || name.length > 80) throw new ApiError(400, "工作流名称要填写，最多八十字")
  const kind = body.kind === undefined && Array.isArray(body.stages) ? "custom" : body.kind
  if (kind !== "orchestrate" && kind !== "plan" && kind !== "explore" && kind !== "custom") {
    throw new ApiError(400, "请选择工作流类型")
  }
  const command = asString(body.command)?.replace(/^\//, "") || undefined
  if (command && (!/^[a-z][a-z0-9-]{0,23}$/.test(command) || RESERVED_COMMANDS.has(command))) {
    throw new ApiError(400, "快捷命令要用小写字母、数字或横线，不能占用 goal、compact、stop")
  }
  if (command === "plan" && kind !== "plan") throw new ApiError(400, "plan 命令只用于混合计划")
  if (command === "explore" && kind !== "explore") throw new ApiError(400, "explore 命令只用于多 AI 探索")
  if (command && all.some((item) => item.id !== id && item.command === command)) throw new ApiError(409, "这个快捷命令已存在")
  const note = asString(body.note)
  if (note && note.length > 1000) throw new ApiError(400, "补充规则最多一千字")

  let stages: WorkflowStage[] | undefined
  let roles: Partial<Workflow> = {}
  if (Array.isArray(body.stages) && body.stages.length > 0) {
    stages = parseStages(body.stages)
    if (kind === "orchestrate" && stages.length >= 3) {
      roles = { lead: stages[0].seats[0], workers: stages[1].seats, summarizer: stages[stages.length - 1].seats[0] }
    } else if (kind === "plan" && stages.length >= 1) {
      const lead = stages[stages.length - 1].seats[0]
      const peers = stages.slice(0, -1).flatMap((s) => s.seats).filter((s) => s !== lead)
      roles = { planners: [lead, ...peers] }
    } else if (kind === "explore" && stages.length >= 1) {
      const lead = stages[stages.length - 1].seats[0]
      const peers = stages.slice(0, -1).flatMap((s) => s.seats).filter((s) => s !== lead)
      roles = { explorers: [lead, ...peers] }
    }
  } else if (kind === "custom") {
    throw new ApiError(400, "自定义工作流至少要配置一个阶段")
  } else {
    roles = kind === "plan"
      ? { planners: seatNames(body.planners, "共同规划", 2) }
      : kind === "explore"
        ? { explorers: seatNames(body.explorers, "共同探索", 2) }
        : { lead: seatName(body.lead, "主控"), workers: seatNames(body.workers, "执行"), summarizer: seatName(body.summarizer, "汇总") }
    if (roles.lead && (roles.workers!.includes(roles.lead) || roles.workers!.includes(roles.summarizer!) || roles.lead === roles.summarizer)) {
      throw new ApiError(400, "主控、执行和汇总请用不同席位")
    }
  }

  const draft: Workflow = {
    id: id ?? `wf_${randomBytes(6).toString("hex")}`,
    projectId,
    name,
    kind,
    command,
    ...roles,
    ...(stages ? { stages } : {}),
    note,
    createdAt: old?.createdAt ?? Date.now(),
    updatedAt: Date.now(),
  }
  if (!draft.stages) draft.stages = workflowStages(draft)
  dbSaveWorkflow(draft)
  return draft
}

export function deleteWorkflow(projectId: string, id: string) {
  if (!listWorkflows(projectId).some((item) => item.id === id)) throw new ApiError(404, "没有这条工作流")
  dbDeleteWorkflow(projectId, id)
}

export function findWorkflow(projectId: string, ref: { id?: unknown; command?: unknown }): Workflow {
  const id = asString(ref.id)
  const command = asString(ref.command)
  const saved = listWorkflows(projectId).find((item) => id ? item.id === id : command && item.command === command)
  if (saved) return saved
  if (!id && command === "plan") {
    return { id: "builtin-plan", projectId, name: "混合计划模式", kind: "plan", planners: [], createdAt: 0, updatedAt: 0 }
  }
  if (!id && command === "explore") {
    return { id: "builtin-explore", projectId, name: "多 AI 探索模式", kind: "explore", explorers: [], createdAt: 0, updatedAt: 0 }
  }
  throw new ApiError(404, "没有这条工作流，请在工作流菜单里配置")
}

type Seat = { id: string; name: string; demo?: boolean }
export function renderWorkflow(workflow: Workflow, input: string, seats: Seat[], overrides: Record<string, unknown> = {}) {
  const requirement = input.trim()
  if (!requirement || requirement.length > 2400) throw new ApiError(400, "请写需求，最多两千四百字")
  const roles = { ...workflow, ...overrides }
  if (workflow.kind === "plan" && (!Array.isArray(roles.planners) || roles.planners.length === 0)) {
    throw new ApiError(400, "还没有配置混合计划席位，请在工作流菜单里配置，或使用 /plan 需求 @席位A @席位B 临时指定至少两位搭档")
  }
  if (workflow.kind === "explore" && (!Array.isArray(roles.explorers) || roles.explorers.length === 0)) {
    throw new ApiError(400, "还没有配置探索席位，请在工作流菜单里配置，或使用 /explore 主题 @席位A @席位B 临时指定至少两位席位")
  }
  const planners = workflow.kind === "plan" ? seatNames(roles.planners, "共同规划", 2) : []
  const explorers = workflow.kind === "explore" ? seatNames(roles.explorers, "共同探索", 2) : []
  const lead = workflow.kind === "orchestrate" ? seatName(roles.lead, "主控") : ""
  const workers = workflow.kind === "orchestrate" ? seatNames(roles.workers, "执行") : []
  const summarizer = workflow.kind === "orchestrate" ? seatName(roles.summarizer, "汇总") : ""
  const needed = workflow.kind === "plan" ? planners : workflow.kind === "explore" ? explorers : [lead, ...workers, summarizer]
  if (new Set(needed).size !== needed.length) throw new ApiError(400, "不同职责请用不同席位")
  for (const name of needed) {
    if (!seats.some((seat) => seat.name === name && !seat.demo)) {
      throw new ApiError(400, `${name} 未入座，请点名其他席位或在工作流里配置`)
    }
  }
  const called = workflow.kind === "plan" ? planners : workflow.kind === "explore" ? explorers : [lead]
  const targets = called.map((name) => seats.find((seat) => seat.name === name)!.id)
  const rules = workflow.kind === "plan"
    ? `本轮只做联合规划，不修改代码或文件，也不启动实施。\n${planners[0]} 负责需求边界、潜在风险与验收审查；${planners.slice(1).join("、")} 负责工程拆解、改动点与实施步骤。各自先给出意见（完成后请在回复中明确 @${planners[0]}），交叉对照后由 ${planners[0]} 整合统一分步计划、成本和待用户拍板的选项；等待用户确认再动手。不要互相反复唤起。`
    : workflow.kind === "explore"
      ? `本轮为多 AI 联合探索，只做调研、分析与方案发散，不修改代码或文件，也不启动实施。\n${explorers.join("、")} 各自先独立从不同角度深入探索（可行思路、技术/架构路线对比、潜在盲点与边界风险、代码或事实依据），避免盲目附和他人观点。各自给出有依据的发现后请在回复中明确 @${explorers[0]}，由 ${explorers[0]} 汇总对照全部观点：提炼共识、标出分歧与权衡、给出 2～3 个可落地的候选方向及下一步建议，等待用户拍板。不要互相反复唤起。`
      : `主控：${lead}；执行：${workers.join("、")}；汇总：${summarizer}。\n主控负责拆解方案、用 @席位名 派活给执行席位并复核结果（示例文案里的 @ 请放进代码块，避免误唤起无关席位）；执行席位按主控要求干活，完成后必须在回复中明确 @${lead} 交由主控复核（不写 @ 不会唤起主控）。全部复核完成后由主控明确 @${summarizer} 交接给汇总席位。最终汇总只由 ${summarizer} 输出并收尾，其他席位不再重复长篇总结。当前只唤醒主控，由主控决定何时派活。`
  const heading = workflow.kind === "explore" ? "探索主题" : "用户需求"
  const text = `${called.map((name) => `@${name}`).join(" ")}\n【工作流：${workflow.name}】\n${rules}${workflow.note ? `\n补充规则：${workflow.note}` : ""}\n\n${heading}：\n${requirement}`
  if (text.length > 4000) throw new ApiError(400, "需求和补充规则合起来过长，请缩短后发送")
  const meta = {
    name: workflow.name,
    command: workflow.command,
    requirement,
    ...(workflow.kind === "orchestrate" ? { lead, workers, summarizer } : {}),
    ...(workflow.kind === "plan" ? { planners } : {}),
    ...(workflow.kind === "explore" ? { explorers } : {}),
  }
  return { text, targets, meta }
}
