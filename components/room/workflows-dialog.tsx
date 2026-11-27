"use client"

import { useId, useState } from "react"
import { ArrowDown, ArrowUp, Check, Pencil, Plus, Sparkles, Trash2, X } from "lucide-react"
import { toast } from "sonner"

import { AdvancedSection } from "@/components/room/advanced"
import { api } from "@/components/room/api"
import { WORKFLOW_META, WorkflowChips } from "@/components/room/workflow-card"
import { StagePipelineCanvas } from "@/components/room/workflow-workspace"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import type { PublicAgent, Workflow, WorkflowKind, WorkflowStage } from "@/lib/types"
import { WORKFLOW_PRESETS, workflowStages } from "@/lib/workflow-shared"

const MAX_SEATS = 8
const MAX_STAGES = 6

function splitNames(value: string) {
  return value.split(/[、,，\s]+/).map((s) => s.trim()).filter(Boolean)
}

export function workflowLine(item: Workflow) {
  const stages = workflowStages(item)
  if (stages.length > 0) {
    return stages.map((s) => `${s.title}(${s.seats.join("、")})${s.gate ? " ⏸" : ""}`).join(" → ")
  }
  if (item.kind === "plan") return `${item.planners?.join(" + ")} · 只做计划`
  if (item.kind === "explore") return `${item.explorers?.join(" + ")} · 联合探索`
  return `${item.lead} 主控 → ${item.workers?.join("、")} 执行 → ${item.summarizer} 汇总`
}

export function WorkflowsDialog({
  open,
  onOpenChange,
  workflows,
  agents,
  onChanged,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  workflows: Workflow[]
  agents: PublicAgent[]
  onChanged: () => void
}) {
  const [editing, setEditing] = useState<Workflow | "new" | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function remove(id: string) {
    setBusy(true)
    try {
      await api("/api/v1/workflows", { method: "POST", body: JSON.stringify({ as: "human", action: "delete", id }) })
      setDeleting(null)
      onChanged()
      toast.success("工作流已删除")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "删除失败")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next)
        if (!next) {
          setEditing(null)
          setDeleting(null)
        }
      }}
    >
      <DialogContent className="max-h-[86dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{editing ? (editing === "new" ? "新建工作流模板" : "编辑工作流模板") : "管理工作流模板"}</DialogTitle>
          <DialogDescription>
            用预设模板或自由增删阶段，编排多 AI 协作流水线（支持并行执行与人工拍板卡点）。仅用于当前项目。
          </DialogDescription>
        </DialogHeader>
        {editing ? (
          <WorkflowBuilderForm
            key={editing === "new" ? "new" : editing.id}
            workflow={editing === "new" ? undefined : editing}
            agents={agents}
            onCancel={() => setEditing(null)}
            onSaved={() => {
              setEditing(null)
              onChanged()
            }}
          />
        ) : (
          <div className="space-y-3">
            {workflows.length === 0 ? (
              <p className="py-4 text-sm text-muted-foreground">还没有工作流模板。点下方新建，可一键套用预设或自由拼阶段。</p>
            ) : null}
            {workflows.map((item) => {
              const meta = WORKFLOW_META[item.kind]
              return (
                <div
                  key={item.id}
                  className="rounded-xl border border-border bg-card/70 p-3"
                  style={{ borderLeft: `3px solid ${meta.accent}` }}
                >
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1 space-y-1.5">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="break-words text-sm font-semibold">{item.name}</span>
                        <span
                          className="rounded-full px-2 py-0.5 text-[11px] font-medium"
                          style={{ background: `color-mix(in srgb, ${meta.accent} 14%, transparent)`, color: meta.accent }}
                        >
                          {meta.badge}
                        </span>
                        {item.command ? <span className="font-mono text-xs text-muted-foreground">/{item.command}</span> : null}
                      </div>
                      <WorkflowChips workflow={item} agents={agents} />
                    </div>
                    <Button variant="ghost" size="icon" aria-label={`编辑${item.name}`} onClick={() => setEditing(item)}>
                      <Pencil />
                    </Button>
                    <Button variant="ghost" size="icon" aria-label={`删除${item.name}`} onClick={() => setDeleting(item.id)}>
                      <Trash2 />
                    </Button>
                  </div>
                  {deleting === item.id ? (
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                      <span>删除后不会自动恢复。</span>
                      <Button size="sm" variant="destructive" disabled={busy} onClick={() => void remove(item.id)}>
                        确认删除
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setDeleting(null)}>
                        取消
                      </Button>
                    </div>
                  ) : null}
                </div>
              )
            })}
            <Button variant="outline" onClick={() => setEditing("new")}>
              <Plus />
              新建工作流模板
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

type DraftStage = WorkflowStage & { draftSeat: string }

function makeStage(index: number, init?: Partial<WorkflowStage>): DraftStage {
  return {
    id: init?.id || `st_${Date.now()}_${index}_${Math.random().toString(36).slice(2, 6)}`,
    title: init?.title ?? `阶段 ${index + 1}`,
    seats: init?.seats ? [...init.seats] : [],
    instruction: init?.instruction ?? "",
    gate: init?.gate === true,
    draftSeat: "",
  }
}

function WorkflowBuilderForm({
  workflow,
  agents,
  onCancel,
  onSaved,
}: {
  workflow?: Workflow
  agents: PublicAgent[]
  onCancel: () => void
  onSaved: () => void
}) {
  const prefix = useId()
  const realSeats = agents.filter((a) => !a.demo)
  const initialStages = workflow
    ? workflowStages(workflow).map((st, idx) => makeStage(idx, st))
    : [
        makeStage(0, {
          title: "方案规划",
          seats: realSeats[0] ? [realSeats[0].name] : [],
          instruction: "只做方案设计，不改代码。输出清晰的分步实施计划与关键风险。",
          gate: true,
        }),
        makeStage(1, {
          title: "并行实施",
          seats: realSeats.length >= 3 ? [realSeats[1].name, realSeats[2].name] : realSeats[1] ? [realSeats[1].name] : [],
          instruction: "严格按上一阶段拍板的方案完成开发与验证，汇报改动结果。",
        }),
        makeStage(2, {
          title: "复核汇总",
          seats: realSeats[0] ? [realSeats[0].name] : [],
          instruction: "复核前面各阶段的成果，整理最终交付总结与验收方式。",
        }),
      ]

  const [name, setName] = useState(workflow?.name ?? "")
  const [kind, setKind] = useState<WorkflowKind>(workflow?.kind ?? "custom")
  const [command, setCommand] = useState(workflow?.command ?? "")
  const [stages, setStages] = useState<DraftStage[]>(initialStages)
  const [note, setNote] = useState(workflow?.note ?? "")
  const [advanced, setAdvanced] = useState(false)
  const [busy, setBusy] = useState(false)

  const updateStage = (idx: number, patch: Partial<DraftStage>) => {
    setStages((list) => list.map((item, i) => (i === idx ? { ...item, ...patch } : item)))
  }

  const moveStage = (idx: number, delta: number) => {
    const target = idx + delta
    if (target < 0 || target >= stages.length) return
    setStages((list) => {
      const next = [...list]
      ;[next[idx], next[target]] = [next[target], next[idx]]
      return next
    })
  }

  const removeStage = (idx: number) => {
    if (stages.length <= 1) return
    setStages((list) => list.filter((_, i) => i !== idx))
  }

  const toggleSeat = (idx: number, seatName: string) => {
    const st = stages[idx]
    if (!st) return
    if (st.seats.includes(seatName)) {
      updateStage(idx, { seats: st.seats.filter((s) => s !== seatName) })
    } else if (st.seats.length >= MAX_SEATS) {
      toast.error(`单个阶段最多选择 ${MAX_SEATS} 位席位`)
    } else {
      updateStage(idx, { seats: [...st.seats, seatName] })
    }
  }

  const commitDraftSeat = (idx: number) => {
    const st = stages[idx]
    if (!st || !st.draftSeat.trim()) return
    const next = [...st.seats]
    for (const s of splitNames(st.draftSeat)) {
      if (!next.includes(s) && next.length < MAX_SEATS) next.push(s)
    }
    updateStage(idx, { seats: next, draftSeat: "" })
  }

  const applyPreset = (presetIndex: number) => {
    const preset = WORKFLOW_PRESETS[presetIndex]
    if (!preset) return
    if (!name.trim()) setName(preset.name)
    setKind(preset.kind)
    setStages(
      preset.stages.map((st, idx) => {
        const autoSeats =
          realSeats.length === 0
            ? []
            : idx === 1 && realSeats.length >= 3 && preset.stages.length >= 3
              ? [realSeats[1].name, realSeats[2].name]
              : [realSeats[idx % realSeats.length].name]
        return makeStage(idx, { ...st, seats: autoSeats })
      }),
    )
    toast.success(`已套用预设「${preset.name}」`)
  }

  async function save(event: React.FormEvent) {
    event.preventDefault()
    const finalStages: WorkflowStage[] = stages.map((st) => {
      const extra = splitNames(st.draftSeat)
      const merged = [...st.seats]
      for (const s of extra) {
        if (!merged.includes(s) && merged.length < MAX_SEATS) merged.push(s)
      }
      return {
        id: st.id,
        title: st.title.trim(),
        seats: merged,
        instruction: st.instruction.trim(),
        ...(st.gate ? { gate: true } : {}),
      }
    })
    setBusy(true)
    try {
      await api("/api/v1/workflows", {
        method: "POST",
        body: JSON.stringify({
          as: "human",
          action: "save",
          workflow: {
            id: workflow?.id,
            name,
            kind,
            command,
            stages: finalStages,
            note,
          },
        }),
      })
      toast.success("工作流模板已保存")
      onSaved()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "保存失败")
    } finally {
      setBusy(false)
    }
  }

  const meta = WORKFLOW_META[kind]

  return (
    <form className="space-y-4" onSubmit={(event) => void save(event)}>
      {/* One-click preset templates */}
      <div className="space-y-1.5">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Sparkles className="size-3.5 text-primary" />
          <span>快速套用预设模板（之后可自由增删阶段）：</span>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {WORKFLOW_PRESETS.map((preset, idx) => (
            <button
              key={preset.id}
              type="button"
              onClick={() => applyPreset(idx)}
              className="chip rounded-full border border-border bg-background/70 px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
            >
              {preset.name}
            </button>
          ))}
        </div>
      </div>

      {/* Live pipeline preview */}
      <div className="overflow-hidden rounded-xl border border-border/80 bg-card/60">
        <StagePipelineCanvas
          compact
          accent={meta.accent}
          agents={agents}
          stages={stages.map((st, idx) => ({
            id: st.id,
            title: st.title.trim() || `阶段 ${idx + 1}`,
            gate: st.gate,
            nodes:
              st.seats.length > 0
                ? st.seats.map((s, ni) => ({
                    id: `${st.id}-${ni}`,
                    seatName: s,
                    status: "idle",
                    desc: st.instruction ? st.instruction.slice(0, 12) : "待命",
                  }))
                : [{ id: `${st.id}-empty`, seatName: "未选席位", status: "idle", desc: "请下方点选" }],
          }))}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={`${prefix}-name`}>工作流名称</Label>
        <Input
          id={`${prefix}-name`}
          required
          maxLength={80}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="例如：规划-拍板-并行开发"
        />
      </div>

      {/* Modular stage builder cards */}
      <div className="space-y-2.5">
        <div className="flex items-center justify-between">
          <Label>流水线阶段（按顺序执行，每阶段内多位 AI 自动并行并等齐）</Label>
          <span className="text-xs text-muted-foreground">
            {stages.length} / {MAX_STAGES} 阶段
          </span>
        </div>

        {stages.map((st, idx) => (
          <div key={st.id} className="space-y-2.5 rounded-xl border border-border bg-muted/20 p-3">
            <div className="flex items-center gap-2">
              <span className="grid size-5 shrink-0 place-items-center rounded-full bg-primary/15 text-[11px] font-semibold text-primary">
                {idx + 1}
              </span>
              <Input
                value={st.title}
                maxLength={40}
                onChange={(e) => updateStage(idx, { title: e.target.value })}
                placeholder="阶段名称，如：方案规划 / 并行开发"
                className="h-8 flex-1 text-xs font-medium"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                disabled={idx === 0}
                title="上移阶段"
                onClick={() => moveStage(idx, -1)}
              >
                <ArrowUp className="size-3.5" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                disabled={idx === stages.length - 1}
                title="下移阶段"
                onClick={() => moveStage(idx, 1)}
              >
                <ArrowDown className="size-3.5" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                disabled={stages.length <= 1}
                title="删除此阶段"
                onClick={() => removeStage(idx)}
              >
                <X className="size-3.5" />
              </Button>
            </div>

            {/* Seat multi-pick chips */}
            <div className="space-y-1.5">
              {realSeats.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {realSeats.map((seat) => {
                    const active = st.seats.includes(seat.name)
                    return (
                      <button
                        key={seat.id}
                        type="button"
                        aria-pressed={active}
                        onClick={() => toggleSeat(idx, seat.name)}
                        className={`chip inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs transition-colors ${
                          active
                            ? "border-primary/60 bg-primary/15 text-foreground"
                            : "border-border bg-background/60 text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        {active ? (
                          <Check className="size-3 text-primary" />
                        ) : (
                          <span className="size-2 rounded-full" style={{ background: seat.color }} />
                        )}
                        <span className="font-medium">{seat.name}</span>
                      </button>
                    )
                  })}
                </div>
              ) : null}
              <div className="flex gap-1.5">
                <Input
                  value={st.draftSeat}
                  onChange={(e) => updateStage(idx, { draftSeat: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault()
                      commitDraftSeat(idx)
                    }
                  }}
                  placeholder={
                    st.seats.length > 0
                      ? `已选：${st.seats.join("、")}（可继续点选或输入其他席位名）`
                      : "点选上方席位，或手填席位名回车添加"
                  }
                  className="h-7 text-xs"
                />
                {st.draftSeat.trim() ? (
                  <Button type="button" size="xs" variant="outline" onClick={() => commitDraftSeat(idx)}>
                    添加
                  </Button>
                ) : null}
              </div>
            </div>

            <Textarea
              value={st.instruction}
              maxLength={1000}
              onChange={(e) => updateStage(idx, { instruction: e.target.value })}
              placeholder="本阶段给 AI 的职责说明（如：只出计划不改代码 / 按拍板方案并行实现）"
              className="min-h-14 text-xs"
            />

            <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-muted-foreground select-none hover:text-foreground">
              <input
                type="checkbox"
                checked={Boolean(st.gate)}
                onChange={(e) => updateStage(idx, { gate: e.target.checked })}
                className="size-3.5 accent-primary"
              />
              <span>⏸ 本阶段全部完成后暂停，等我在「等你定」拍板再进入下一阶段</span>
            </label>
          </div>
        ))}

        {stages.length < MAX_STAGES ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-full border-dashed"
            onClick={() => setStages((list) => [...list, makeStage(list.length)])}
          >
            <Plus className="size-4" />
            添加阶段
          </Button>
        ) : null}
      </div>

      <AdvancedSection open={advanced} onToggle={() => setAdvanced(!advanced)} note="快捷命令与补充规则">
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor={`${prefix}-command`}>群聊快捷命令（可选）</Label>
            <Input
              id={`${prefix}-command`}
              value={command}
              maxLength={24}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="例如 work（留空则在独立工作流工作台启动）"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${prefix}-note`}>全局补充规则（可选）</Label>
            <Textarea id={`${prefix}-note`} value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} />
          </div>
        </div>
      </AdvancedSection>

      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>
          返回
        </Button>
        <Button type="submit" disabled={busy}>
          {busy ? "保存中…" : "保存模板"}
        </Button>
      </div>
    </form>
  )
}
