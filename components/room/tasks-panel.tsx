import { useState } from "react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { TASK_STATUS_LABEL } from "@/lib/status"
import type { PublicAgent, Task, TaskStatus } from "@/lib/types"

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
  header,
}: {
  tasks: Task[]
  agents: PublicAgent[]
  highlightId: string | null
  busy: boolean
  // Shown above the new-task form, such as the room summary.
  header?: React.ReactNode
  onCreate: (title: string, ownerId: string | null) => void
  onAskHandoff: (task: Task, agent: PublicAgent) => void
  onStatus: (task: Task, action: "done" | "block") => void
}) {
  const [title, setTitle] = useState("")
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
      <div className="flex items-baseline justify-between px-4 pt-4 pb-2">
        <h2 className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">分工</h2>
        <span className="text-[11px] text-muted-foreground">
          {active.length} 进行中{done.length > 0 ? ` · ${done.length} 完成` : ""}
        </span>
      </div>
      {header}
      <form
        className="mx-3 mb-3 space-y-2 rounded-xl border bg-card p-2"
        onSubmit={(event) => {
          event.preventDefault()
          if (!title.trim()) return
          onCreate(title.trim(), owner === "none" ? null : owner)
          setTitle("")
          setOwner("none")
        }}
      >
        <Input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="新任务：这阶段要交出来的东西"
          aria-label="任务标题"
          className="border-0 shadow-none focus-visible:ring-0 dark:bg-transparent"
        />
        <div className="flex gap-2">
          <Select items={items} value={owner} onValueChange={(value) => setOwner(value ?? "none")}>
            <SelectTrigger className="w-full min-w-0 flex-1" aria-label="负责人">
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
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 pb-4">
        {tasks.length === 0 ? (
          <div className="rounded-xl border border-dashed px-3 py-4 text-xs leading-5 text-muted-foreground">
            还没有分工。建一条任务并指定负责人，或在对话里 @名字 把活递过去。同一阶段只留一个负责人。
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
          />
        ))}
        {done.length > 0 ? (
          <details className="rounded-xl px-1 py-1">
            <summary className="cursor-pointer px-1 text-xs text-muted-foreground">
              已完成 {done.length}
            </summary>
            <div className="mt-2 space-y-2">
              {done.map((task) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  agents={agents}
                  highlight={highlightId === task.id}
                  busy={busy}
                  onAskHandoff={onAskHandoff}
                  onStatus={onStatus}
                />
              ))}
            </div>
          </details>
        ) : null}
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
}: {
  task: Task
  agents: PublicAgent[]
  highlight: boolean
  busy: boolean
  onAskHandoff: (task: Task, agent: PublicAgent) => void
  onStatus: (task: Task, action: "done" | "block") => void
}) {
  const others = agents.filter((agent) => agent.id !== task.ownerId)
  return (
    <article
      id={`task-${task.id}`}
      className={`rounded-xl border bg-card px-3 py-2.5 transition-shadow ${
        highlight ? "ring-2 ring-ring" : ""
      } ${task.status === "done" ? "opacity-70" : ""}`}
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
      {task.brief && task.status !== "done" ? (
        <dl className="mt-2 space-y-1 rounded-lg bg-muted/60 px-2 py-1.5 text-[11px] leading-5">
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
        <ol className="mt-2 space-y-0.5 border-l pl-2 text-[11px] leading-5 text-muted-foreground">
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
            disabled={busy}
            onClick={() => onStatus(task, "done")}
          >
            完成
          </Button>
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
                className="inline-flex h-6 items-center rounded-md border px-2 text-xs hover:bg-muted"
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
