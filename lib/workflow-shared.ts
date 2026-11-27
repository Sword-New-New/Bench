import type { Workflow, WorkflowStage } from "@/lib/types"

// Convert any Workflow (including legacy v1 orchestrate/plan/explore records
// without explicit `stages`) into an ordered multi-stage pipeline definition.
export function workflowStages(workflow: Workflow): WorkflowStage[] {
  if (Array.isArray(workflow.stages) && workflow.stages.length > 0) {
    return workflow.stages
  }
  if (workflow.kind === "plan") {
    const list = workflow.planners ?? []
    const lead = list[0]
    const peers = list.slice(1)
    const stages: WorkflowStage[] = []
    if (peers.length > 0) {
      stages.push({
        id: "plan-peers",
        title: "工程拆解",
        seats: peers,
        instruction: "本轮只做规划，不修改代码或文件。请给出工程拆解、改动点、实施步骤和潜在风险。",
      })
    }
    if (lead) {
      stages.push({
        id: "plan-lead",
        title: "统稿定案",
        seats: [lead],
        instruction: "本轮只做规划，不修改代码或文件。请审查需求边界与风险，整合上一阶段的拆解形成统一分步计划和待确认选项。",
        gate: true,
      })
    }
    return stages
  }
  if (workflow.kind === "explore") {
    const list = workflow.explorers ?? []
    const lead = list[0]
    const peers = list.slice(1)
    const stages: WorkflowStage[] = []
    if (peers.length > 0) {
      stages.push({
        id: "explore-peers",
        title: "并行探索",
        seats: peers,
        instruction: "本轮只做调研与方案发散，不修改代码或文件。请独立分析可行路线、优缺点和潜在盲点。",
      })
    }
    if (lead) {
      stages.push({
        id: "explore-lead",
        title: "共识汇总",
        seats: [lead],
        instruction: "本轮只做调研与方案发散，不修改代码或文件。请汇总对照全部探索观点：提炼共识、标出分歧与权衡，给出 2～3 个候选方向供拍板。",
      })
    }
    return stages
  }
  const stages: WorkflowStage[] = []
  if (workflow.lead) {
    stages.push({
      id: "orch-lead",
      title: "主控拆解",
      seats: [workflow.lead],
      instruction: "请拆解需求方案、明确接口边界和每个执行席位的具体分工，供下一阶段并行实施。",
    })
  }
  if (workflow.workers?.length) {
    stages.push({
      id: "orch-workers",
      title: "并行执行",
      seats: workflow.workers,
      instruction: "请严格按上一阶段主控拆解的方案完成你负责的部分，验证无误后汇报改动文件、核心实现和遗留注意事项。",
    })
  }
  if (workflow.summarizer) {
    stages.push({
      id: "orch-sum",
      title: "最终汇总",
      seats: [workflow.summarizer],
      instruction: "请复核并汇总前面各阶段的完整成果，输出清晰简洁的最终交付总结与验证方式。",
    })
  }
  return stages
}

export type WorkflowPreset = {
  id: string
  name: string
  tagline: string
  kind: Workflow["kind"]
  stages: Omit<WorkflowStage, "id">[]
}

export const WORKFLOW_PRESETS: WorkflowPreset[] = [
  {
    id: "plan-gate-build",
    name: "规划 → 拍板 → 并行实施 → 汇总",
    tagline: "先出方案停在「等你定」，确认后再让多位 AI 并行干活",
    kind: "custom",
    stages: [
      {
        title: "方案规划",
        seats: [],
        instruction: "只做方案设计，不改代码或文件。输出清晰的分步实施计划、文件改动清单和关键决策点。",
        gate: true,
      },
      {
        title: "并行实施",
        seats: [],
        instruction: "严格按照已拍板的方案完成各自负责的开发与测试任务，汇报改动文件与验证结果。",
      },
      {
        title: "复核汇总",
        seats: [],
        instruction: "交叉检查上一阶段的代码改动与测试结果，汇总最终交付说明和验收步骤。",
      },
    ],
  },
  {
    id: "orchestrate-classic",
    name: "主控派活 → 并行执行 → 最终汇总",
    tagline: "1 位主控拆解任务，多位并行执行，最后 1 位汇总收尾",
    kind: "orchestrate",
    stages: [
      {
        title: "主控拆解",
        seats: [],
        instruction: "拆解需求、明确边界并给下一阶段各执行席位分配清晰子任务。",
      },
      {
        title: "并行执行",
        seats: [],
        instruction: "按主控方案并行完成对应实现与自检，汇总各自产出。",
      },
      {
        title: "最终汇总",
        seats: [],
        instruction: "整理并复核所有执行结果，输出最终交付摘要。",
      },
    ],
  },
  {
    id: "explore-compare",
    name: "多 AI 并行探索 → 汇总对比",
    tagline: "多位 AI 独立发散调研（不改代码），由首位提炼共识与候选路线",
    kind: "explore",
    stages: [
      {
        title: "并行探索",
        seats: [],
        instruction: "只调研分析不改代码。独立从可行思路、架构对比、潜在风险给出有依据的发现。",
      },
      {
        title: "共识汇总",
        seats: [],
        instruction: "对照全部探索结果：提炼共识、标出分歧与权衡，给出 2～3 个可落地的候选方向供拍板。",
      },
    ],
  },
]
