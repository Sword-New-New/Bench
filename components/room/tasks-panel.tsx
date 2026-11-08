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
import type { PublicAgent, Task } from "@/lib/types"

export function TasksPanel({
  tasks,
  agents,
  highlightId,
  busy,
  onCreate,
  onAskHandoff,
  onStatus,
}: {
  tasks: Task[]
  agents: PublicAgent[]
  highlightId: string | null
  busy: boolean
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
      <div className="px-4 py-3">
        <h2 className="text-sm font-medium">分工</h2>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          同一阶段一个负责人。交接时写清对方需要的上下文。
        </p>
      </div>
      <form
        className="space-y-2 px-3 pb-3"
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
          placeholder="这阶段要交出来的东西"
          aria-label="任务标题"
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
          <Button type="submit" disabled={busy || title.trim().length === 0}>
            派出去
          </Button>
        </div>
      </form>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 pb-4">
        {tasks.length === 0 ? (
          <div className="rounded-xl border border-dashed px-3 py-4 text-sm leading-6 text-muted-foreground">
            还没有分工。你建一条任务并指定负责人，或在对话里用 @名字 把活递过去。
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
          <details className="rounded-xl border px-3 py-2">
            <summary className="cursor-pointer text-sm text-muted-foreground">
              完成的 {done.length}
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
      className="rounded-xl border bg-card px-3 py-3"
      style={highlight ? { outline: "2px solid #1f1a14", outlineOffset: 1 } : undefined}
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-sm font-medium leading-5">{task.title}</h3>
        <span className="shrink-0 text-xs text-muted-foreground">
          {TASK_STATUS_LABEL[task.status]}
        </span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {task.ownerName ? `负责人 ${task.ownerName}` : "还没有负责人"}
        {" · "}
        {task.createdByName} 建立
      </p>
      {task.history.length > 0 ? (
        <ol className="mt-2 space-y-1 text-xs leading-5 text-muted-foreground">
          {task.history.slice(-3).map((event, index) => (
            <li key={`${event.at}-${index}`}>
              {event.actor} {event.action}
              {event.note ? `：${event.note}` : ""}
            </li>
          ))}
        </ol>
      ) : null}
      {task.status !== "done" ? (
        <div className="mt-3 flex flex-wrap gap-1.5">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => onStatus(task, "done")}
          >
            完成
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => onStatus(task, "block")}
          >
            卡住
          </Button>
          {others.length > 0 ? (
            <DropdownMenu>
              <DropdownMenuTrigger
                className="inline-flex h-7 items-center rounded-lg border px-2.5 text-[0.8rem] hover:bg-muted"
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
