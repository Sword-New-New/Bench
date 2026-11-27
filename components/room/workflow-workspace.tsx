"use client"

import { useMemo, useState, type CSSProperties } from "react"
import {
  ArrowRightLeft,
  Check,
  Clock,
  GitBranch,
  History,
  ListTree,
  Loader2,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Settings2,
  ShieldAlert,
  Square,
  Trash2,
} from "lucide-react"
import { toast } from "sonner"

import { api } from "@/components/room/api"
import { seatLook } from "@/components/room/bits"
import { Markdown } from "@/components/room/markdown"
import { WORKFLOW_META } from "@/components/room/workflow-card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { clock } from "@/lib/status"
import type {
  PublicAgent,
  Workflow,
  WorkflowNodeStatus,
  WorkflowRun,
  WorkflowRunNode,
  WorkflowStage,
} from "@/lib/types"
import { WORKFLOW_PRESETS, workflowStages } from "@/lib/workflow-shared"

// 45° rounded-corner aurora trace between two points.
function roundedTrace(x1: number, y1: number, x2: number, y2: number): string {
  if (Math.abs(y1 - y2) < 1) return `M ${x1} ${y1} L ${x2} ${y2}`
  const dy = y2 - y1
  const span = Math.min(Math.abs(dy), Math.max(12, (x2 - x1) * 0.42))
  const midX = (x1 + x2) / 2
  const bend1X = midX - span / 2
  const bend2X = midX + span / 2
  const r = Math.min(8, span / 3, Math.max(2, bend1X - x1 - 2), Math.max(2, x2 - bend2X - 2))
  const diag = Math.hypot(bend2X - bend1X, dy)
  const ux = (bend2X - bend1X) / diag
  const uy = dy / diag
  return [
    `M ${x1} ${y1}`,
    `L ${bend1X - r} ${y1}`,
    `Q ${bend1X} ${y1} ${bend1X + ux * r} ${y1 + uy * r}`,
    `L ${bend2X - ux * r} ${y2 - uy * r}`,
    `Q ${bend2X} ${y2} ${bend2X + r} ${y2}`,
    `L ${x2} ${y2}`,
  ].join(" ")
}

type TraceVisualState = "idle" | "active" | "done" | "broken" | "waiting"

type CanvasNode = {
  key: string
  stageIndex: number
  nodeId: string
  seatName: string
  status: WorkflowNodeStatus
  desc: string
  x: number
  y: number
  w: number
  h: number
}

type CanvasTrace = {
  key: string
  d: string
  pts: [number, number, number, number]
  state: TraceVisualState
}

function formatDuration(start?: number, end?: number) {
  if (!start) return ""
  const sec = Math.max(1, Math.round(((end ?? Date.now()) - start) / 1000))
  if (sec < 60) return `${sec}s`
  return `${Math.floor(sec / 60)}m${sec % 60}s`
}

const RUN_STATUS_META: Record<WorkflowRun["status"], { label: string; tone: string }> = {
  running: { label: "运行中", tone: "text-sky-400" },
  waiting_gate: { label: "等你拍板", tone: "text-amber-500 dark:text-amber-400" },
  waiting_help: { label: "等你协助", tone: "text-amber-500 dark:text-amber-400" },
  paused: { label: "已暂停", tone: "text-muted-foreground" },
  done: { label: "已完成", tone: "text-emerald-500" },
  failed: { label: "遇阻", tone: "text-rose-500" },
  stopped: { label: "已终止", tone: "text-muted-foreground" },
}

const NODE_STATUS_TEXT: Record<WorkflowNodeStatus, string> = {
  idle: "待命",
  running: "正在处理…",
  waiting_help: "等你协助",
  done: "已完成",
  failed: "执行失败",
  stopped: "已停止",
}

// Shared multi-stage aurora pipeline visualizer, usable for both live WorkflowRun
// instances and static Workflow template previews (including the stage editor).
export function StagePipelineCanvas({
  stages,
  agents,
  accent = "#38bdf8",
  selectedKey,
  onSelectNode,
  compact = false,
}: {
  stages: {
    id: string
    title: string
    gate?: boolean
    gateStatus?: "pending" | "approved" | "rejected"
    nodes: {
      id: string
      seatName: string
      status: WorkflowNodeStatus
      desc?: string
    }[]
  }[]
  agents: PublicAgent[]
  accent?: string
  selectedKey?: string | null
  onSelectNode?: (stageIndex: number, nodeId: string) => void
  compact?: boolean
}) {
  const byName = useMemo(() => new Map(agents.map((a) => [a.name, a])), [agents])

  const layout = useMemo(() => {
    const colW = compact ? 148 : 176
    const colGap = compact ? 66 : 86
    const padX = 20
    const headH = compact ? 30 : 34
    const padBottom = 18
    const maxNodes = Math.max(1, ...stages.map((s) => Math.max(1, s.nodes.length)))
    const rowH = compact ? (maxNodes >= 4 ? 44 : 52) : maxNodes >= 4 ? 50 : 62
    const rowGap = compact ? 8 : 12
    const bodyH = maxNodes * rowH + (maxNodes - 1) * rowGap
    const height = Math.max(compact ? 124 : 158, headH + bodyH + padBottom)
    const width = Math.max(compact ? 420 : 540, padX * 2 + stages.length * colW + Math.max(0, stages.length - 1) * colGap)

    const nodes: CanvasNode[] = []
    const stageCols: { x: number; w: number; title: string; gate?: boolean; gateStatus?: string; nodes: CanvasNode[] }[] = []

    stages.forEach((stage, sIdx) => {
      const x = padX + sIdx * (colW + colGap)
      const count = Math.max(1, stage.nodes.length)
      const colContentH = count * rowH + (count - 1) * rowGap
      const startY = headH + Math.round((height - headH - padBottom - colContentH) / 2)
      const colNodes: CanvasNode[] = []

      stage.nodes.forEach((n, nIdx) => {
        const y = startY + nIdx * (rowH + rowGap)
        const item: CanvasNode = {
          key: `${sIdx}:${n.id}`,
          stageIndex: sIdx,
          nodeId: n.id,
          seatName: n.seatName,
          status: n.status,
          desc: n.desc ?? NODE_STATUS_TEXT[n.status],
          x,
          y,
          w: colW,
          h: rowH,
        }
        nodes.push(item)
        colNodes.push(item)
      })
      stageCols.push({ x, w: colW, title: stage.title, gate: stage.gate, gateStatus: stage.gateStatus, nodes: colNodes })
    })

    const traces: CanvasTrace[] = []
    for (let sIdx = 0; sIdx < stageCols.length - 1; sIdx += 1) {
      const leftStage = stageCols[sIdx]
      const rightStage = stageCols[sIdx + 1]
      const leftAllDone = leftStage.nodes.length > 0 && leftStage.nodes.every((n) => n.status === "done")
      const gatePending = leftStage.gate && leftStage.gateStatus === "pending"
      const rightAnyRunning = rightStage.nodes.some((n) => n.status === "running" || n.status === "waiting_help")
      const rightAnyDone = rightStage.nodes.some((n) => n.status === "done")

      // Connect every upstream node to downstream nodes via clean fan-out / fan-in.
      // When both sides have multiple nodes (m > 1 and n > 1), route through a central
      // bus point so lines stay crisp instead of forming an unreadable spider web.
      const leftList = leftStage.nodes
      const rightList = rightStage.nodes
      if (leftList.length > 1 && rightList.length > 1) {
        const busX = leftStage.x + leftStage.w + Math.round(colGap / 2)
        const busY = headH + Math.round((height - headH - padBottom) / 2)
        leftList.forEach((ln, li) => {
          const ly = Math.round(ln.y + ln.h / 2)
          const st: TraceVisualState = gatePending
            ? "waiting"
            : ln.status === "done" && rightAnyRunning
              ? "active"
              : ln.status === "done" && rightAnyDone
                ? "done"
                : ln.status === "done"
                  ? "done"
                  : "idle"
          traces.push({
            key: `bus-l-${sIdx}-${li}`,
            d: roundedTrace(ln.x + ln.w, ly, busX, busY),
            pts: [ln.x + ln.w, ly, busX, busY],
            state: st,
          })
        })
        rightList.forEach((rn, ri) => {
          const ry = Math.round(rn.y + rn.h / 2)
          const st: TraceVisualState =
            rn.status === "failed"
              ? "broken"
              : gatePending
                ? "waiting"
                : leftAllDone && (rn.status === "running" || rn.status === "waiting_help")
                  ? "active"
                  : leftAllDone && rn.status === "done"
                    ? "done"
                    : "idle"
          traces.push({
            key: `bus-r-${sIdx}-${ri}`,
            d: roundedTrace(busX, busY, rn.x, ry),
            pts: [busX, busY, rn.x, ry],
            state: st,
          })
        })
      } else {
        leftList.forEach((ln, li) => {
          const ly = Math.round(ln.y + ln.h / 2)
          rightList.forEach((rn, ri) => {
            const ry = Math.round(rn.y + rn.h / 2)
            let st: TraceVisualState = "idle"
            if (rn.status === "failed") st = "broken"
            else if (gatePending) st = "waiting"
            else if (ln.status === "done" && rn.status === "done") st = "done"
            else if (ln.status === "done" && (rn.status === "running" || rn.status === "waiting_help")) {
              // Fan-in into single downstream node shows flowing aurora beam;
              // Fan-out dispatch already delivered shows solid green.
              st = leftList.length > 1 || sIdx > 0 ? "active" : "done"
            }
            traces.push({
              key: `tr-${sIdx}-${li}-${ri}`,
              d: roundedTrace(ln.x + ln.w, ly, rn.x, ry),
              pts: [ln.x + ln.w, ly, rn.x, ry],
              state: st,
            })
          })
        })
      }
    }

    return { width, height, stageCols, nodes, traces }
  }, [stages, compact])

  return (
    <div
      className="relative w-full overflow-x-auto"
      style={{
        background: `radial-gradient(ellipse 65% 85% at 50% 0%, color-mix(in srgb, ${accent} 7%, transparent), transparent 75%)`,
      }}
    >
      <div className="relative mx-auto" style={{ width: `${layout.width}px`, height: `${layout.height}px` }}>
        {/* Stage headers */}
        {layout.stageCols.map((col, idx) => (
          <div
            key={idx}
            style={{ left: `${col.x}px`, width: `${col.w}px`, top: "8px" }}
            className="absolute flex items-center justify-between gap-1 px-0.5 text-[11px]"
          >
            <span className="truncate font-medium text-muted-foreground">
              {idx + 1}. {col.title}
            </span>
            {col.gate ? (
              <span
                className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
                  col.gateStatus === "pending"
                    ? "bg-amber-500/20 text-amber-500 dark:text-amber-300"
                    : col.gateStatus === "approved"
                      ? "bg-emerald-500/15 text-emerald-500"
                      : "bg-foreground/[0.06] text-muted-foreground"
                }`}
                title="此阶段全部完成后暂停等你拍板"
              >
                {col.gateStatus === "pending" ? "⏸ 待拍板" : col.gateStatus === "approved" ? "✓ 已通过" : "⏸ 卡点"}
              </span>
            ) : null}
          </div>
        ))}

        {/* Aurora 45° rounded traces */}
        <svg
          width={layout.width}
          height={layout.height}
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          className="pointer-events-none absolute inset-0"
        >
          {layout.traces.map((tr) => {
            const [x1, y1, x2, y2] = tr.pts
            const baseStroke =
              tr.state === "done"
                ? "color-mix(in srgb, #34d399 55%, transparent)"
                : tr.state === "broken"
                  ? "color-mix(in srgb, #fb7185 55%, transparent)"
                  : tr.state === "waiting"
                    ? "color-mix(in srgb, #f59e0b 55%, transparent)"
                    : tr.state === "active"
                      ? `color-mix(in srgb, ${accent} 28%, transparent)`
                      : "color-mix(in srgb, var(--foreground) 14%, transparent)"
            const dotColor =
              tr.state === "done"
                ? "#34d399"
                : tr.state === "broken"
                  ? "#fb7185"
                  : tr.state === "waiting"
                    ? "#f59e0b"
                    : tr.state === "active"
                      ? accent
                      : "color-mix(in srgb, var(--foreground) 25%, transparent)"
            return (
              <g key={tr.key}>
                <path
                  d={tr.d}
                  fill="none"
                  stroke={baseStroke}
                  strokeWidth={tr.state === "idle" ? 1.5 : 2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeDasharray={tr.state === "broken" || tr.state === "waiting" ? "4 5" : undefined}
                />
                {tr.state === "active" ? (
                  <path
                    d={tr.d}
                    fill="none"
                    stroke={accent}
                    strokeWidth={2.6}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="wf-beam"
                  />
                ) : null}
                <circle cx={x1} cy={y1} r={2.5} fill={dotColor} />
                <circle cx={x2} cy={y2} r={2.5} fill={dotColor} />
              </g>
            )
          })}
        </svg>

        {/* Seat nodes */}
        {layout.nodes.map((node) => {
          const seat = byName.get(node.seatName)
          const color = seat ? seatLook(seat).color : "#94a3b8"
          const missing = !seat || seat.demo
          const selected = selectedKey === node.key
          const descColor =
            node.status === "running"
              ? color
              : node.status === "done"
                ? "#34d399"
                : node.status === "failed"
                  ? "#fb7185"
                  : node.status === "waiting_help"
                    ? "#f59e0b"
                    : missing
                      ? "#f59e0b"
                      : undefined
          const cssState =
            node.status === "failed" ? "error" : node.status === "stopped" ? "idle" : node.status

          return (
            <button
              key={node.key}
              type="button"
              data-state={cssState}
              disabled={!onSelectNode}
              style={
                {
                  left: `${node.x}px`,
                  top: `${node.y}px`,
                  width: `${node.w}px`,
                  height: `${node.h}px`,
                  "--wf-seat": color,
                } as CSSProperties
              }
              className={`wf-node absolute text-left ${onSelectNode ? "cursor-pointer" : "cursor-default"} ${
                selected ? "ring-2 ring-primary/70 ring-offset-1 ring-offset-background" : ""
              }`}
              onClick={() => onSelectNode?.(node.stageIndex, node.nodeId)}
            >
              <div className="flex h-full w-full flex-col justify-between rounded-[calc(0.75rem-1px)] bg-background/88 px-2.5 py-1.5 backdrop-blur-xs">
                <div className="flex w-full items-center justify-between gap-1.5">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span
                      className={`size-2 shrink-0 rounded-full ${
                        node.status === "running" || node.status === "waiting_help" ? "wf-breathe" : ""
                      }`}
                      style={{ background: node.status === "waiting_help" ? "#f59e0b" : color }}
                    />
                    <span className="truncate text-xs font-semibold text-foreground">{node.seatName}</span>
                  </div>
                  {seat?.model ? (
                    <span className="max-w-[5rem] truncate text-[10px] text-muted-foreground">{seat.model}</span>
                  ) : null}
                </div>
                <span
                  className="truncate text-[11px] font-medium text-muted-foreground"
                  style={descColor ? { color: descColor } : undefined}
                >
                  {node.status === "done"
                    ? "✓ "
                    : node.status === "failed"
                      ? "! "
                      : node.status === "waiting_help"
                        ? "⏸ "
                        : ""}
                  {missing && node.status === "idle" ? "未入座" : node.desc}
                </span>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}

export function WorkflowWorkspace({
  workflows,
  runs,
  agents,
  onManage,
  onOpenRun,
  onChanged,
  onAddSeat,
}: {
  workflows: Workflow[]
  runs: WorkflowRun[]
  agents: PublicAgent[]
  onManage: () => void
  onOpenRun: (runId: string) => void
  onChanged: () => void
  onAddSeat?: () => void
}) {
  const realSeats = useMemo(() => agents.filter((a) => !a.demo), [agents])
  const seatNames = useMemo(() => agents.map((a) => a.name), [agents])

  // Mode: viewing an existing run OR composing a fresh run.
  const [selectedRunId, setSelectedRunId] = useState<string | "new">(() => (runs[0] ? runs[0].id : "new"))
  const [pickedWorkflowId, setPickedWorkflowId] = useState<string>(() => workflows[0]?.id ?? "")
  const [requirement, setRequirement] = useState("")
  const [busy, setBusy] = useState(false)
  const [selectedNodeKey, setSelectedNodeKey] = useState<string | null>(null)
  const [rejectOpen, setRejectOpen] = useState(false)
  const [rejectFeedback, setRejectFeedback] = useState("")
  const [retryNote, setRetryNote] = useState("")
  const [replaceSeat, setReplaceSeat] = useState("")

  const activeRun =
    selectedRunId === "new"
      ? null
      : runs.find((r) => r.id === selectedRunId) ?? runs[0] ?? null

  const activeWorkflow =
    workflows.find((w) => w.id === pickedWorkflowId) ?? workflows[0] ?? null

  // Resolve currently inspected node inside activeRun (defaults to first running/failed/waiting or last done).
  const inspected = useMemo(() => {
    if (!activeRun) return null
    if (selectedNodeKey) {
      const [sStr, nodeId] = selectedNodeKey.split(":")
      const sIdx = Number(sStr)
      const stage = activeRun.stages[sIdx]
      const node = stage?.nodes.find((n) => n.id === nodeId)
      if (stage && node) return { stageIndex: sIdx, stage, node }
    }
    const curStage = activeRun.stages[activeRun.currentStage] ?? activeRun.stages[0]
    if (!curStage) return null
    const interesting =
      curStage.nodes.find((n) => n.status === "failed" || n.status === "waiting_help" || n.status === "running") ??
      curStage.nodes.find((n) => n.status === "done") ??
      curStage.nodes[0]
    return interesting ? { stageIndex: activeRun.currentStage, stage: curStage, node: interesting } : null
  }, [activeRun, selectedNodeKey])

  async function callRunApi(payload: Record<string, unknown>, okToast?: string) {
    setBusy(true)
    try {
      const res = await api<{ run?: WorkflowRun; ok?: boolean }>("/api/v1/workflow-runs", {
        method: "POST",
        body: JSON.stringify({ as: "human", ...payload }),
      })
      if (res.run) setSelectedRunId(res.run.id)
      if (okToast) toast.success(okToast)
      onChanged()
      return res
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "操作失败")
      return null
    } finally {
      setBusy(false)
    }
  }

  async function startNew() {
    if (!activeWorkflow) {
      toast.error("请先新建一条工作流模板")
      return
    }
    if (!requirement.trim()) {
      toast.error("先写一下这次要做的需求")
      return
    }
    const res = await callRunApi(
      { action: "start", workflowId: activeWorkflow.id, requirement: requirement.trim() },
      `已启动「${activeWorkflow.name}」`,
    )
    if (res?.run) {
      setRequirement("")
      setSelectedNodeKey(null)
    }
  }

  async function quickCreatePreset(presetIndex: number) {
    const preset = WORKFLOW_PRESETS[presetIndex]
    if (!preset) return
    if (realSeats.length === 0) {
      toast.error("房间里还没有已入座的 AI，先在左栏添加席位")
      onAddSeat?.()
      return
    }
    // Fill stages smartly using available seats (cycling if fewer seats exist).
    const stages: WorkflowStage[] = preset.stages.map((st, idx) => {
      const pick =
        idx === 1 && realSeats.length >= 3 && preset.stages.length >= 3
          ? [realSeats[1].name, realSeats[2].name]
          : [realSeats[idx % realSeats.length].name]
      return {
        id: `st_${idx + 1}`,
        title: st.title,
        seats: pick,
        instruction: st.instruction,
        ...(st.gate ? { gate: true } : {}),
      }
    })
    setBusy(true)
    try {
      const res = await api<{ workflow: Workflow }>("/api/v1/workflows", {
        method: "POST",
        body: JSON.stringify({
          as: "human",
          action: "save",
          workflow: { name: preset.name, kind: preset.kind, stages },
        }),
      })
      setPickedWorkflowId(res.workflow.id)
      setSelectedRunId("new")
      toast.success(`已创建模板「${res.workflow.name}」，可点「管理模板」微调席位`)
      onChanged()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "创建模板失败")
    } finally {
      setBusy(false)
    }
  }

  const meta = WORKFLOW_META[(activeRun?.kind ?? activeWorkflow?.kind ?? "custom")]
  const shellState = !activeRun
    ? "idle"
    : activeRun.status === "failed"
      ? "error"
      : activeRun.status === "waiting_gate" || activeRun.status === "waiting_help"
        ? "waiting"
        : activeRun.status === "running"
          ? "active"
          : activeRun.status === "done"
            ? "done"
            : "idle"

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto px-3 pt-1 pb-6 lg:px-4">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-3">
        {/* Top workspace toolbar: templates + history + new run */}
        <div className="frost flex flex-wrap items-center justify-between gap-2 rounded-2xl px-3.5 py-2.5">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <GitBranch className="size-4 shrink-0 text-muted-foreground" />
            {workflows.map((wf) => {
              const on = !activeRun && activeWorkflow?.id === wf.id
              const m = WORKFLOW_META[wf.kind]
              return (
                <button
                  key={wf.id}
                  type="button"
                  onClick={() => {
                    setPickedWorkflowId(wf.id)
                    setSelectedRunId("new")
                  }}
                  style={
                    on
                      ? {
                          borderColor: `color-mix(in srgb, ${m.accent} 48%, transparent)`,
                          background: `color-mix(in srgb, ${m.accent} 14%, transparent)`,
                          color: m.accent,
                        }
                      : undefined
                  }
                  className={`chip rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${
                    on ? "" : "border-border/80 bg-background/50 text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {wf.name}
                </button>
              )
            })}
            <Button type="button" variant="ghost" size="xs" onClick={onManage}>
              <Settings2 className="size-3.5" />
              {workflows.length ? "管理模板" : "新建模板"}
            </Button>
          </div>

          <div className="flex items-center gap-1.5">
            {runs.length > 0 ? (
              <div className="inline-flex items-center gap-1 rounded-full border border-border/80 bg-background/50 px-2 py-0.5 text-xs">
                <History className="size-3.5 text-muted-foreground" />
                <select
                  aria-label="选择工作流运行记录"
                  className="max-w-[13rem] bg-transparent pr-1 text-xs outline-none"
                  value={activeRun ? activeRun.id : "new"}
                  onChange={(e) => {
                    setSelectedRunId(e.target.value)
                    setSelectedNodeKey(null)
                    setRejectOpen(false)
                  }}
                >
                  <option value="new">+ 发起新一轮工作流</option>
                  {runs.map((r) => (
                    <option key={r.id} value={r.id}>
                      [{RUN_STATUS_META[r.status].label}] {r.workflowName} · {clock(r.createdAt)}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
            {activeRun ? (
              <Button
                type="button"
                variant="outline"
                size="xs"
                onClick={() => {
                  setSelectedRunId("new")
                  setSelectedNodeKey(null)
                }}
              >
                <Plus className="size-3.5" />
                新一轮
              </Button>
            ) : null}
          </div>
        </div>

        {/* Empty state: no saved workflows yet */}
        {!activeRun && workflows.length === 0 ? (
          <div className="frost space-y-4 rounded-2xl p-5">
            <div className="space-y-1">
              <h2 className="text-base font-semibold">独立工作流工作台</h2>
              <p className="text-sm text-muted-foreground">
                把多 AI 协作拆成有序阶段，由房间自动等齐交接、不刷群聊。挑一套预设一键建好，或自由拼装阶段：
              </p>
            </div>
            <div className="grid gap-2.5 sm:grid-cols-3">
              {WORKFLOW_PRESETS.map((preset, idx) => (
                <button
                  key={preset.id}
                  type="button"
                  disabled={busy}
                  onClick={() => void quickCreatePreset(idx)}
                  className="flex flex-col justify-between gap-2 rounded-xl border border-border bg-card/70 p-3.5 text-left transition-colors hover:border-foreground/30 hover:bg-card"
                >
                  <div className="space-y-1">
                    <p className="text-sm font-semibold">{preset.name}</p>
                    <p className="text-xs leading-relaxed text-muted-foreground">{preset.tagline}</p>
                  </div>
                  <span className="text-xs font-medium text-primary">+ 一键套用此模板</span>
                </button>
              ))}
            </div>
            <div className="flex justify-end">
              <Button type="button" variant="outline" size="sm" onClick={onManage}>
                <Plus className="size-4" />
                从空白自由拼阶段
              </Button>
            </div>
          </div>
        ) : null}

        {/* Compose & launch a new run */}
        {!activeRun && activeWorkflow ? (
          <div
            className="wf-shell"
            data-state="idle"
            style={{ "--wf-accent": meta.accent, "--wf-accent-2": meta.accent2 } as CSSProperties}
          >
            <div className="overflow-hidden rounded-[calc(1rem-1px)] bg-card">
              <div className="space-y-3 border-b border-border/70 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span
                      className="rounded-full px-2 py-0.5 text-[11px] font-medium"
                      style={{
                        background: `color-mix(in srgb, ${meta.accent} 14%, transparent)`,
                        color: meta.accent,
                      }}
                    >
                      {meta.badge}
                    </span>
                    <h2 className="text-sm font-semibold">{activeWorkflow.name}</h2>
                  </div>
                  <Button type="button" variant="ghost" size="xs" onClick={onManage}>
                    编辑阶段与席位
                  </Button>
                </div>
                <div className="space-y-2">
                  <Textarea
                    value={requirement}
                    onChange={(e) => setRequirement(e.target.value)}
                    placeholder={`写下要交给「${activeWorkflow.name}」处理的需求或目标…（支持多行，启动后房间自动按阶段推进，不刷群聊）`}
                    className="min-h-24 resize-y text-sm"
                    onKeyDown={(e) => {
                      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                        e.preventDefault()
                        void startNew()
                      }
                    }}
                  />
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-muted-foreground">Ctrl + Enter 快速启动 · 阶段自动等齐推进</span>
                    <Button type="button" size="sm" disabled={busy || !requirement.trim()} onClick={() => void startNew()}>
                      {busy ? <Loader2 className="animate-spin" /> : <Play className="size-3.5" />}
                      启动工作流
                    </Button>
                  </div>
                </div>
              </div>

              {/* Live preview of template pipeline */}
              <StagePipelineCanvas
                accent={meta.accent}
                agents={agents}
                stages={workflowStages(activeWorkflow).map((st) => ({
                  id: st.id,
                  title: st.title,
                  gate: st.gate,
                  nodes: st.seats.map((name, i) => ({
                    id: `${st.id}-${i}`,
                    seatName: name,
                    status: "idle",
                    desc: st.instruction ? st.instruction.slice(0, 14) : "待命",
                  })),
                }))}
              />
            </div>
          </div>
        ) : null}

        {/* Active / historical WorkflowRun view */}
        {activeRun ? (
          <>
            <div
              className="wf-shell"
              data-state={shellState}
              style={{ "--wf-accent": meta.accent, "--wf-accent-2": meta.accent2 } as CSSProperties}
            >
              <div className="overflow-hidden rounded-[calc(1rem-1px)] bg-card">
                {/* Header */}
                <div className="space-y-1.5 border-b border-border/70 px-4 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <span
                        className="rounded-full px-2 py-0.5 text-[11px] font-medium"
                        style={{
                          background: `color-mix(in srgb, ${meta.accent} 14%, transparent)`,
                          color: meta.accent,
                        }}
                      >
                        {meta.badge}
                      </span>
                      <h2 className="truncate text-sm font-semibold">{activeRun.workflowName}</h2>
                      <span className={`text-xs font-medium ${RUN_STATUS_META[activeRun.status].tone}`}>
                        · {RUN_STATUS_META[activeRun.status].label}
                      </span>
                      <span className="text-xs text-muted-foreground">{clock(activeRun.createdAt)}</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      {activeRun.status === "running" || activeRun.status === "waiting_help" ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="xs"
                          disabled={busy}
                          onClick={() => void callRunApi({ action: "pause", runId: activeRun.id }, "工作流已暂停")}
                        >
                          <Pause className="size-3.5" />
                          暂停
                        </Button>
                      ) : activeRun.status === "paused" ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="xs"
                          disabled={busy}
                          onClick={() => void callRunApi({ action: "resume", runId: activeRun.id }, "工作流已恢复")}
                        >
                          <Play className="size-3.5" />
                          继续
                        </Button>
                      ) : null}
                      {activeRun.status !== "done" && activeRun.status !== "stopped" ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          disabled={busy}
                          className="text-rose-500 hover:text-rose-500"
                          onClick={() => void callRunApi({ action: "stop", runId: activeRun.id }, "工作流已终止")}
                        >
                          <Square className="size-3.5" />
                          终止
                        </Button>
                      ) : (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          disabled={busy}
                          title="删除这条运行记录"
                          onClick={async () => {
                            await callRunApi({ action: "delete", runId: activeRun.id }, "已删除记录")
                            setSelectedRunId("new")
                          }}
                        >
                          <Trash2 className="size-3.5 text-muted-foreground hover:text-rose-500" />
                        </Button>
                      )}
                    </div>
                  </div>
                  <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground/95">
                    {activeRun.requirement}
                  </p>
                </div>

                {/* Live multi-stage aurora trace canvas */}
                <StagePipelineCanvas
                  accent={meta.accent}
                  agents={agents}
                  selectedKey={inspected ? `${inspected.stageIndex}:${inspected.node.id}` : null}
                  onSelectNode={(stageIndex, nodeId) => setSelectedNodeKey(`${stageIndex}:${nodeId}`)}
                  stages={activeRun.stages.map((st) => ({
                    id: st.id,
                    title: st.title,
                    gate: st.gate,
                    gateStatus: st.gateStatus,
                    nodes: st.nodes.map((n) => ({
                      id: n.id,
                      seatName: n.seatName,
                      status: n.status,
                      desc: n.error
                        ? n.error.slice(0, 14)
                        : n.status === "done" && n.startedAt
                          ? `已完成 · ${formatDuration(n.startedAt, n.endedAt)}`
                          : NODE_STATUS_TEXT[n.status],
                    })),
                  }))}
                />

                {/* Human approval gate bar */}
                {activeRun.status === "waiting_gate" ? (
                  <div className="space-y-2.5 border-t border-amber-500/30 bg-amber-500/[0.07] px-4 py-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2 text-xs">
                        <ShieldAlert className="size-4 shrink-0 text-amber-500" />
                        <span className="font-medium text-foreground">
                          第 {activeRun.currentStage + 1} 阶段「{activeRun.stages[activeRun.currentStage]?.title}」已完成，等你拍板后继续
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <Button
                          type="button"
                          size="xs"
                          variant="outline"
                          disabled={busy}
                          onClick={() => setRejectOpen((v) => !v)}
                        >
                          打回重做
                        </Button>
                        <Button
                          type="button"
                          size="xs"
                          disabled={busy}
                          onClick={() =>
                            void callRunApi({ action: "approve", runId: activeRun.id }, "已通过，进入下一阶段")
                          }
                        >
                          <Check className="size-3.5" />
                          通过，继续下一阶段
                        </Button>
                      </div>
                    </div>
                    {rejectOpen ? (
                      <div className="flex gap-2">
                        <Input
                          value={rejectFeedback}
                          onChange={(e) => setRejectFeedback(e.target.value)}
                          placeholder="写一句修改意见，本阶段将带着你的意见重跑…"
                          className="h-8 text-xs"
                        />
                        <Button
                          type="button"
                          size="xs"
                          variant="destructive"
                          disabled={busy}
                          onClick={async () => {
                            const ok = await callRunApi(
                              { action: "reject", runId: activeRun.id, feedback: rejectFeedback },
                              "已打回并重跑本阶段",
                            )
                            if (ok) {
                              setRejectOpen(false)
                              setRejectFeedback("")
                            }
                          }}
                        >
                          确认打回
                        </Button>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>

            {/* Bottom inspector for the selected node */}
            {inspected ? (
              <NodeInspector
                run={activeRun}
                stageIndex={inspected.stageIndex}
                node={inspected.node}
                stageTitle={inspected.stage.title}
                agents={agents}
                realSeats={realSeats}
                seatNames={seatNames}
                busy={busy}
                retryNote={retryNote}
                onRetryNote={setRetryNote}
                replaceSeat={replaceSeat}
                onReplaceSeat={setReplaceSeat}
                onOpenRun={onOpenRun}
                onRetry={() =>
                  void callRunApi(
                    {
                      action: "retry",
                      runId: activeRun.id,
                      stageIndex: inspected.stageIndex,
                      nodeId: inspected.node.id,
                      note: retryNote.trim() || undefined,
                    },
                    `已单步重跑 ${inspected.node.seatName}`,
                  ).then((res) => {
                    if (res) setRetryNote("")
                  })
                }
                onReplace={(seatName) =>
                  void callRunApi(
                    {
                      action: "replace",
                      runId: activeRun.id,
                      stageIndex: inspected.stageIndex,
                      nodeId: inspected.node.id,
                      seatName,
                      note: retryNote.trim() || undefined,
                    },
                    `已改由 ${seatName} 顶替这一步`,
                  ).then((res) => {
                    if (res) {
                      setReplaceSeat("")
                      setRetryNote("")
                    }
                  })
                }
              />
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  )
}

function NodeInspector({
  run,
  stageIndex,
  node,
  stageTitle,
  agents,
  realSeats,
  seatNames,
  busy,
  retryNote,
  onRetryNote,
  replaceSeat,
  onReplaceSeat,
  onOpenRun,
  onRetry,
  onReplace,
}: {
  run: WorkflowRun
  stageIndex: number
  node: WorkflowRunNode
  stageTitle: string
  agents: PublicAgent[]
  realSeats: PublicAgent[]
  seatNames: string[]
  busy: boolean
  retryNote: string
  onRetryNote: (v: string) => void
  replaceSeat: string
  onReplaceSeat: (v: string) => void
  onOpenRun: (runId: string) => void
  onRetry: () => void
  onReplace: (seatName: string) => void
}) {
  const seat = agents.find((a) => a.name === node.seatName)
  const color = seat ? seatLook(seat).color : "#94a3b8"
  const others = realSeats.filter((s) => s.name !== node.seatName)
  const canRecover = run.status !== "stopped" && node.status !== "running"

  return (
    <div className="frost space-y-3 rounded-2xl p-4">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/70 pb-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="size-2.5 rounded-full" style={{ background: color }} />
          <span className="text-sm font-semibold">{node.seatName}</span>
          <span className="text-xs text-muted-foreground">
            第 {stageIndex + 1} 阶段 · {stageTitle}
          </span>
          <span className="rounded-full bg-foreground/[0.06] px-2 py-0.5 text-[11px] text-muted-foreground">
            {NODE_STATUS_TEXT[node.status]}
            {node.attempt > 1 ? ` · 第 ${node.attempt} 次` : ""}
          </span>
          {node.startedAt ? (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <Clock className="size-3" />
              {formatDuration(node.startedAt, node.endedAt)}
            </span>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {node.runId ? (
            <Button type="button" variant="outline" size="xs" onClick={() => onOpenRun(node.runId!)}>
              <ListTree className="size-3.5" />
              查看执行过程
            </Button>
          ) : null}
          {canRecover ? (
            <Button type="button" variant="outline" size="xs" disabled={busy} onClick={onRetry}>
              <RotateCcw className="size-3.5" />
              单步重跑
            </Button>
          ) : null}
        </div>
      </div>

      {/* Recovery controls: optional hint + swap seat */}
      {canRecover ? (
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={retryNote}
            onChange={(e) => onRetryNote(e.target.value)}
            placeholder="重跑或换人时可附一句补充要求（选填）"
            className="h-8 min-w-[14rem] flex-1 text-xs"
          />
          {others.length > 0 ? (
            <div className="flex items-center gap-1.5">
              <select
                aria-label="选择顶替席位"
                value={replaceSeat}
                onChange={(e) => onReplaceSeat(e.target.value)}
                className="h-8 rounded-md border border-border bg-background/80 px-2 text-xs outline-none"
              >
                <option value="">换个 AI 顶替…</option>
                {others.map((s) => (
                  <option key={s.id} value={s.name}>
                    {s.name}
                    {s.model ? `（${s.model}）` : ""}
                  </option>
                ))}
              </select>
              <Button
                type="button"
                size="xs"
                variant="secondary"
                disabled={busy || !replaceSeat}
                onClick={() => replaceSeat && onReplace(replaceSeat)}
              >
                <ArrowRightLeft className="size-3.5" />
                顶替并跑
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Error / output body */}
      {node.error ? (
        <div className="rounded-xl border border-rose-500/35 bg-rose-500/10 px-3.5 py-2.5 text-xs leading-relaxed text-rose-500 dark:text-rose-300">
          执行失败：{node.error}
        </div>
      ) : null}

      {node.status === "waiting_help" ? (
        <div className="rounded-xl border border-amber-500/35 bg-amber-500/10 px-3.5 py-2.5 text-xs leading-relaxed text-amber-600 dark:text-amber-300">
          {node.seatName} 在执行中途提出了问题或申请了权限，请在右侧「等你定」回答或批准，完成后它会自动继续。
        </div>
      ) : null}

      {node.output ? (
        <div className="max-h-[42vh] overflow-y-auto rounded-xl border border-border/60 bg-background/55 px-4 py-3 text-sm leading-relaxed">
          <Markdown text={node.output} names={seatNames} from={node.seatId} />
        </div>
      ) : (
        <p className="py-4 text-center text-xs text-muted-foreground">
          {node.status === "running"
            ? `${node.seatName} 正在执行本阶段，可点右上角「查看执行过程」实时看进度…`
            : "该节点尚无产出"}
        </p>
      )}
    </div>
  )
}
