"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"

import { AdaptersDialog } from "@/components/room/adapters-dialog"
import { Composer } from "@/components/room/composer"
import { JoinDialog } from "@/components/room/join-dialog"
import { Mark } from "@/components/room/bits"
import { Roster } from "@/components/room/roster"
import { TasksPanel } from "@/components/room/tasks-panel"
import { Thread } from "@/components/room/thread"
import { api } from "@/components/room/api"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { ago, STATUS_LABEL } from "@/lib/status"
import type { Message, PublicAgent, RoomSnapshot, Task } from "@/lib/types"

type TabId = "chat" | "people" | "tasks"

export function RoomApp() {
  const [room, setRoom] = useState<RoomSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [live, setLive] = useState(false)
  const [now, setNow] = useState(0)
  const [tab, setTab] = useState<TabId>("chat")
  const [draft, setDraft] = useState("")
  const [reply, setReply] = useState<Message | null>(null)
  const [focusId, setFocusId] = useState<string | null>(null)
  const [joinOpen, setJoinOpen] = useState(false)
  const [adaptersOpen, setAdaptersOpen] = useState(false)
  const [adapterName, setAdapterName] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [leaving, setLeaving] = useState<PublicAgent | null>(null)
  const [handoff, setHandoff] = useState<{ task: Task; agent: PublicAgent } | null>(null)
  const [note, setNote] = useState("")
  const [highlight, setHighlight] = useState<string | null>(null)
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const pullRef = useRef<() => void>(() => {})

  const apply = useCallback((next: RoomSnapshot) => {
    setRoom((current) => (current && next.rev < current.rev ? current : next))
  }, [])

  useEffect(() => {
    let stopped = false
    const pull = () => {
      api<RoomSnapshot>("/api/v1/room")
        .then((data) => {
          if (stopped) return
          apply(data)
          setLive(true)
          setError(null)
        })
        .catch((err: unknown) => {
          if (stopped) return
          setLive(false)
          setError(err instanceof Error ? err.message : "房间没有打开")
        })
    }
    pullRef.current = pull
    pull()
    const poll = setInterval(pull, 4000)
    const source = new EventSource("/api/v1/stream")
    source.onmessage = (event) => {
      try {
        apply(JSON.parse(event.data) as RoomSnapshot)
        setLive(true)
      } catch {
        setLive(false)
      }
    }
    source.onerror = () => setLive(false)
    const tick = () => setNow(Date.now())
    tick()
    const clock = setInterval(tick, 10000)
    return () => {
      stopped = true
      clearInterval(poll)
      clearInterval(clock)
      source.close()
    }
  }, [apply])

  const agents = room?.agents ?? []
  const names = agents.map((agent) => agent.name)
  const focusAgent = agents.find((agent) => agent.id === focusId) ?? null
  const visibleMessages = useMemo(() => {
    const messages = room?.messages ?? []
    if (!focusAgent) return messages
    return messages.filter((message) => {
      if (message.kind === "system") return false
      if (message.authorId === focusAgent.id) return true
      if (message.mentions.includes(focusAgent.id)) return true
      if (message.handoff?.fromId === focusAgent.id || message.handoff?.toId === focusAgent.id) {
        return true
      }
      return false
    })
  }, [room?.messages, focusAgent])

  const seated = agents.filter((agent) => agent.status !== "offline").length
  const working = agents.filter((agent) => agent.status === "working").length
  const demoSeated = agents.some((agent) => agent.demo)

  async function run(action: () => Promise<void>, success?: string) {
    setBusy(true)
    try {
      await action()
      if (success) toast.success(success)
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "没做成")
    } finally {
      setBusy(false)
    }
  }

  function mention(name: string) {
    setDraft((current) => `${current}${current && !/\s$/.test(current) ? " " : ""}@${name} `)
    setTab("chat")
    requestAnimationFrame(() => composerRef.current?.focus())
  }

  function openTask(taskId: string) {
    setTab("tasks")
    setHighlight(taskId)
    requestAnimationFrame(() => {
      document.getElementById(`task-${taskId}`)?.scrollIntoView({ block: "center" })
    })
    window.setTimeout(() => {
      setHighlight((current) => (current === taskId ? null : current))
    }, 2200)
  }

  if (!room && error) {
    return (
      <main className="flex h-dvh flex-col items-start justify-center gap-4 px-6">
        <Mark />
        <h1 className="font-heading text-3xl">房间没有打开</h1>
        <p className="max-w-md text-sm leading-6 text-muted-foreground">{error}</p>
        <Button type="button" onClick={() => pullRef.current()}>
          再试一次
        </Button>
      </main>
    )
  }

  return (
    <main className="flex h-dvh flex-col bg-background">
      <header className="border-b px-4 py-3 md:px-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Mark />
              <h1 className="font-heading text-2xl leading-none">并坐</h1>
            </div>
            <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">
              同一台电脑上的 agent 共用这间房间。模型各做各的，进度和交接写在这里。
            </p>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-2">
            <Button type="button" onClick={() => setJoinOpen(true)}>
              接入说明
            </Button>
            <p className="text-xs text-muted-foreground">
              {room ? `${seated} 人在席 · ${working} 人在做` : "正在打开"}
              {" · "}
              {live ? "已接上" : "正在重连"}
            </p>
          </div>
        </div>
        <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
          {agents.length === 0 ? (
            <p className="text-xs text-muted-foreground">还没有人报进度。</p>
          ) : (
            agents.map((agent) => (
              <button
                key={agent.id}
                type="button"
                className="shrink-0 rounded-full border bg-card px-3 py-1 text-left text-xs"
                onClick={() => mention(agent.name)}
              >
                <span className="font-medium" style={{ color: agent.color }}>
                  {agent.name}
                </span>
                <span className="text-muted-foreground">
                  {" "}
                  {STATUS_LABEL[agent.status]} · {agent.doing || ago(agent.lastSeenAt, now)}
                </span>
              </button>
            ))
          )}
        </div>
      </header>

      <div className="border-b px-3 py-2 md:hidden">
        <Tabs value={tab} onValueChange={(value) => setTab(value as TabId)}>
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="chat">对话</TabsTrigger>
            <TabsTrigger value="people">队友</TabsTrigger>
            <TabsTrigger value="tasks">分工</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {!room ? (
        <div className="grid min-h-0 flex-1 gap-3 p-4 md:grid-cols-3">
          {["席位", "对话", "任务"].map((label) => (
            <div key={label} className="animate-pulse rounded-xl bg-muted p-4 text-sm text-muted-foreground">
              正在打开{label}
            </div>
          ))}
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)] md:grid-cols-[280px_minmax(0,1fr)_320px]">
          <aside className={tab === "people" ? "h-full min-h-0 overflow-hidden md:border-r" : "hidden h-full min-h-0 overflow-hidden md:block md:border-r"}>
            <Roster
              agents={agents}
              now={now}
              focusId={focusId}
              demoSeated={demoSeated}
              busy={busy}
              onMention={mention}
              onFocus={setFocusId}
              onLeave={setLeaving}
              onConfigure={(name) => {
                setAdapterName(name)
                setAdaptersOpen(true)
              }}
              onSeat={() =>
                void run(async () => {
                  const result = await api<{ created: string[]; skipped: string[] }>("/api/v1/demo", {
                    method: "POST",
                    body: JSON.stringify({ action: "seat" }),
                  })
                  if (result.created.length === 0 && result.skipped.length > 0) {
                    toast.message(`${result.skipped.join("、")} 已经是真席位`)
                  } else if (result.created.length === 0) {
                    toast.message("演示已经在座")
                  }
                })
              }
              onDismiss={() =>
                void run(
                  () => api("/api/v1/demo", { method: "POST", body: JSON.stringify({ action: "dismiss" }) }).then(() => undefined),
                  "演示已离席",
                )
              }
            />
          </aside>
          <section className={tab === "chat" ? "flex h-full min-h-0 flex-col" : "hidden h-full min-h-0 md:flex md:flex-col"}>
            {error ? (
              <p className="border-b bg-destructive/10 px-4 py-2 text-xs text-destructive">
                {error} 正在重试。
              </p>
            ) : null}
            <Thread
              messages={visibleMessages}
              names={names}
              focusName={focusAgent?.name ?? null}
              onClearFocus={() => setFocusId(null)}
              onReply={setReply}
              onOpenTask={openTask}
              onExample={(text) => {
                setDraft(text)
                requestAnimationFrame(() => composerRef.current?.focus())
              }}
            />
            <Composer
              agents={agents}
              value={draft}
              reply={reply}
              busy={busy}
              inputRef={composerRef}
              onChange={setDraft}
              onClearReply={() => setReply(null)}
              onSend={() => {
                const text = draft.trim()
                if (!text) return
                const replyTo = reply?.id
                void run(async () => {
                  await api("/api/v1/say", {
                    method: "POST",
                    body: JSON.stringify({ as: "human", text, replyTo }),
                  })
                  setDraft("")
                  setReply(null)
                })
              }}
            />
          </section>
          <aside className={tab === "tasks" ? "h-full min-h-0 overflow-hidden md:border-l" : "hidden h-full min-h-0 overflow-hidden md:block md:border-l"}>
            <TasksPanel
              tasks={room.tasks}
              agents={agents}
              highlightId={highlight}
              busy={busy}
              onCreate={(title, ownerId) =>
                void run(() =>
                  api("/api/v1/tasks", {
                    method: "POST",
                    body: JSON.stringify({
                      as: "human",
                      title,
                      owner: ownerId ?? undefined,
                    }),
                  }).then(() => undefined),
                )
              }
              onAskHandoff={(task, agent) => {
                setHandoff({ task, agent })
                setNote(`「${task.title}」交给你。需要的上下文：`)
              }}
              onStatus={(task, action) =>
                void run(() =>
                  api(`/api/v1/tasks/${task.id}`, {
                    method: "POST",
                    body: JSON.stringify({ as: "human", action }),
                  }).then(() => undefined),
                )
              }
            />
          </aside>
        </div>
      )}

      <AdaptersDialog
        open={adaptersOpen}
        agents={agents}
        focusName={adapterName}
        busy={busy}
        onOpenChange={setAdaptersOpen}
        onSave={(next) =>
          run(async () => {
            await api("/api/v1/adapters", {
              method: "POST",
              body: JSON.stringify({ as: "human", agents: next }),
            })
            setAdaptersOpen(false)
          }, "唤起命令已保存")
        }
      />

      <JoinDialog
        open={joinOpen}
        busy={busy}
        onOpenChange={setJoinOpen}
        onReset={() =>
          void run(async () => {
            await api("/api/v1/reset", {
              method: "POST",
              body: JSON.stringify({ confirm: "清空" }),
            })
            setJoinOpen(false)
            setFocusId(null)
            setReply(null)
          }, "房间已清空")
        }
      />

      <Dialog open={leaving !== null} onOpenChange={(open) => !open && setLeaving(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>请 {leaving?.name} 离席</DialogTitle>
            <DialogDescription>
              这个席位会从房间消失。它名下还没做完的任务会先停着，等别人接手。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setLeaving(null)}>
              留下
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={busy || !leaving}
              onClick={() => {
                const agent = leaving
                if (!agent) return
                void run(async () => {
                  await api("/api/v1/leave", {
                    method: "POST",
                    body: JSON.stringify({ as: "human", agentId: agent.id }),
                  })
                  setLeaving(null)
                  if (focusId === agent.id) setFocusId(null)
                })
              }}
            >
              离席
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={handoff !== null} onOpenChange={(open) => !open && setHandoff(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>交给 {handoff?.agent.name}</DialogTitle>
            <DialogDescription>
              {handoff ? `「${handoff.task.title}」换负责人。写上对方接着做需要知道的上下文。` : ""}
            </DialogDescription>
          </DialogHeader>
          <Label htmlFor="handoff-note" className="sr-only">
            交接说明
          </Label>
          <Textarea
            id="handoff-note"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            className="min-h-24"
          />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setHandoff(null)}>
              取消
            </Button>
            <Button
              type="button"
              disabled={busy || !handoff}
              onClick={() => {
                if (!handoff) return
                void run(async () => {
                  await api(`/api/v1/tasks/${handoff.task.id}`, {
                    method: "POST",
                    body: JSON.stringify({
                      as: "human",
                      action: "handoff",
                      to: handoff.agent.id,
                      note: note.trim() || `交给 ${handoff.agent.name}`,
                    }),
                  })
                  setHandoff(null)
                  setNote("")
                })
              }}
            >
              交出去
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  )
}
