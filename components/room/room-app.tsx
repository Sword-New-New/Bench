"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ListTodo, MessageSquare, Monitor, Moon, Plug, Sun, Users } from "lucide-react"
import { useTheme } from "next-themes"
import { toast } from "sonner"

import { AdaptersDialog } from "@/components/room/adapters-dialog"
import { Composer } from "@/components/room/composer"
import { Ambient } from "@/components/room/ambient"
import { JoinDialog } from "@/components/room/join-dialog"
import { Mark } from "@/components/room/bits"
import { Roster } from "@/components/room/roster"
import { TasksPanel } from "@/components/room/tasks-panel"
import { Thread } from "@/components/room/thread"
import { api, type AdapterInfo } from "@/components/room/api"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
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
  const [adapters, setAdapters] = useState<AdapterInfo[] | null>(null)
  const { theme, setTheme } = useTheme()
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
    let streaming = false
    // The stream is the main feed; polling only covers the gaps while it reconnects.
    const poll = setInterval(() => {
      if (!streaming) pull()
    }, 4000)
    const source = new EventSource("/api/v1/stream")
    source.onopen = () => {
      streaming = true
    }
    source.onmessage = (event) => {
      try {
        apply(JSON.parse(event.data) as RoomSnapshot)
        streaming = true
        setLive(true)
        setError(null)
      } catch {
        setLive(false)
      }
    }
    source.onerror = () => {
      streaming = false
      setLive(false)
    }
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

  const loadAdapters = useCallback(() => {
    api<{ agents: AdapterInfo[] }>("/api/v1/adapters")
      .then((data) => setAdapters(Array.isArray(data.agents) ? data.agents : []))
      .catch(() => setAdapters([]))
  }, [])

  useEffect(() => {
    loadAdapters()
  }, [loadAdapters])

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
      <main className="flex h-dvh flex-col items-center justify-center gap-4 px-6 text-center">
        <Mark className="size-10" />
        <h1 className="text-2xl font-semibold">房间没有打开</h1>
        <p className="max-w-md text-sm leading-6 text-muted-foreground">{error}</p>
        <Button type="button" onClick={() => pullRef.current()}>
          再试一次
        </Button>
      </main>
    )
  }

  const tabs: { id: TabId; label: string; icon: typeof Users }[] = [
    { id: "people", label: "入口", icon: Users },
    { id: "chat", label: "对话", icon: MessageSquare },
    { id: "tasks", label: "分工", icon: ListTodo },
  ]
  const openTasks = room?.tasks.filter((task) => task.status !== "done").length ?? 0

  return (
    <main className="relative isolate flex h-dvh flex-col">
      <Ambient />
      <div className="shrink-0 px-2 pt-2">
      <header className="raised flex h-12 items-center gap-3 rounded-2xl pr-2 pl-3">
        <Mark />
        <div className="min-w-0">
          <h1 className="text-[15px] leading-tight font-semibold">并坐</h1>
          <p className="hidden truncate text-xs text-muted-foreground sm:block">一个入口，叫到每一个 AI</p>
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          <span
            className="pill mr-1 hidden items-center gap-1.5 rounded-full px-2.5 py-1 text-xs text-muted-foreground sm:flex"
            title={live ? "实时连接正常" : "正在重连"}
          >
            <span className={`size-1.5 rounded-full ${live ? "bg-emerald-500" : "animate-pulse bg-amber-500"}`} />
            {room ? `${seated} 在线 · ${working} 在做` : "正在打开"}
          </span>
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button type="button" variant="ghost" size="icon-sm" aria-label="深浅色" />}>
              {now > 0 && theme === "dark" ? <Moon /> : now > 0 && theme === "light" ? <Sun /> : <Monitor />}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-32">
              <DropdownMenuRadioGroup value={theme ?? "system"} onValueChange={(value) => setTheme(value)}>
                <DropdownMenuRadioItem value="light" closeOnClick>
                  <Sun />
                  浅色
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="dark" closeOnClick>
                  <Moon />
                  深色
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="system" closeOnClick>
                  <Monitor />
                  跟随系统
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button type="button" size="sm" className="rounded-full" onClick={() => setJoinOpen(true)}>
            <Plug />
            接入说明
          </Button>
        </div>
      </header>
      </div>

      {!room ? (
        <div className="grid min-h-0 flex-1 gap-2 p-2 lg:grid-cols-[272px_1fr_320px]">
          {["入口", "对话", "分工"].map((label) => (
            <div key={label} className="frost animate-pulse rounded-2xl p-4 text-sm text-muted-foreground">
              正在打开{label}
            </div>
          ))}
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)] pt-2 lg:grid-cols-[272px_minmax(0,1fr)_320px] lg:gap-2 lg:p-2">
          <aside className={`${tab === "people" ? "block" : "hidden"} frost h-full min-h-0 overflow-hidden lg:block lg:rounded-2xl`}>
            <Roster
              agents={agents}
              adapters={adapters}
              now={now}
              focusId={focusId}
              demoSeated={demoSeated}
              busy={busy}
              onMention={mention}
              onFocus={(id) => {
                setFocusId(id)
                setTab("chat")
              }}
              onLeave={setLeaving}
              onJoin={() => setJoinOpen(true)}
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
                  "演示已撤下",
                )
              }
            />
          </aside>
          <section className={`${tab === "chat" ? "flex" : "hidden"} relative h-full min-h-0 flex-col lg:flex`}>
            {error ? (
              <p className="mx-3 rounded-xl bg-destructive/10 px-4 py-2 text-xs text-destructive">{error} 正在重试。</p>
            ) : null}
            <Thread
              messages={visibleMessages}
              agents={agents}
              names={names}
              focusName={focusAgent?.name ?? null}
              onClearFocus={() => setFocusId(null)}
              onReply={(message) => {
                setReply(message)
                requestAnimationFrame(() => composerRef.current?.focus())
              }}
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
          <aside className={`${tab === "tasks" ? "block" : "hidden"} frost h-full min-h-0 overflow-hidden lg:block lg:rounded-2xl`}>
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

      <nav className="frost grid shrink-0 grid-cols-3 lg:hidden">
        {tabs.map((item) => {
          const Icon = item.icon
          const on = tab === item.id
          return (
            <button
              key={item.id}
              type="button"
              className={`flex flex-col items-center gap-0.5 py-2 text-[11px] ${on ? "text-foreground" : "text-muted-foreground"}`}
              onClick={() => setTab(item.id)}
              aria-current={on ? "page" : undefined}
            >
              <Icon className="size-5" />
              <span>
                {item.label}
                {item.id === "tasks" && openTasks > 0 ? ` ${openTasks}` : ""}
              </span>
            </button>
          )
        })}
      </nav>

      <AdaptersDialog
        open={adaptersOpen}
        agents={agents}
        adapters={adapters}
        focusName={adapterName}
        busy={busy}
        onOpenChange={setAdaptersOpen}
        onSave={(next) =>
          run(async () => {
            const saved = await api<{ agents: AdapterInfo[] }>("/api/v1/adapters", {
              method: "POST",
              body: JSON.stringify({ as: "human", agents: next }),
            })
            setAdapters(saved.agents)
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
