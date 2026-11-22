import { randomBytes } from "node:crypto"

import { dbDeleteWorkflow, dbListWorkflows, dbSaveWorkflow } from "@/lib/db"
import { ApiError, asRecord, asString } from "@/lib/http"
import type { Workflow } from "@/lib/types"

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
  if (body.kind !== "orchestrate" && body.kind !== "plan") throw new ApiError(400, "请选择工作流类型")
  const command = asString(body.command)?.replace(/^\//, "") || undefined
  if (command && (!/^[a-z][a-z0-9-]{0,23}$/.test(command) || RESERVED_COMMANDS.has(command))) {
    throw new ApiError(400, "快捷命令要用小写字母、数字或横线，不能占用 goal、compact、stop")
  }
  if (command === "plan" && body.kind !== "plan") throw new ApiError(400, "plan 命令只用于混合计划")
  if (command && all.some((item) => item.id !== id && item.command === command)) throw new ApiError(409, "这个快捷命令已存在")
  const note = asString(body.note)
  if (note && note.length > 1000) throw new ApiError(400, "补充规则最多一千字")
  const roles = body.kind === "plan"
    ? { planners: seatNames(body.planners, "共同规划", 2) }
    : { lead: seatName(body.lead, "主控"), workers: seatNames(body.workers, "执行"), summarizer: seatName(body.summarizer, "汇总") }
  if (roles.lead && (roles.workers!.includes(roles.lead) || roles.workers!.includes(roles.summarizer!) || roles.lead === roles.summarizer)) {
    throw new ApiError(400, "主控、执行和汇总请用不同席位")
  }
  const workflow: Workflow = {
    id: id ?? `wf_${randomBytes(6).toString("hex")}`, projectId, name, kind: body.kind, command, ...roles, note,
    createdAt: old?.createdAt ?? Date.now(), updatedAt: Date.now(),
  }
  dbSaveWorkflow(workflow)
  return workflow
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
  const planners = workflow.kind === "plan" ? seatNames(roles.planners, "共同规划", 2) : []
  const lead = workflow.kind === "orchestrate" ? seatName(roles.lead, "主控") : ""
  const workers = workflow.kind === "orchestrate" ? seatNames(roles.workers, "执行") : []
  const summarizer = workflow.kind === "orchestrate" ? seatName(roles.summarizer, "汇总") : ""
  const needed = workflow.kind === "plan" ? planners : [lead, ...workers, summarizer]
  if (new Set(needed).size !== needed.length) throw new ApiError(400, "不同职责请用不同席位")
  for (const name of needed) {
    if (!seats.some((seat) => seat.name === name && !seat.demo)) {
      throw new ApiError(400, `${name} 未入座，请点名其他席位或在工作流里配置`)
    }
  }
  const called = workflow.kind === "plan" ? planners : [lead]
  const targets = called.map((name) => seats.find((seat) => seat.name === name)!.id)
  const rules = workflow.kind === "plan"
    ? `本轮只做联合规划，不修改代码或文件，也不启动实施。\n${planners[0]} 负责需求边界、潜在风险与验收审查；${planners.slice(1).join("、")} 负责工程拆解、改动点与实施步骤。各自先给出意见，交叉对照后由 ${planners[0]} 整合统一分步计划、成本和待用户拍板的选项；等待用户确认再动手。不要互相反复唤起。`
    : `主控：${lead}；执行：${workers.join("、")}；汇总：${summarizer}。\n主控负责拆解方案、派活执行并复核结果；执行席位按主控要求干活，把结果回给主控。全部完成后由主控点名交接给汇总席位。最终汇总只由 ${summarizer} 输出并收尾，其他席位不再重复长篇总结。当前只唤醒主控，由主控决定何时派活。`
  const text = `${called.map((name) => `@${name}`).join(" ")}\n【工作流：${workflow.name}】\n${rules}${workflow.note ? `\n补充规则：${workflow.note}` : ""}\n\n用户需求：\n${requirement}`
  if (text.length > 4000) throw new ApiError(400, "需求和补充规则合起来过长，请缩短后发送")
  return { text, targets }
}
