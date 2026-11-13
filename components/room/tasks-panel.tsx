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
import { Textarea } from "@/components/ui/textarea"
import { awaitingReview } from "@/lib/review"
import { TASK_STATUS_LABEL, clock } from "@/lib/status"
import type { PublicAgent, Task, TaskStatus, TaskStep, TaskStepState } from "@/lib/types"

// Cards are frosted glass like the rest of the page (they were sticky notes
// on colored paper, which clashed). Status is a dot and a chip; amber is
// "waiting for you", as in the 「流程」 view.
const CHIP: Record<TaskStatus, string> = {
  open: "bg-foreground/[0.06] text-muted-foreground",
  doing: "bg-sky-500/12 text-sky-700 dark:text-sky-300",
  blocked: "bg-red-500/12 text-red-700 dark:text-red-300",
  done: "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
}
const DOT: Record<TaskStatus, string> = {
  open: "bg-muted-foreground/50",
  doing: "bg-sky-500",
  blocked: "bg-red-500",
  done: "bg-emerald-500",
}
const WAITING_CHIP = "bg-amber-500/15 text-amber-700 dark:text-amber-300"
// A plain inset inside a card: steps, a handoff brief.
const INSET = "rounded-xl bg-foreground/[0.04] ring-1 ring-foreground/[0.06]"

export function TasksPanel({
  tasks,
  agents,
  highlightId,
  busy,
  onAskHandoff,
  onStatus,
  onStep,
  onReview,
  onFork,
  header,
}: {
  tasks: Task[]
  agents: PublicAgent[]
  highlightId: string | null
  busy: boolean
  // Shown above the tasks, such as the room summary.
  header?: React.ReactNode
  onAskHandoff: (task: Task, agent: PublicAgent) => void
  onStatus: (task: Task, action: "done" | "block") => void
  onStep: (task: Task, step: number, state: TaskStepState) => void
  onReview: (task: Task, pass: boolean, note: string) => void
  // A finished task is not edited; this makes a copy to carry on in.
  onFork: (task: Task) => void
}) {
  const active = tasks.filter((task) => task.status !== "done")
  const done = tasks.filter((task) => task.status === "done")
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
      <div className="space-y-3 px-3">
        {tasks.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-foreground/15 px-3 py-4 text-xs leading-5 text-muted-foreground">
            还没有待办。在对话里让 AI 做新功能时，它会先在这里建一条，拆成几步，做一步勾一步。
          </div>
        ) : null}
        {active.map((task) => (
          <TaskCard
            key={task.id}
            task={task}
            agents={agents}
            highlight={highlightId === task.id}
            busy={busy}
            onAskHandoff={onAskHandoff}
            onStatus={onStatus}
            onStep={onStep}
            onReview={onReview}
            onFork={onFork}
          />
        ))}
        {done.length > 0 ? (
          <details className="group/done pt-1">
            <summary className="flex cursor-pointer list-none items-center gap-1.5 px-1 text-xs text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
              <ChevronDown className="size-3.5 -rotate-90 transition-transform group-open/done:rotate-0" />
              已完成 {done.length}
            </summary>
            <div className="mt-3 space-y-3">
              {done.map((task) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  agents={agents}
                  highlight={highlightId === task.id}
                  busy={busy}
                  onAskHandoff={onAskHandoff}
                  onStatus={onStatus}
                  onStep={onStep}
                  onReview={onReview}
                  onFork={onFork}
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
  task,
  agents,
  highlight,
  busy,
  onAskHandoff,
  onStatus,
  onStep,
  onReview,
  onFork,
}: {
  task: Task
  agents: PublicAgent[]
  highlight: boolean
  busy: boolean
  onAskHandoff: (task: Task, agent: PublicAgent) => void
  onStatus: (task: Task, action: "done" | "block") => void
  onStep: (task: Task, step: number, state: TaskStepState) => void
  onReview: (task: Task, pass: boolean, note: string) => void
  onFork: (task: Task) => void
}) {
  const waiting = awaitingReview(task)
  const others = agents.filter((agent) => agent.id !== task.ownerId)
  return (
    <article
      id={`task-${task.id}`}
      className={`frost rounded-2xl px-3.5 pt-3 pb-3 ring-1 transition-shadow ${
        highlight ? "ring-2 ring-ring" : waiting ? "ring-amber-500/45" : "ring-foreground/10"
      } ${task.status === "done" ? "opacity-70" : ""}`}
    >
      <div className="flex items-start gap-2">
        <span className={`mt-[7px] size-2 shrink-0 rounded-full ${waiting ? "bg-amber-500" : DOT[task.status]}`} aria-hidden />
        <h3 className="min-w-0 flex-1 text-sm leading-5 font-medium">{task.title}</h3>
        <span className={`mt-px shrink-0 rounded-full px-2 py-0.5 text-[10px] leading-4 font-medium ${waiting ? WAITING_CHIP : CHIP[task.status]}`}>
          {waiting ? "待验收" : TASK_STATUS_LABEL[task.status]}
        </span>
      </div>
      <p className="mt-0.5 pl-4 text-[11px] text-muted-foreground">
        {task.ownerName ? task.ownerName : "还没有负责人"}
        <span className="opacity-60"> · {task.id}</span>
        {task.createdByName !== task.ownerName ? ` · ${task.createdByName} 建` : ""}
        {task.forkedFrom ? ` · 复制自「${task.forkedFrom.title}」` : ""}
      </p>
      {waiting ? (
        <ReviewBox task={task} busy={busy} onReview={(pass, note) => onReview(task, pass, note)} />
      ) : task.review?.state === "rejected" && task.status !== "done" ? (
        <p className="mt-2.5 rounded-xl bg-red-500/10 px-2.5 py-1.5 text-[11px] leading-5 text-red-800 ring-1 ring-red-500/20 dark:text-red-200">
          {clock(task.review.at)} 打回：{task.review.note}
        </p>
      ) : null}
      {task.steps?.length ? (
        <StepDrawer steps={task.steps} busy={busy} locked={task.status === "done"} onStep={(step, state) => onStep(task, step, state)} />
      ) : null}
      {task.brief && task.status !== "done" ? (
        <dl className={`mt-2 space-y-1 px-2.5 py-2 text-[11px] leading-5 ${INSET}`}>
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
        <ol className="mt-2.5 space-y-0.5 pl-4 text-[11px] leading-5 text-muted-foreground">
          {task.history.slice(-2).map((event, index) => (
            <li key={`${event.at}-${index}`} className="truncate" title={`${clock(event.at)} ${event.actor} ${event.action}${event.note ? `：${event.note}` : ""}`}>
              <span className="tabular-nums opacity-70">{clock(event.at)}</span> <span className="text-foreground/75">{event.actor}</span> {event.action}
              {event.note ? `：${event.note}` : ""}
            </li>
          ))}
        </ol>
      ) : null}
      {task.status === "done" ? (
        <div className="mt-3 flex flex-wrap items-center gap-1.5 pl-4">
          <Button
            type="button"
            size="xs"
            variant="outline"
            title="已完成的待办不能再改；复制出一条新的，标题和步骤照抄，步骤重新开始"
            disabled={busy}
            onClick={() => onFork(task)}
          >
            复制一份
          </Button>
          <span className="text-[10px] text-muted-foreground">已完成的不能再改</span>
        </div>
      ) : null}
      {task.status !== "done" ? (
        <div className="mt-3 flex flex-wrap gap-1 pl-4">
          {waiting ? null : (
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={busy}
              onClick={() => onStatus(task, "done")}
            >
              完成
            </Button>
          )}
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={busy}
            onClick={() => onStatus(task, "block")}
          >
            卡住
          </Button>
          {others.length > 0 ? (
            <DropdownMenu>
              <DropdownMenuTrigger
                className="inline-flex h-6 items-center gap-1 rounded-md border border-input bg-background/40 px-2 text-xs hover:bg-foreground/[0.06] disabled:opacity-50"
                disabled={busy}
              >
                交给
                <ChevronDown className="size-3 opacity-60" />
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

// The user's sign-off on a card that waits for it: pass in one click, or
// send it back with a reason the owner is woken with.
function ReviewBox({
  task,
  busy,
  onReview,
}: {
  task: Task
  busy: boolean
  onReview: (pass: boolean, note: string) => void
}) {
  const [rejecting, setRejecting] = useState(false)
  const [reason, setReason] = useState("")
  const asked = task.review?.state === "waiting" ? task.review : undefined
  return (
    <div className="mt-2.5 space-y-2 rounded-xl bg-amber-500/[0.08] px-2.5 py-2 text-[11px] leading-5 ring-1 ring-amber-500/30">
      <p className="font-medium text-amber-800 dark:text-amber-200">
        等你验收
        <span className="font-normal text-muted-foreground">
          {asked ? ` · ${asked.by} ${clock(asked.at)} 请验收${asked.note ? `：${asked.note}` : ""}` : " · 其余步骤都做完了"}
        </span>
      </p>
      {rejecting ? (
        <form
          className="space-y-1.5"
          onSubmit={(event) => {
            event.preventDefault()
            if (!reason.trim()) return
            onReview(false, reason.trim())
            setRejecting(false)
            setReason("")
          }}
        >
          <Textarea
            autoFocus
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder={`哪里不对？会转给 ${task.ownerName ?? "负责人"}，它照着改`}
            aria-label="打回原因"
            rows={2}
            className="min-h-0 resize-none bg-background/60 text-xs"
          />
          <div className="flex gap-1">
            <Button type="submit" size="xs" variant="destructive" disabled={busy || !reason.trim()}>
              打回
            </Button>
            <Button type="button" size="xs" variant="ghost" onClick={() => setRejecting(false)}>
              取消
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex gap-1">
          <Button type="button" size="xs" disabled={busy} onClick={() => onReview(true, "")}>
            <Check className="size-3" />
            验收通过
          </Button>
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={busy}
            onClick={() => setRejecting(true)}
          >
            打回
          </Button>
        </div>
      )}
    </div>
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
  locked,
  onStep,
}: {
  steps: TaskStep[]
  busy: boolean
  // A finished task: the steps are only read.
  locked: boolean
  onStep: (step: number, state: TaskStepState) => void
}) {
  const [open, setOpen] = useState(false)
  const done = steps.filter((step) => step.state === "done").length
  const current = steps.find((step) => step.state === "doing") ?? steps.find((step) => step.state === "todo")
  return (
    <div className={`mt-2.5 ${INSET}`}>
      <button
        type="button"
        className="flex w-full items-center gap-2 rounded-xl px-2.5 py-1.5 text-left text-[11px] hover:bg-foreground/[0.03]"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="shrink-0 font-medium">
          步骤 {done}/{steps.length}
        </span>
        <span className="h-1 w-12 shrink-0 overflow-hidden rounded-full bg-foreground/10">
          <span
            className={`block h-full rounded-full ${done === steps.length ? "bg-emerald-500" : "bg-sky-500"}`}
            style={{ width: `${(done / steps.length) * 100}%` }}
          />
        </span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          {current ? `${current.state === "doing" ? "正在" : "下一步"}：${current.text}` : "全部做完"}
        </span>
        <ChevronDown className={`size-3.5 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {/* Built only while open (Reveal keeps the last one for the fold): a
          room's many tasks each drawing every step slowed switching projects. */}
      <Reveal open={open}>
        {open ? (
          <ol className="space-y-1.5 px-2.5 pt-0.5 pb-2.5 text-[11px] leading-5">
            {steps.map((step, index) => (
              <li key={step.id} className="flex gap-1.5">
                <button
                  type="button"
                  className={`mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border transition-colors ${
                    step.state === "done"
                      ? "border-emerald-500 bg-emerald-500"
                      : step.state === "doing"
                        ? "border-sky-500"
                        : "border-foreground/25 hover:border-foreground/50"
                  }`}
                  title={locked ? `${STEP_LABEL[step.state]}（已完成的待办不能再改）` : `${STEP_LABEL[step.state]}，点一下改成${STEP_LABEL[NEXT[step.state]]}`}
                  aria-label={locked ? `第 ${index + 1} 步${STEP_LABEL[step.state]}` : `第 ${index + 1} 步${STEP_LABEL[step.state]}，改成${STEP_LABEL[NEXT[step.state]]}`}
                  disabled={busy || locked}
                  onClick={() => onStep(index + 1, NEXT[step.state])}
                >
                  {step.state === "done" ? (
                    <Check className="size-2.5 text-white" strokeWidth={3} />
                  ) : step.state === "doing" ? (
                    <span className="size-1.5 rounded-full bg-sky-500" />
                  ) : null}
                </button>
                <div className="min-w-0 flex-1">
                  <p className={step.state === "done" ? "text-muted-foreground line-through decoration-foreground/30" : step.state === "doing" ? "font-medium" : ""}>
                    {index + 1}. {step.text}
                  </p>
                  <p className="line-clamp-3 text-muted-foreground/80">
                    {STEP_LABEL[step.state]} · {step.by} {clock(step.updatedAt)}
                    {step.note ? `：${step.note}` : ""}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        ) : null}
      </Reveal>
    </div>
  )
}
