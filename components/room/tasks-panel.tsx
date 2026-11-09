import { useState } from "react"
import { Check, ChevronDown } from "lucide-react"

import { Reveal } from "@/components/room/reveal"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { TASK_STATUS_LABEL, clock } from "@/lib/status"
import type { PublicAgent, Task, TaskStatus, TaskStep, TaskStepState } from "@/lib/types"

// Each status gets its own paper color; the tilt cycles so a stack of notes
// doesn't line up.
const TONE: Record<TaskStatus, string> = { open: "yellow", doing: "peach", blocked: "pink", done: "green" }
const TILTS = ["a", "d", "c", "b"]

const CHIP: Record<TaskStatus, string> = {
  open: "bg-sky-500/10 text-sky-700 dark:text-sky-300",
  doing: "bg-amber-500/12 text-amber-700 dark:text-amber-300",
  blocked: "bg-red-500/10 text-red-700 dark:text-red-300",
  done: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
}

export function TasksPanel({
  tasks,
  agents,
  highlightId,
  busy,
  onCreate,
  onAskHandoff,
  onStatus,
  onStep,
  header,
}: {
  tasks: Task[]
  agents: PublicAgent[]
  highlightId: string | null
  busy: boolean
  // Shown above the new-task form, such as the room summary.
  header?: React.ReactNode
  onCreate: (title: string, ownerId: string | null, steps: string[]) => void
  onAskHandoff: (task: Task, agent: PublicAgent) => void
  onStatus: (task: Task, action: "done" | "block") => void
  onStep: (task: Task, step: number, state: TaskStepState) => void
}) {
  const [title, setTitle] = useState("")
  const [steps, setSteps] = useState("")
  const [owner, setOwner] = useState("none")
  const active = tasks.filter((task) => task.status !== "done")
  const done = tasks.filter((task) => task.status === "done")
  const items = [
    { value: "none", label: "先不指定" },
    ...agents.map((agent) => ({
      value: agent.id,
      label: `${agent.name} · ${agent.role}`,
    })),
  ]

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-baseline justify-between px-4 pt-3 pb-3">
        <h2 className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">待办</h2>
        <span className="text-[11px] text-muted-foreground">
          {active.length} 进行中{done.length > 0 ? ` · ${done.length} 完成` : ""}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1 pt-2 pb-6">
      {header}
      <form
        className="note mx-3 mb-5 space-y-2 p-2.5"
        data-tilt="a"
        onSubmit={(event) => {
          event.preventDefault()
          if (!title.trim()) return
          const list = steps
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean)
          onCreate(title.trim(), owner === "none" ? null : owner, list)
          setTitle("")
          setSteps("")
          setOwner("none")
        }}
      >
        <Input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="新待办：要做的功能"
          aria-label="待办标题"
          className="border-0 bg-transparent px-1 shadow-none placeholder:text-current placeholder:opacity-55 focus-visible:ring-0 dark:bg-transparent"
        />
        <Textarea
          value={steps}
          onChange={(event) => setSteps(event.target.value)}
          placeholder="拆成几步，一行一步（可以不填）"
          aria-label="步骤，一行一步"
          rows={2}
          className="min-h-0 resize-none border-0 bg-transparent px-1 py-0.5 text-xs shadow-none placeholder:text-current placeholder:opacity-55 focus-visible:ring-0 dark:bg-transparent"
        />
        <div className="flex gap-2">
          <Select items={items} value={owner} onValueChange={(value) => setOwner(value ?? "none")}>
            <SelectTrigger className="w-full min-w-0 flex-1 border-current/15 bg-white/40 dark:bg-black/15" aria-label="负责人">
              <SelectValue placeholder="先不指定" />
            </SelectTrigger>
            <SelectContent>
              {items.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button type="submit" size="sm" className="h-8" disabled={busy || title.trim().length === 0}>
            派出去
          </Button>
        </div>
      </form>
      <div className="space-y-5 px-3">
        {tasks.length === 0 ? (
          <div className="rounded-sm border border-dashed border-foreground/15 px-3 py-4 text-xs leading-5 text-muted-foreground">
            还没有待办。写下要做的功能、拆好步骤并指定负责人；在对话里让 AI 做新功能时，它也会自己在这里建一条，做一步勾一步。
          </div>
        ) : null}
        {active.map((task, index) => (
          <TaskCard
            key={task.id}
            tilt={TILTS[index % TILTS.length]}
            task={task}
            agents={agents}
            highlight={highlightId === task.id}
            busy={busy}
            onAskHandoff={onAskHandoff}
            onStatus={onStatus}
            onStep={onStep}
          />
        ))}
        {done.length > 0 ? (
          <details className="rounded-xl px-1 py-1">
            <summary className="cursor-pointer px-1 text-xs text-muted-foreground">
              已完成 {done.length}
            </summary>
            <div className="mt-4 space-y-5">
              {done.map((task, index) => (
                <TaskCard
                  key={task.id}
                  tilt={TILTS[(index + 1) % TILTS.length]}
                  task={task}
                  agents={agents}
                  highlight={highlightId === task.id}
                  busy={busy}
                  onAskHandoff={onAskHandoff}
                  onStatus={onStatus}
                  onStep={onStep}
                />
              ))}
            </div>
          </details>
        ) : null}
      </div>
      </div>
    </div>
  )
}

function TaskCard({
  tilt,
  task,
  agents,
  highlight,
  busy,
  onAskHandoff,
  onStatus,
  onStep,
}: {
  tilt: string
  task: Task
  agents: PublicAgent[]
  highlight: boolean
  busy: boolean
  onAskHandoff: (task: Task, agent: PublicAgent) => void
  onStatus: (task: Task, action: "done" | "block") => void
  onStep: (task: Task, step: number, state: TaskStepState) => void
}) {
  const others = agents.filter((agent) => agent.id !== task.ownerId)
  return (
    <article
      id={`task-${task.id}`}
      data-tone={TONE[task.status]}
      data-tilt={tilt}
      className={`note px-3 pt-3 pb-2.5 ${highlight ? "ring-2 ring-ring" : ""} ${task.status === "done" ? "opacity-75" : ""}`}
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-sm leading-5 font-medium">{task.title}</h3>
        <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${CHIP[task.status]}`}>
          {TASK_STATUS_LABEL[task.status]}
        </span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {task.ownerName ? `负责人 ${task.ownerName}` : "还没有负责人"}
        {" · "}
        {task.createdByName} 建立
      </p>
      {task.steps?.length ? (
        <StepDrawer steps={task.steps} busy={busy} onStep={(step, state) => onStep(task, step, state)} />
      ) : null}
      {task.brief && task.status !== "done" ? (
        <dl className="mt-2 space-y-1 rounded-sm bg-white/35 px-2 py-1.5 text-[11px] leading-5 dark:bg-black/15">
          <div className="text-muted-foreground">{task.brief.by} 的交接单</div>
          {(
            [
              ["做完了", task.brief.done],
              ["还剩", task.brief.left],
              ["注意", task.brief.caveats],
            ] as const
          ).map(([label, text]) => (
            <div key={label} className="flex gap-1.5">
              <dt className="shrink-0 font-medium">{label}</dt>
              <dd className="min-w-0 whitespace-pre-line text-muted-foreground">{text}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {task.history.length > 0 ? (
        <ol className="mt-2 space-y-0.5 border-l border-current/20 pl-2 text-[11px] leading-5 text-muted-foreground">
          {task.history.slice(-3).map((event, index) => (
            <li key={`${event.at}-${index}`} className="line-clamp-2">
              {event.actor} {event.action}
              {event.note ? `：${event.note}` : ""}
            </li>
          ))}
        </ol>
      ) : null}
      {task.status !== "done" ? (
        <div className="mt-2.5 flex flex-wrap gap-1">
          <Button
            type="button"
            size="xs"
            variant="outline"
            className="border-current/20 bg-transparent hover:bg-white/40 dark:border-current/20 dark:bg-transparent dark:hover:bg-black/15"
            disabled={busy}
            onClick={() => onStatus(task, "done")}
          >
            完成
          </Button>
          <Button
            type="button"
            size="xs"
            variant="outline"
            className="border-current/20 bg-transparent hover:bg-white/40 dark:border-current/20 dark:bg-transparent dark:hover:bg-black/15"
            disabled={busy}
            onClick={() => onStatus(task, "block")}
          >
            卡住
          </Button>
          {others.length > 0 ? (
            <DropdownMenu>
              <DropdownMenuTrigger
                className="inline-flex h-6 items-center rounded-md border border-current/20 px-2 text-xs hover:bg-white/40 dark:hover:bg-black/15"
                disabled={busy}
              >
                交给
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {others.map((agent) => (
                  <DropdownMenuItem key={agent.id} onClick={() => onAskHandoff(task, agent)}>
                    {agent.name} · {agent.role}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      ) : null}
    </article>
  )
}

const NEXT: Record<TaskStepState, TaskStepState> = { todo: "doing", doing: "done", done: "todo" }
const STEP_LABEL: Record<TaskStepState, string> = { todo: "待做", doing: "在做", done: "做完" }

// A task's to-do list, folded to one line (how far along, and the step in
// hand) that opens to every step with who moved it and when. The dot in front
// of a step moves it along: to do, doing, done, and back.
function StepDrawer({
  steps,
  busy,
  onStep,
}: {
  steps: TaskStep[]
  busy: boolean
  onStep: (step: number, state: TaskStepState) => void
}) {
  const [open, setOpen] = useState(false)
  const done = steps.filter((step) => step.state === "done").length
  const current = steps.find((step) => step.state === "doing") ?? steps.find((step) => step.state === "todo")
  return (
    <div className="mt-2 rounded-sm bg-white/35 dark:bg-black/15">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-[11px]"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="shrink-0 font-medium">
          步骤 {done}/{steps.length}
        </span>
        <span className="h-1 w-10 shrink-0 overflow-hidden rounded-full bg-current/15">
          <span className="block h-full rounded-full bg-current/60" style={{ width: `${(done / steps.length) * 100}%` }} />
        </span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          {current ? `${current.state === "doing" ? "正在" : "下一步"}：${current.text}` : "全部做完"}
        </span>
        <ChevronDown className={`size-3.5 shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      <Reveal open={open}>
        <ol className="space-y-1 px-2 pb-2 text-[11px] leading-5">
          {steps.map((step, index) => (
            <li key={step.id} className="flex gap-1.5">
              <button
                type="button"
                className={`mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border border-current/35 ${
                  step.state === "done" ? "bg-current/70" : step.state === "doing" ? "bg-current/25" : ""
                }`}
                title={`${STEP_LABEL[step.state]}，点一下改成${STEP_LABEL[NEXT[step.state]]}`}
                aria-label={`第 ${index + 1} 步${STEP_LABEL[step.state]}，改成${STEP_LABEL[NEXT[step.state]]}`}
                disabled={busy}
                onClick={() => onStep(index + 1, NEXT[step.state])}
              >
                {step.state === "done" ? <Check className="size-2.5 text-background" /> : null}
              </button>
              <div className="min-w-0 flex-1">
                <p className={step.state === "done" ? "line-through opacity-60" : step.state === "doing" ? "font-medium" : ""}>
                  {index + 1}. {step.text}
                </p>
                <p className="text-muted-foreground">
                  {STEP_LABEL[step.state]} · {step.by} {clock(step.updatedAt)}
                  {step.note ? `：${step.note}` : ""}
                </p>
              </div>
            </li>
          ))}
        </ol>
      </Reveal>
    </div>
  )
}
