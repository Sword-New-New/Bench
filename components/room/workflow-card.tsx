"use client"

import { useState, type CSSProperties } from "react"
import { ChevronDown, ChevronUp } from "lucide-react"

import { seatLook } from "@/components/room/bits"
import { draft } from "@/components/room/draft"
import { goto } from "@/components/room/refs"
import type { Message, PublicAgent, Workflow, WorkflowKind } from "@/lib/types"
import { workflowStages } from "@/lib/workflow-shared"

type NodeState = "idle" | "running" | "done" | "error"
type TraceState = "idle" | "active" | "done" | "broken"

export const WORKFLOW_META: Record<
  WorkflowKind,
  { badge: string; accent: string; accent2: string }
> = {
  orchestrate: { badge: "主控派活", accent: "#38bdf8", accent2: "#a78bfa" },
  plan: { badge: "混合计划 · 只规划", accent: "#f59e0b", accent2: "#38bdf8" },
  explore: { badge: "多 AI 探索", accent: "#a78bfa", accent2: "#38bdf8" },
  custom: { badge: "自定义流水线", accent: "#2dd4bf", accent2: "#38bdf8" },
}

type ParsedWorkflow = {
  kind: WorkflowKind
  name: string
  command?: string
  requirement: string
  lead?: string
  workers: string[]
  summarizer?: string
  planners: string[]
  explorers: string[]
}

function parseWorkflowMessage(message: Message): ParsedWorkflow {
  const wf = message.workflow!
  const text = message.text
  const nameFromText = text.match(/【工作流：([^】]+)】/)?.[1]?.trim()
  const reqMatch = text.match(/\n\n(?:用户需求|探索主题)：\n([\s\S]+)$/)
  const requirement = wf.requirement ?? reqMatch?.[1]?.trim() ?? text

  let lead = wf.lead
  let workers = wf.workers ?? []
  let summarizer = wf.summarizer
  let planners = wf.planners ?? []
  let explorers = wf.explorers ?? []

  if (wf.kind === "orchestrate" && (!lead || workers.length === 0 || !summarizer)) {
    const line = text.match(/主控：([^；\n]+)；执行：([^；\n]+)；汇总：([^。\n]+)/)
    if (line) {
      lead = lead || line[1].trim()
      if (workers.length === 0) workers = line[2].split("、").map((s) => s.trim()).filter(Boolean)
      summarizer = summarizer || line[3].trim()
    }
  } else if (wf.kind === "plan" && planners.length === 0) {
    const firstLine = text.split("\n")[0] ?? ""
    planners = [...firstLine.matchAll(/@([\p{L}\p{N}_-]+)/gu)].map((m) => m[1])
  } else if (wf.kind === "explore" && explorers.length === 0) {
    const firstLine = text.split("\n")[0] ?? ""
    explorers = [...firstLine.matchAll(/@([\p{L}\p{N}_-]+)/gu)].map((m) => m[1])
  }

  return {
    kind: wf.kind,
    name: wf.name || nameFromText || WORKFLOW_META[wf.kind].badge,
    command: wf.command,
    requirement,
    lead,
    workers,
    summarizer,
    planners,
    explorers,
  }
}

// 45° rounded-corner PCB-inspired aurora trace between (x1, y1) and (x2, y2).
function tracePath(x1: number, y1: number, x2: number, y2: number): string {
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

type LayoutNode = { id: string; role: string; x: number; y: number; w: number; h: number }
type LayoutTrace = { id: string; from: string; to: string; d: string; pts: [number, number, number, number] }

function buildLayout(parsed: ParsedWorkflow): { height: number; nodes: LayoutNode[]; traces: LayoutTrace[] } {
  const nodes: LayoutNode[] = []
  const traces: LayoutTrace[] = []

  if (parsed.kind === "orchestrate" && parsed.lead && parsed.summarizer) {
    const workers = parsed.workers.length ? parsed.workers : []
    const rowH = workers.length >= 4 ? 46 : 56
    const gap = workers.length >= 4 ? 8 : 12
    const padY = 14
    const contentH = Math.max(1, workers.length) * rowH + Math.max(0, workers.length - 1) * gap
    const height = Math.max(148, contentH + padY * 2)
    const sideH = 66
    const sideY = Math.round((height - sideH) / 2)

    nodes.push({ id: parsed.lead, role: "主控", x: 16, y: sideY, w: 148, h: sideH })
    const startY = Math.round((height - contentH) / 2)
    workers.forEach((name, idx) => {
      const y = startY + idx * (rowH + gap)
      const cy = Math.round(y + rowH / 2)
      nodes.push({ id: name, role: "执行", x: 254, y, w: 162, h: rowH })
      const leftPinY =
        workers.length === 1
          ? sideY + Math.round(sideH / 2)
          : Math.round(sideY + 18 + (idx / (workers.length - 1)) * (sideH - 36))
      traces.push({
        id: `l-${idx}`,
        from: parsed.lead!,
        to: name,
        d: tracePath(164, leftPinY, 254, cy),
        pts: [164, leftPinY, 254, cy],
      })
      traces.push({
        id: `r-${idx}`,
        from: name,
        to: parsed.summarizer!,
        d: tracePath(416, cy, 514, leftPinY),
        pts: [416, cy, 514, leftPinY],
      })
    })
    nodes.push({ id: parsed.summarizer, role: "汇总", x: 514, y: sideY, w: 150, h: sideH })
    return { height, nodes, traces }
  }

  const list = parsed.kind === "plan" ? parsed.planners : parsed.explorers
  const lead = list[0]
  const others = list.slice(1)
  if (!lead) return { height: 96, nodes, traces }

  const rowH = others.length >= 4 ? 44 : 54
  const gap = others.length >= 4 ? 8 : 10
  const padY = 14
  const contentH = Math.max(1, others.length) * rowH + Math.max(0, others.length - 1) * gap
  const height = Math.max(138, contentH + padY * 2)
  const leadH = 66
  const leadY = Math.round((height - leadH) / 2)
  const startY = Math.round((height - contentH) / 2)

  others.forEach((name, idx) => {
    const y = startY + idx * (rowH + gap)
    const cy = Math.round(y + rowH / 2)
    nodes.push({
      id: name,
      role: parsed.kind === "plan" ? "拆解" : "探索",
      x: 34,
      y,
      w: 184,
      h: rowH,
    })
    const pinY =
      others.length === 1
        ? leadY + Math.round(leadH / 2)
        : Math.round(leadY + 18 + (idx / (others.length - 1)) * (leadH - 36))
    traces.push({
      id: `m-${idx}`,
      from: name,
      to: lead,
      d: tracePath(218, cy, 444, pinY),
      pts: [218, cy, 444, pinY],
    })
  })
  nodes.push({
    id: lead,
    role: parsed.kind === "plan" ? "统稿" : "汇总",
    x: 444,
    y: leadY,
    w: 196,
    h: leadH,
  })
  return { height, nodes, traces }
}

export function WorkflowCard({
  message,
  messages,
  agents,
}: {
  message: Message
  messages: Message[]
  agents: PublicAgent[]
}) {
  const [showPrompt, setShowPrompt] = useState(false)
  const parsed = parseWorkflowMessage(message)
  const meta = WORKFLOW_META[parsed.kind]
  const layout = buildLayout(parsed)

  // Slice messages belonging to this workflow round (up to the next workflow launch, if any).
  const after = messages.filter((m) => m.seq > message.seq)
  const nextWfIdx = after.findIndex((m) => Boolean(m.workflow))
  const roundMsgs = nextWfIdx >= 0 ? after.slice(0, nextWfIdx) : after
  const isLatestRound = nextWfIdx < 0

  const agentByName = new Map(agents.map((a) => [a.name, a]))
  const replyByName = new Map<string, Message>()
  const failByName = new Map<string, string>()

  // Collect calls/errors from the launch message and subsequent messages in this round.
  for (const m of [message, ...roundMsgs]) {
    if (m.authorId !== "human" && m.kind === "chat") {
      replyByName.set(m.authorName, m)
    }
    for (const call of m.calls ?? []) {
      if (call.state === "failed") {
        failByName.set(call.name, call.note || "叫醒失败")
      } else if (call.state === "answered") {
        failByName.delete(call.name)
      }
    }
  }

  const nodeStates = new Map<string, { state: NodeState; desc: string; replyId?: string }>()
  for (const node of layout.nodes) {
    const seat = agentByName.get(node.id)
    const reply = replyByName.get(node.id)
    const fail = failByName.get(node.id)
    const running = isLatestRound && Boolean(seat && (seat.status === "working" || seat.runId))

    if (running) {
      nodeStates.set(node.id, {
        state: "running",
        desc: seat?.doing ? seat.doing.slice(0, 14) : "正在处理…",
        replyId: reply?.id,
      })
    } else if (fail && !reply) {
      nodeStates.set(node.id, { state: "error", desc: fail.slice(0, 14) })
    } else if (reply) {
      const doneText =
        node.role === "主控"
          ? "已派活"
          : node.role === "汇总" || node.role === "统稿"
            ? "已汇总"
            : "已回复"
      nodeStates.set(node.id, { state: "done", desc: doneText, replyId: reply.id })
    } else {
      nodeStates.set(node.id, {
        state: "idle",
        desc: seat ? (node.role === "汇总" || node.role === "统稿" ? "待汇总" : "待命") : "未入座",
      })
    }
  }

  // Trace semantics:
  // - done: source replied and target is already running or done (delivered)
  // - active: source replied and target is currently running (handing off / aggregating)
  // - broken: target failed
  // - idle: not yet reached
  const traceStates = new Map<string, TraceState>()
  for (const tr of layout.traces) {
    const fromSt = nodeStates.get(tr.from)?.state ?? "idle"
    const toSt = nodeStates.get(tr.to)?.state ?? "idle"
    const isIntoSink =
      (parsed.kind === "orchestrate" && tr.to === parsed.summarizer) ||
      (parsed.kind !== "orchestrate" && tr.to === (parsed.planners[0] ?? parsed.explorers[0]))

    if (toSt === "error") {
      traceStates.set(tr.id, "broken")
    } else if (fromSt === "done" && toSt === "done") {
      traceStates.set(tr.id, "done")
    } else if (fromSt === "done" && toSt === "running") {
      // Orchestrate dispatch to workers: already delivered -> solid green;
      // Workers/peers handing off into summarizer/lead: flowing aurora beam!
      traceStates.set(tr.id, isIntoSink ? "active" : "done")
    } else {
      traceStates.set(tr.id, "idle")
    }
  }

  const allStates = [...nodeStates.values()].map((v) => v.state)
  const hasError = allStates.includes("error")
  const hasRunning = allStates.includes("running") || [...traceStates.values()].includes("active")
  const allDone = layout.nodes.length > 0 && allStates.every((s) => s === "done")
  const shellState = hasError ? "error" : hasRunning ? "active" : allDone ? "done" : "idle"

  // Contextual nudge when something stalled or errored (only on the latest round).
  let nudge: { label: string; text: string } | null = null
  if (isLatestRound && !hasRunning && !allDone) {
    const failedEntry = [...nodeStates.entries()].find(([, v]) => v.state === "error")
    if (failedEntry) {
      const [name] = failedEntry
      nudge = { label: `重试 @${name}`, text: `@${name} 请接着处理刚才的工作流任务` }
    } else if (parsed.kind === "orchestrate" && parsed.lead && parsed.summarizer) {
      const workersDone = parsed.workers.length > 0 && parsed.workers.every((w) => nodeStates.get(w)?.state === "done")
      const sumIdle = nodeStates.get(parsed.summarizer)?.state === "idle"
      if (workersDone && sumIdle) {
        nudge = {
          label: `叫醒 @${parsed.lead} 复核`,
          text: `@${parsed.lead} ${parsed.workers.join("、")} 已完成，请复核并交给 @${parsed.summarizer} 汇总`,
        }
      }
    } else {
      const head = parsed.planners[0] ?? parsed.explorers[0]
      const peers = (parsed.kind === "plan" ? parsed.planners : parsed.explorers).slice(1)
      if (head && peers.length > 0 && peers.every((p) => nodeStates.get(p)?.state === "done") && nodeStates.get(head)?.state === "idle") {
        nudge = {
          label: `提醒 @${head} 汇总`,
          text: `@${head} 请整合各位的意见输出最终结论`,
        }
      }
    }
  }

  const hint = allDone
    ? "全部环节已完成，点击席位卡片可跳到对应回复"
    : hasError
      ? "有席位叫醒失败，换模型或重试后可点右侧继续推进"
      : hasRunning
        ? "工作流进行中，点击已回复席位可跳到对应发言"
        : nudge
          ? "上游已回复但未触发下一环，可点右侧推一把"
          : "已发起工作流"

  const shellStyle = {
    "--wf-accent": meta.accent,
    "--wf-accent-2": meta.accent2,
  } as CSSProperties

  return (
    <div className="wf-shell mt-1.5" data-state={shellState} style={shellStyle}>
      <div className="overflow-hidden rounded-[calc(1rem-1px)] bg-card">
        {/* Header: badge + name + command + toggle raw prompt */}
        <div className="space-y-1.5 border-b border-border/70 px-3.5 py-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <span
                className="inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-medium"
                style={{ background: `color-mix(in srgb, ${meta.accent} 14%, transparent)`, color: meta.accent }}
              >
                {meta.badge}
              </span>
              <span className="truncate text-sm font-semibold text-foreground">{parsed.name}</span>
              {parsed.command ? (
                <span className="font-mono text-xs text-muted-foreground">/{parsed.command}</span>
              ) : null}
            </div>
            <button
              type="button"
              className="inline-flex items-center gap-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
              onClick={() => setShowPrompt((v) => !v)}
            >
              {showPrompt ? "收起指令" : "查看指令"}
              {showPrompt ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
            </button>
          </div>
          <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground/95">
            {parsed.requirement}
          </p>
        </div>

        {showPrompt ? (
          <div className="border-b border-border/60 bg-background/45 px-3.5 py-2">
            <p className="whitespace-pre-wrap break-words text-xs leading-relaxed text-muted-foreground">
              {message.text}
            </p>
          </div>
        ) : null}

        {/* Rounded 45° aurora trace canvas */}
        {layout.nodes.length > 0 ? (
          <div
            className="relative w-full overflow-x-auto"
            style={{
              background: `radial-gradient(ellipse 65% 85% at 50% 0%, color-mix(in srgb, ${meta.accent} 8%, transparent), transparent 75%)`,
            }}
          >
            <div className="relative min-w-[540px]" style={{ height: `${layout.height}px` }}>
              <svg
                viewBox={`0 0 680 ${layout.height}`}
                preserveAspectRatio="none"
                className="pointer-events-none absolute inset-0 h-full w-full"
              >
                {layout.traces.map((tr) => {
                  const st = traceStates.get(tr.id) ?? "idle"
                  const [x1, y1, x2, y2] = tr.pts
                  const baseStroke =
                    st === "done"
                      ? "color-mix(in srgb, #34d399 55%, transparent)"
                      : st === "broken"
                        ? "color-mix(in srgb, #fb7185 55%, transparent)"
                        : st === "active"
                          ? `color-mix(in srgb, ${meta.accent} 28%, transparent)`
                          : "color-mix(in srgb, var(--foreground) 14%, transparent)"
                  const dotColor =
                    st === "done"
                      ? "#34d399"
                      : st === "broken"
                        ? "#fb7185"
                        : st === "active"
                          ? meta.accent
                          : "color-mix(in srgb, var(--foreground) 25%, transparent)"
                  return (
                    <g key={tr.id}>
                      <path
                        d={tr.d}
                        fill="none"
                        stroke={baseStroke}
                        strokeWidth={st === "idle" ? 1.5 : 2}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeDasharray={st === "broken" ? "4 5" : undefined}
                      />
                      {st === "active" ? (
                        <path
                          d={tr.d}
                          fill="none"
                          stroke={meta.accent}
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

              {layout.nodes.map((node) => {
                const seat = agentByName.get(node.id)
                const color = seat ? seatLook(seat).color : "#94a3b8"
                const info = nodeStates.get(node.id) ?? { state: "idle" as NodeState, desc: "待命" }
                const descColor =
                  info.state === "running"
                    ? color
                    : info.state === "done"
                      ? "#34d399"
                      : info.state === "error"
                        ? "#fb7185"
                        : undefined
                const nodeStyle = {
                  left: `${(node.x / 680) * 100}%`,
                  top: `${node.y}px`,
                  width: `${(node.w / 680) * 100}%`,
                  height: `${node.h}px`,
                  "--wf-seat": color,
                } as CSSProperties

                return (
                  <button
                    key={node.id}
                    type="button"
                    data-state={info.state}
                    style={nodeStyle}
                    title={info.replyId ? `点击定位到 ${node.id} 的回复` : `${node.id} · ${info.desc}`}
                    className="wf-node absolute text-left"
                    onClick={() => {
                      if (info.replyId) goto("message", info.replyId)
                    }}
                  >
                    <div className="flex h-full w-full flex-col justify-between rounded-[calc(0.75rem-1px)] bg-background/85 px-2.5 py-1.5 backdrop-blur-xs">
                      <div className="flex w-full items-center justify-between gap-1.5">
                        <div className="flex min-w-0 items-center gap-1.5">
                          <span
                            className={`size-2 shrink-0 rounded-full ${info.state === "running" ? "wf-breathe" : ""}`}
                            style={{ background: color }}
                          />
                          <span className="truncate text-xs font-semibold text-foreground">{node.id}</span>
                        </div>
                        <span className="shrink-0 text-[11px] text-muted-foreground">{node.role}</span>
                      </div>
                      <span
                        className="truncate text-[11px] font-medium text-muted-foreground"
                        style={descColor ? { color: descColor } : undefined}
                      >
                        {info.state === "done" ? "✓ " : info.state === "error" ? "! " : ""}
                        {info.desc}
                      </span>
                    </div>
                  </button>
                )
              })}
            </div>
          </div>
        ) : null}

        {/* Footer status + optional nudge */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/70 bg-background/20 px-3.5 py-2 text-xs">
          <span className="text-muted-foreground">{hint}</span>
          {nudge ? (
            <button
              type="button"
              className="rounded-full px-2.5 py-0.5 font-medium transition-opacity hover:opacity-90"
              style={{
                background: `color-mix(in srgb, ${meta.accent} 16%, transparent)`,
                color: meta.accent,
              }}
              onClick={() => draft.set(nudge.text)}
            >
              {nudge.label}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  )
}

// Compact role-chip flow shared by composer active bar and workflows-dialog cards.
export function WorkflowChips({
  workflow,
  agents,
}: {
  workflow: Workflow
  agents: PublicAgent[]
}) {
  const byName = new Map(agents.map((a) => [a.name, a]))
  const pill = (name: string) => {
    const seat = byName.get(name)
    const color = seat ? seatLook(seat).color : "#94a3b8"
    const missing = !seat || seat.demo
    return (
      <span
        key={name}
        title={missing ? `${name} 尚未入座` : seat.model ? `${name}（${seat.model}）` : name}
        className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] ${
          missing
            ? "border-amber-500/45 bg-amber-500/10 text-amber-600 dark:text-amber-400"
            : "border-border bg-background/70 text-foreground"
        }`}
      >
        <span className="size-1.5 shrink-0 rounded-full" style={{ background: color }} />
        <span className="font-medium">{name}</span>
        {missing ? <span className="text-[10px]">未入座</span> : null}
      </span>
    )
  }

  const stages = workflowStages(workflow)
  if (stages.length > 0) {
    return (
      <div className="flex flex-wrap items-center gap-1 text-xs">
        {stages.map((st, idx) => (
          <span key={st.id || idx} className="inline-flex flex-wrap items-center gap-1">
            {idx > 0 ? <span className="px-0.5 text-muted-foreground/70">→</span> : null}
            <span className="text-[11px] text-muted-foreground">{st.title}</span>
            {st.seats.map(pill)}
            {st.gate ? (
              <span className="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-300" title="此阶段完成后停下等你拍板">
                ⏸
              </span>
            ) : null}
          </span>
        ))}
      </div>
    )
  }

  if (workflow.kind === "orchestrate") {
    return (
      <div className="flex flex-wrap items-center gap-1 text-xs">
        <span className="text-[11px] text-muted-foreground">主控</span>
        {workflow.lead ? pill(workflow.lead) : null}
        <span className="px-0.5 text-muted-foreground/70">→</span>
        <span className="text-[11px] text-muted-foreground">执行</span>
        {(workflow.workers ?? []).map(pill)}
        <span className="px-0.5 text-muted-foreground/70">→</span>
        <span className="text-[11px] text-muted-foreground">汇总</span>
        {workflow.summarizer ? pill(workflow.summarizer) : null}
      </div>
    )
  }

  const list = workflow.kind === "plan" ? (workflow.planners ?? []) : (workflow.explorers ?? [])
  const leadLabel = workflow.kind === "plan" ? "统稿" : "汇总"
  const peerLabel = workflow.kind === "plan" ? "拆解" : "探索"
  return (
    <div className="flex flex-wrap items-center gap-1 text-xs">
      {list.slice(1).length > 0 ? (
        <>
          <span className="text-[11px] text-muted-foreground">{peerLabel}</span>
          {list.slice(1).map(pill)}
          <span className="px-0.5 text-muted-foreground/70">→</span>
        </>
      ) : null}
      <span className="text-[11px] text-muted-foreground">{leadLabel}</span>
      {list[0] ? pill(list[0]) : null}
    </div>
  )
}
