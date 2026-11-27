"use client"

import { useId, useState } from "react"
import { ArrowLeft, ArrowRight, Check, Pencil, Plus, Trash2, X } from "lucide-react"
import { toast } from "sonner"

import { AdvancedSection } from "@/components/room/advanced"
import { api } from "@/components/room/api"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import type { PublicAgent, Workflow, WorkflowKind } from "@/lib/types"

const MAX_SEATS = 8

function splitNames(value: string) {
  return value.split(/[、,，\s]+/).map((s) => s.trim()).filter(Boolean)
}

function mergeNames(list: string[], draft: string) {
  const next = [...list]
  for (const name of splitNames(draft)) {
    if (!next.includes(name) && next.length < MAX_SEATS) next.push(name)
  }
  return next
}

export function workflowLine(item: Workflow) {
  if (item.kind === "plan") return `${item.planners?.join(" + ")} · 只做计划`
  if (item.kind === "explore") return `${item.explorers?.join(" + ")} · 联合探索`
  return `${item.lead} 主控 → ${item.workers?.join("、")} 执行 → ${item.summarizer} 汇总`
}

export function WorkflowsDialog({ open, onOpenChange, workflows, agents, onChanged }: {
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
    } finally { setBusy(false) }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { onOpenChange(next); if (!next) { setEditing(null); setDeleting(null) } }}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{editing ? editing === "new" ? "新建工作流" : "编辑工作流" : "管理工作流"}</DialogTitle>
          <DialogDescription>保存谁主控、谁执行、谁汇总，或让多位搭档共同出计划、并行探索方案。仅用于当前项目。</DialogDescription>
        </DialogHeader>
        {editing ? (
          <WorkflowForm key={editing === "new" ? "new" : editing.id} workflow={editing === "new" ? undefined : editing} agents={agents}
            onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); onChanged() }} />
        ) : (
          <div className="space-y-3">
            {workflows.length === 0 ? <p className="py-4 text-sm text-muted-foreground">还没有工作流。新建一条，把协作分工保存下来。</p> : null}
            {workflows.map((item) => (
              <div key={item.id} className="rounded-xl border border-border p-3">
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="break-words text-sm font-medium">{item.name} {item.command ? <span className="text-muted-foreground">/{item.command}</span> : null}</p>
                    <p className="mt-1 break-words text-xs leading-relaxed text-muted-foreground">{workflowLine(item)}</p>
                  </div>
                  <Button variant="ghost" size="icon" aria-label={`编辑${item.name}`} onClick={() => setEditing(item)}><Pencil /></Button>
                  <Button variant="ghost" size="icon" aria-label={`删除${item.name}`} onClick={() => setDeleting(item.id)}><Trash2 /></Button>
                </div>
                {deleting === item.id ? (
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                    <span>删除后不会自动恢复。</span>
                    <Button size="sm" variant="destructive" disabled={busy} onClick={() => void remove(item.id)}>确认删除</Button>
                    <Button size="sm" variant="ghost" onClick={() => setDeleting(null)}>取消</Button>
                  </div>
                ) : null}
              </div>
            ))}
            <Button variant="outline" onClick={() => setEditing("new")}><Plus />新建工作流</Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

function SeatMultiPicker({
  id,
  label,
  selected,
  onChange,
  draft,
  onDraftChange,
  seats,
  min,
  ordered,
  roleLabels = ["统稿", "拆解"],
  occupied,
}: {
  id: string
  label: string
  selected: string[]
  onChange: (next: string[]) => void
  draft: string
  onDraftChange: (value: string) => void
  seats: PublicAgent[]
  min: number
  ordered?: boolean
  roleLabels?: [string, string]
  occupied?: Map<string, string>
}) {
  const byName = new Map(seats.map((s) => [s.name, s]))

  function toggle(name: string) {
    if (selected.includes(name)) {
      onChange(selected.filter((item) => item !== name))
      return
    }
    if (selected.length >= MAX_SEATS) {
      toast.error(`最多选择 ${MAX_SEATS} 个席位`)
      return
    }
    onChange([...selected, name])
  }

  function move(index: number, delta: number) {
    const target = index + delta
    if (target < 0 || target >= selected.length) return
    const next = [...selected]
    ;[next[index], next[target]] = [next[target], next[index]]
    onChange(next)
  }

  function commitDraft() {
    const incoming = splitNames(draft)
    if (incoming.length === 0) return
    const next = [...selected]
    let skippedDup = false
    let hitMax = false
    for (const name of incoming) {
      if (occupied?.has(name)) {
        toast.error(`${name} 已设为「${occupied.get(name)}」，请用不同席位`)
        continue
      }
      if (next.includes(name)) {
        skippedDup = true
        continue
      }
      if (next.length >= MAX_SEATS) {
        hitMax = true
        break
      }
      next.push(name)
    }
    if (next.length !== selected.length) onChange(next)
    else if (skippedDup) toast.error("该席位已在列表里")
    if (hitMax) toast.error(`最多选择 ${MAX_SEATS} 个席位`)
    onDraftChange("")
  }

  const shortOfMin = selected.length < min

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={id}>{label}</Label>
        <span className={`text-xs ${shortOfMin ? "text-amber-500 dark:text-amber-400" : "text-muted-foreground"}`}>
          已选 {selected.length} 位{shortOfMin ? `（至少 ${min} 位）` : ` / 最多 ${MAX_SEATS} 位`}
        </span>
      </div>

      {selected.length > 0 ? (
        <div className="flex flex-wrap gap-1.5 rounded-xl border border-border/80 bg-muted/25 p-2">
          {selected.map((name, idx) => {
            const seat = byName.get(name)
            return (
              <div
                key={name}
                className="inline-flex items-center gap-1 rounded-full border border-primary/40 bg-primary/10 py-1 pl-2.5 pr-1.5 text-xs text-foreground"
              >
                {ordered ? (
                  <span className={`mr-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${idx === 0 ? "bg-primary text-primary-foreground" : "bg-background/70 text-muted-foreground"}`}>
                    {idx === 0 ? `1·${roleLabels[0]}` : `${idx + 1}·${roleLabels[1]}`}
                  </span>
                ) : null}
                {seat ? <span className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: seat.color }} /> : null}
                <span className="font-medium">{name}</span>
                {ordered && selected.length > 1 ? (
                  <span className="ml-0.5 inline-flex items-center">
                    <button
                      type="button"
                      disabled={idx === 0}
                      aria-label={`前移 ${name}`}
                      onClick={() => move(idx, -1)}
                      className="rounded p-0.5 text-muted-foreground hover:bg-background/60 hover:text-foreground disabled:opacity-30"
                    >
                      <ArrowLeft className="size-3" />
                    </button>
                    <button
                      type="button"
                      disabled={idx === selected.length - 1}
                      aria-label={`后移 ${name}`}
                      onClick={() => move(idx, 1)}
                      className="rounded p-0.5 text-muted-foreground hover:bg-background/60 hover:text-foreground disabled:opacity-30"
                    >
                      <ArrowRight className="size-3" />
                    </button>
                  </span>
                ) : null}
                <button
                  type="button"
                  aria-label={`移除 ${name}`}
                  onClick={() => onChange(selected.filter((item) => item !== name))}
                  className="ml-0.5 rounded-full p-0.5 text-muted-foreground hover:bg-background/60 hover:text-foreground"
                >
                  <X className="size-3" />
                </button>
              </div>
            )
          })}
        </div>
      ) : null}

      {seats.length > 0 ? (
        <div className="flex flex-wrap gap-1.5" role="group" aria-label={`选择${label}`}>
          {seats.map((seat) => {
            const active = selected.includes(seat.name)
            const usedBy = !active ? occupied?.get(seat.name) : undefined
            const disabled = Boolean(usedBy) || (!active && selected.length >= MAX_SEATS)
            return (
              <button
                key={seat.id}
                type="button"
                disabled={disabled}
                aria-pressed={active}
                title={seat.model ? `${seat.name}（${seat.model}）` : seat.name}
                onClick={() => toggle(seat.name)}
                className={`chip inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors ${
                  active
                    ? "border-primary/60 bg-primary/15 text-foreground"
                    : "border-border bg-background/60 text-muted-foreground hover:border-foreground/30 hover:text-foreground"
                } disabled:cursor-not-allowed disabled:opacity-40`}
              >
                {active ? (
                  <Check className="size-3 shrink-0 text-primary" />
                ) : (
                  <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: seat.color }} />
                )}
                <span className="truncate font-medium">{seat.name}</span>
                {seat.model && seat.model !== seat.name ? (
                  <span className="max-w-[11rem] truncate text-[11px] text-muted-foreground">{seat.model}</span>
                ) : null}
                {usedBy ? <span className="text-[10px] text-muted-foreground">({usedBy})</span> : null}
              </button>
            )
          })}
        </div>
      ) : null}

      <div className="flex gap-2">
        <Input
          id={id}
          value={draft}
          onChange={(e) => onDraftChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault()
              commitDraft()
            }
          }}
          placeholder={seats.length > 0 ? "点上方席位可多选，也可输入其他席位名后添加" : "输入席位名（可用顿号分隔多位）"}
        />
        <Button type="button" variant="outline" size="sm" className="shrink-0" disabled={!draft.trim()} onClick={commitDraft}>
          <Plus className="size-3.5" />
          添加
        </Button>
      </div>
    </div>
  )
}

function SeatSinglePicker({
  id,
  label,
  value,
  onChange,
  seats,
  occupied,
}: {
  id: string
  label: string
  value: string
  onChange: (next: string) => void
  seats: PublicAgent[]
  occupied?: Map<string, string>
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {seats.length > 0 ? (
        <div className="flex flex-wrap gap-1.5" role="group" aria-label={`选择${label}`}>
          {seats.map((seat) => {
            const active = value.trim() === seat.name
            const usedBy = !active ? occupied?.get(seat.name) : undefined
            return (
              <button
                key={seat.id}
                type="button"
                disabled={Boolean(usedBy)}
                aria-pressed={active}
                title={seat.model ? `${seat.name}（${seat.model}）` : seat.name}
                onClick={() => onChange(active ? "" : seat.name)}
                className={`chip inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors ${
                  active
                    ? "border-primary/60 bg-primary/15 text-foreground"
                    : "border-border bg-background/60 text-muted-foreground hover:border-foreground/30 hover:text-foreground"
                } disabled:cursor-not-allowed disabled:opacity-40`}
              >
                {active ? (
                  <Check className="size-3 shrink-0 text-primary" />
                ) : (
                  <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: seat.color }} />
                )}
                <span className="truncate font-medium">{seat.name}</span>
                {seat.model && seat.model !== seat.name ? (
                  <span className="max-w-[11rem] truncate text-[11px] text-muted-foreground">{seat.model}</span>
                ) : null}
                {usedBy ? <span className="text-[10px] text-muted-foreground">({usedBy})</span> : null}
              </button>
            )
          })}
        </div>
      ) : null}
      <Input id={id} value={value} onChange={(e) => onChange(e.target.value)} placeholder="点击上方席位或直接填写席位名" />
    </div>
  )
}

function WorkflowForm({ workflow, agents, onCancel, onSaved }: {
  workflow?: Workflow
  agents: PublicAgent[]
  onCancel: () => void
  onSaved: () => void
}) {
  const prefix = useId()
  const realSeats = agents.filter((a) => !a.demo)
  const [name, setName] = useState(workflow?.name ?? "")
  const [kind, setKind] = useState<WorkflowKind>(workflow?.kind ?? "orchestrate")
  const [command, setCommand] = useState(workflow?.command ?? "")
  const [lead, setLead] = useState(workflow?.lead ?? "")
  const [workers, setWorkers] = useState<string[]>(workflow?.workers ?? [])
  const [workerDraft, setWorkerDraft] = useState("")
  const [summarizer, setSummarizer] = useState(workflow?.summarizer ?? "")
  const [planners, setPlanners] = useState<string[]>(workflow?.planners ?? [])
  const [plannerDraft, setPlannerDraft] = useState("")
  const [explorers, setExplorers] = useState<string[]>(workflow?.explorers ?? [])
  const [explorerDraft, setExplorerDraft] = useState("")
  const [note, setNote] = useState(workflow?.note ?? "")
  const [advanced, setAdvanced] = useState(false)
  const [busy, setBusy] = useState(false)

  const leadUsed = new Map<string, string>()
  for (const w of workers) leadUsed.set(w, "执行")
  if (summarizer.trim()) leadUsed.set(summarizer.trim(), "汇总")

  const workersUsed = new Map<string, string>()
  if (lead.trim()) workersUsed.set(lead.trim(), "主控")
  if (summarizer.trim()) workersUsed.set(summarizer.trim(), "汇总")

  const summarizerUsed = new Map<string, string>()
  if (lead.trim()) summarizerUsed.set(lead.trim(), "主控")
  for (const w of workers) summarizerUsed.set(w, "执行")

  async function save(event: React.FormEvent) {
    event.preventDefault()
    const finalPlanners = mergeNames(planners, plannerDraft)
    const finalExplorers = mergeNames(explorers, explorerDraft)
    const finalWorkers = mergeNames(workers, workerDraft)
    setBusy(true)
    try {
      await api("/api/v1/workflows", { method: "POST", body: JSON.stringify({ as: "human", action: "save", workflow: {
        id: workflow?.id, name, kind, command, lead: lead.trim(), workers: finalWorkers, summarizer: summarizer.trim(), planners: finalPlanners, explorers: finalExplorers, note,
      } }) })
      toast.success("工作流已保存")
      onSaved()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "保存失败")
    } finally { setBusy(false) }
  }

  return (
    <form className="space-y-4" onSubmit={(event) => void save(event)}>
      <div className="space-y-1.5"><Label htmlFor={`${prefix}-name`}>工作流名称</Label><Input id={`${prefix}-name`} required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder={kind === "explore" ? "例如：多 AI 架构探索" : kind === "plan" ? "例如：混合计划模式" : "例如：主控派活与汇总"} /></div>
      <div className="flex flex-wrap gap-2" role="group" aria-label="工作流类型">
        <Button type="button" variant={kind === "orchestrate" ? "default" : "outline"} aria-pressed={kind === "orchestrate"} onClick={() => setKind("orchestrate")}>主控派活与汇总</Button>
        <Button type="button" variant={kind === "plan" ? "default" : "outline"} aria-pressed={kind === "plan"} onClick={() => setKind("plan")}>混合计划模式</Button>
        <Button type="button" variant={kind === "explore" ? "default" : "outline"} aria-pressed={kind === "explore"} onClick={() => setKind("explore")}>多 AI 探索</Button>
      </div>
      {kind === "plan" ? <>
        <SeatMultiPicker
          id={`${prefix}-planners`}
          label="共同规划的席位"
          selected={planners}
          onChange={setPlanners}
          draft={plannerDraft}
          onDraftChange={setPlannerDraft}
          seats={realSeats}
          min={2}
          ordered
          roleLabels={["统稿", "拆解"]}
        />
        <p className="text-xs text-muted-foreground">首位审查需求并整合计划，其余拆解实施步骤（可用左右箭头调整顺序）。本轮只做计划，确认后再实施。</p>
      </> : kind === "explore" ? <>
        <SeatMultiPicker
          id={`${prefix}-explorers`}
          label="参与探索的席位"
          selected={explorers}
          onChange={setExplorers}
          draft={explorerDraft}
          onDraftChange={setExplorerDraft}
          seats={realSeats}
          min={2}
          ordered
          roleLabels={["汇总", "探索"]}
        />
        <p className="text-xs text-muted-foreground">全部席位并行从不同角度调研与发散，首位汇总共识、分歧与候选方向（可用左右箭头调整首位）。本轮只探索不改代码。</p>
      </> : <>
        <SeatSinglePicker id={`${prefix}-lead`} label="主控" value={lead} onChange={setLead} seats={realSeats} occupied={leadUsed} />
        <SeatMultiPicker
          id={`${prefix}-workers`}
          label="执行"
          selected={workers}
          onChange={setWorkers}
          draft={workerDraft}
          onDraftChange={setWorkerDraft}
          seats={realSeats}
          min={1}
          occupied={workersUsed}
        />
        <SeatSinglePicker id={`${prefix}-summarizer`} label="最终汇总" value={summarizer} onChange={setSummarizer} seats={realSeats} occupied={summarizerUsed} />
        <p className="text-xs text-muted-foreground">开始时只叫醒主控，由主控派活、复核，再交汇总席位收尾。</p>
      </>}
      <div className="space-y-1.5"><Label htmlFor={`${prefix}-command`}>快捷命令（可选）</Label><Input id={`${prefix}-command`} value={command} maxLength={24} onChange={(e) => setCommand(e.target.value)} placeholder={kind === "explore" ? "例如 explore，输入 /explore 加主题即可使用" : kind === "plan" ? "例如 plan，输入 /plan 加需求即可使用" : "例如 work，输入 /work 加需求即可使用"} /></div>
      <AdvancedSection open={advanced} onToggle={() => setAdvanced(!advanced)} note="补充协作规则">
        <Label htmlFor={`${prefix}-note`}>补充规则（可选）</Label><Textarea id={`${prefix}-note`} value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} />
      </AdvancedSection>
      <div className="flex justify-end gap-2"><Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>返回</Button><Button type="submit" disabled={busy}>{busy ? "保存中…" : "保存工作流"}</Button></div>
    </form>
  )
}
