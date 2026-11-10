"use client"

import { type ComponentProps, startTransition, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import { Gauge, ListTodo, MessageSquare, Monitor, Moon, Plug, Settings, Sparkles, Sun, TerminalSquare, Users } from "lucide-react"
import { useTheme } from "next-themes"
import { toast } from "sonner"

import { AdaptersDialog } from "@/components/room/adapters-dialog"
import { Composer } from "@/components/room/composer"
import { draft, useDraft } from "@/components/room/draft"
import { Ambient } from "@/components/room/ambient"
import { JoinDialog } from "@/components/room/join-dialog"
import { Mark } from "@/components/room/bits"
import { Roster } from "@/components/room/roster"
import { RunPanel } from "@/components/room/run-panel"
import { PermitBar } from "@/components/room/permits"
import { clearSummarySnooze, SUMMARY_DONE_DEMO, SummaryCard, SummaryNudge } from "@/components/room/summary"
import { DEBUG_MENU, DebugMenu, NO_DEBUG, withDebug, type DebugView } from "@/components/room/debug-menu"
import { TasksPanel } from "@/components/room/tasks-panel"
import { EDIT_EVENT, LIVE_DEMO, Thread } from "@/components/room/thread"
import { Tour, TOUR_JOIN, TOUR_START } from "@/components/room/tour"
import { SPEED_OPEN, SpeedPanel } from "@/components/room/speed-panel"
import { WhisperDialog } from "@/components/room/whisper-dialog"
import { CommitDialog } from "@/components/room/commit-dialog"
import { GOTO_EVENT, type Goto } from "@/components/room/refs"
import { SpawnDialog } from "@/components/room/spawn-dialog"
import { type Pending } from "@/components/room/attachments"
import { api, inOpenProject, setOpenProject, storedHumanKey, type AdapterInfo } from "@/components/room/api"
import { ModelDialog } from "@/components/room/model-field"
import { ProjectDialog, ProjectMenu, ProjectPlace } from "@/components/room/project-menu"
import { ProjectRail } from "@/components/room/project-rail"
import { smashProject } from "@/components/room/project-wreck"
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
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { KINDS } from "@/lib/kinds"
import type { Message, Project, ProjectInfo, PublicAgent, RoomSnapshot, Task } from "@/lib/types"

type TabId = "chat" | "people" | "tasks"

// 「摘要 / 详细」 for the thread, remembered in this browser.
const DETAIL_KEY = "bench-thread-detail"
const DETAIL_EVENT = "bench-thread-detail"

// Kept here too, for when the browser won't let the page store anything.
let detailNow = false

function detailSaved() {
  try {
    const saved = localStorage.getItem(DETAIL_KEY)
    return saved === null ? detailNow : saved === "1"
  } catch {
    return detailNow
  }
}

function onDetailChange(callback: () => void) {
  window.addEventListener(DETAIL_EVENT, callback)
  return () => window.removeEventListener(DETAIL_EVENT, callback)
}

function showDetail(value: boolean) {
  detailNow = value
  try {
    localStorage.setItem(DETAIL_KEY, value ? "1" : "0")
  } catch {}
  window.dispatchEvent(new Event(DETAIL_EVENT))
}

// Kinds the room can open a session of itself (lib/spawn.ts SPAWNABLE).
const SPAWNABLE_KINDS = KINDS.filter((kind) => kind.spawn).map((kind) => kind.id)

// The project last open in this browser, and the one a link names.
const PROJECT_KEY = "bench-project"

function projectWanted() {
  const linked = new URLSearchParams(window.location.search).get("project")
  if (linked) return linked
  try {
    return localStorage.getItem(PROJECT_KEY)
  } catch {
    return null
  }
}

function rememberProject(id: string) {
  try {
    localStorage.setItem(PROJECT_KEY, id)
  } catch {}
  const url = new URL(window.location.href)
  url.searchParams.set("project", id)
  window.history.replaceState(null, "", url)
}

export function RoomApp() {
  const [projects, setProjects] = useState<Project[] | null>(null)
  const [projectId, setProjectId] = useState<string | null>(null)
  const [projectDialog, setProjectDialog] = useState<{ editing: ProjectInfo | null } | null>(null)
  const [actual, setRoom] = useState<RoomSnapshot | null>(null)
  const [debug, setDebug] = useState<DebugView>(NO_DEBUG)
  // What the page shows: the room, with any debug-menu overrides on top.
  const room = useMemo(() => actual && withDebug(actual, debug), [actual, debug])
  const [error, setError] = useState<string | null>(null)
  const [live, setLive] = useState(false)
  const [now, setNow] = useState(0)
  const [tab, setTab] = useState<TabId>("chat")
  // The composer's text lives in its own store (draft.ts, draft.set below),
  // so typing doesn't redraw the room.
  // 「重新编辑」 on a recalled message puts its words back in the composer.
  useEffect(() => {
    const edit = (event: Event) => {
      const text = (event as CustomEvent<string>).detail
      if (typeof text === "string") draft.set(text)
    }
    window.addEventListener(EDIT_EVENT, edit)
    return () => window.removeEventListener(EDIT_EVENT, edit)
  }, [])
  const [reply, setReply] = useState<Message | null>(null)
  const [focusId, setFocusId] = useState<string | null>(null)
  const [joinOpen, setJoinOpen] = useState(false)
  const [joinKind, setJoinKind] = useState<string | null>(null)
  // The tour opens and closes the real 接入 dialog for its steps.
  useEffect(() => {
    const onTour = (event: Event) => {
      setJoinKind(null)
      setJoinOpen(Boolean((event as CustomEvent<boolean>).detail))
    }
    window.addEventListener(TOUR_JOIN, onTour)
    return () => window.removeEventListener(TOUR_JOIN, onTour)
  }, [])
  const [runId, setRunId] = useState<string | null>(null)
  const [whisperId, setWhisperId] = useState<string | null>(null)
  // The seat whose model is being picked (「换模型…」).
  const [modelId, setModelId] = useState<string | null>(null)
  const detail = useSyncExternalStore(onDetailChange, detailSaved, () => false)
  // No key in this browser: whatever the user does here is refused.
  const keyless = useSyncExternalStore(noSubscribe, () => !storedHumanKey(), () => false)
  const [spawn, setSpawn] = useState<{ kind: string; from: PublicAgent | null } | null>(null)
  const [adaptersOpen, setAdaptersOpen] = useState(false)
  const [adapterName, setAdapterName] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [leaving, setLeaving] = useState<PublicAgent | null>(null)
  const [renaming, setRenaming] = useState<PublicAgent | null>(null)
  const [files, setFiles] = useState<Pending[]>([])
  const [newName, setNewName] = useState("")
  const [handoff, setHandoff] = useState<{ task: Task; agent: PublicAgent } | null>(null)
  const [note, setNote] = useState("")
  const [highlight, setHighlight] = useState<string | null>(null)
  const [adapters, setAdapters] = useState<AdapterInfo[] | null>(null)
  const { theme, setTheme } = useTheme()
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const pullRef = useRef<() => void>(() => {})

  const loadProjects = useCallback(() => {
    return api<{ projects: Project[] }>("/api/v1/projects").then((data) => {
      setProjects(data.projects)
      setProjectId((current) => {
        const ids = data.projects.map((item) => item.id)
        if (current && ids.includes(current)) return current
        const wanted = current ? null : projectWanted()
        const byName = wanted ? data.projects.find((item) => item.name === wanted)?.id : undefined
        return wanted && ids.includes(wanted) ? wanted : (byName ?? ids[0] ?? null)
      })
      return data.projects
    })
  }, [])

  // The list (with who is online in each) is small; a poll keeps it current.
  useEffect(() => {
    const first = setTimeout(() => void loadProjects().catch(() => {}), 0)
    const timer = setInterval(() => void loadProjects().catch(() => {}), 5000)
    return () => {
      clearTimeout(first)
      clearInterval(timer)
    }
  }, [loadProjects])

  // Switching projects keeps the old room on screen until the new one's
  // snapshot arrives, then swaps both in one transition: the bench and the
  // roster change in the same commit, so the seats fly between them
  // (components/room/project-rail.tsx).
  const openProject = useCallback((id: string) => {
    setProjectId((current) => {
      if (current !== id) {
        setFocusId(null)
        setReply(null)
        draft.set("")
      }
      return id
    })
  }, [])

  // The project whose room is on screen (committed). Until the new project's
  // room is, every snapshot of it goes in as a transition: the first one often
  // arrives twice (the pull and the stream), and a plain update would commit it
  // without the flight.
  const shown = useRef<string | null>(null)
  useEffect(() => {
    shown.current = room?.project.id ?? null
  }, [room])
  const apply = useCallback(
    (next: RoomSnapshot) => {
      if (next.project.id !== projectId) return
      const update = () =>
        setRoom((current) => (current && current.project.id === next.project.id && next.rev < current.rev ? current : next))
      if (shown.current && shown.current !== next.project.id) startTransition(update)
      else update()
    },
    [projectId],
  )

  useEffect(() => {
    if (!projectId) return
    setOpenProject(projectId)
    rememberProject(projectId)
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
    const source = new EventSource(inOpenProject("/api/v1/stream"))
    source.onopen = () => {
      streaming = true
    }
    // The stream repeats the room every few seconds so a seat that went quiet
    // shows as offline; when nothing differs there is nothing to parse or draw.
    let lastText = ""
    source.onmessage = (event) => {
      if (event.data === lastText) {
        streaming = true
        setLive(true)
        return
      }
      lastText = event.data
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
  }, [apply, projectId])

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

  async function debugCall(body: Record<string, unknown>) {
    await api("/api/v1/debug", { method: "POST", body: JSON.stringify({ as: "human", ...body }) })
  }

  async function summaryCall(body: Record<string, unknown>) {
    await api("/api/v1/summary", { method: "POST", body: JSON.stringify({ as: "human", ...body }) })
  }

  function mention(name: string) {
    draft.set((current) => `${current}${current && !/\s$/.test(current) ? " " : ""}@${name} `)
    setTab("chat")
    requestAnimationFrame(() => composerRef.current?.focus())
  }

  // A task id clicked in a message (components/room/refs.ts).
  const openTaskRef = useRef(openTask)
  const tasksRef = useRef(room?.tasks)
  useEffect(() => {
    openTaskRef.current = openTask
    tasksRef.current = room?.tasks
  })
  useEffect(() => {
    const onGoto = (event: Event) => {
      const { kind, id } = (event as CustomEvent<Goto>).detail
      if (kind !== "task") return
      if (tasksRef.current && !tasksRef.current.some((task) => task.id === id)) {
        toast("这个项目里没有这条待办")
        return
      }
      openTaskRef.current(id)
    }
    window.addEventListener(GOTO_EVENT, onGoto)
    return () => window.removeEventListener(GOTO_EVENT, onGoto)
  }, [])

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
    { id: "tasks", label: "待办", icon: ListTodo },
  ]
  const openTasks = room?.tasks.filter((task) => task.status !== "done").length ?? 0
  const currentProject = room?.project ?? projects?.find((item) => item.id === projectId) ?? null

  return (
    <main className="relative isolate flex h-dvh flex-col">
      <Ambient />
      <Tour />
      <SpeedPanel />
      {keyless ? (
        <p role="alert" className="shrink-0 bg-destructive px-4 py-2 text-center text-sm text-white">
          这个页面没有口令，发消息、批准权限这些操作都会被拒。用 <code>npm run open</code> 或桌面上的「并坐」图标重新打开一次，之后就不用了。
        </p>
      ) : null}
      <div className="flex min-h-0 flex-1">
      <ProjectRail
        projects={projects ?? []}
        current={room?.project.id ?? projectId}
        onPick={openProject}
        onCreate={() => setProjectDialog({ editing: null })}
        onEdit={(project) => setProjectDialog({ editing: project })}
      />
      <div className="flex min-w-0 flex-1 flex-col">
      <div className="shrink-0 px-3 pt-2 lg:px-4 lg:pl-1">
      <header className="flex h-12 items-center gap-3 pr-1 pl-1">
        <Mark />
        <h1 className="sr-only">并坐</h1>
        <div className="min-w-0" data-tour="project">
          {/* From lg the project rail switches, creates and opens settings, so
              the header only says where this one lives. */}
          <div className="lg:hidden">
            <ProjectMenu
              projects={projects ?? []}
              current={currentProject}
              onPick={openProject}
              onCreate={() => setProjectDialog({ editing: null })}
              onEdit={() => room && setProjectDialog({ editing: room.project })}
            />
          </div>
          <ProjectPlace project={currentProject} />
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          <span
            className="pill mr-1 hidden items-center gap-1.5 rounded-full px-2.5 py-1 text-xs text-muted-foreground sm:flex"
            title={live ? "实时连接正常" : "正在重连"}
          >
            <span className={`size-1.5 rounded-full ${live ? "bg-emerald-500" : "animate-pulse bg-amber-500"}`} />
            {room ? `${seated} 在线 · ${working} 在做` : "正在打开"}
          </span>
          {DEBUG_MENU ? (
            <DebugMenu
              view={debug}
              agents={agents}
              busy={busy}
              onView={setDebug}
              onNote={(kind) => void run(() => debugCall({ action: "note", kind }))}
              onForget={(agent) =>
                void run(() => debugCall({ action: "forget", agentId: agent.id }), `${agent.name} 下次被叫醒会收到全部积压`)
              }
              onClearSummary={() => void run(() => debugCall({ action: "clearSummary", confirm: "清空摘要" }), "摘要清空了")}
              onSummaryDone={() => window.dispatchEvent(new Event(SUMMARY_DONE_DEMO))}
              onLiveDemo={() => window.dispatchEvent(new Event(LIVE_DEMO))}
              onTour={() => window.dispatchEvent(new Event(TOUR_START))}
              onClearSnooze={() => {
                clearSummarySnooze()
                toast.success("「稍后提醒」清掉了")
              }}
            />
          ) : null}
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button type="button" variant="ghost" size="icon-sm" aria-label="设置" data-tour="settings" />}>
              <Settings />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-44">
              <DropdownMenuGroup>
                <DropdownMenuLabel>深浅色</DropdownMenuLabel>
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
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => {
                  setAdapterName(null)
                  setAdaptersOpen(true)
                }}
              >
                <TerminalSquare />
                唤起命令…
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => window.dispatchEvent(new Event(TOUR_START))}>
                <Sparkles />
                新手引导
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => window.dispatchEvent(new Event(SPEED_OPEN))}>
                <Gauge />
                Token 测速台
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            type="button"
            size="sm"
            className="rounded-full"
            data-tour="join"
            onClick={() => {
              setJoinKind(null)
              setJoinOpen(true)
            }}
          >
            <Plug />
            接入说明
          </Button>
        </div>
      </header>
      </div>

      {!room ? (
        <div className="grid min-h-0 flex-1 gap-4 p-3 lg:grid-cols-[264px_1fr_300px] lg:px-4 lg:pl-1 lg:pt-1 lg:pb-4">
          {["入口", "对话", "待办"].map((label) => (
            <div key={label} className="frost animate-pulse rounded-2xl p-4 text-sm text-muted-foreground">
              正在打开{label}
            </div>
          ))}
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)] pt-2 lg:grid-cols-[264px_minmax(0,1fr)_300px] lg:gap-4 lg:px-4 lg:pl-1 lg:pt-1 lg:pb-4">
          <aside data-tour="roster" className={`${tab === "people" ? "block" : "hidden"} frost h-full min-h-0 overflow-hidden lg:block lg:rounded-2xl`}>
            <Roster
              agents={agents}
              adapters={adapters}
              now={now}
              focusId={focusId}
              busy={busy}
              onMention={mention}
              onFocus={(id) => {
                setFocusId(id)
                setTab("chat")
              }}
              onLeave={setLeaving}
              onRename={(agent) => {
                setNewName(agent.name)
                setRenaming(agent)
              }}
              onOpenRun={setRunId}
              onWhisper={(agent) => setWhisperId(agent.id)}
              onModel={(agent) => setModelId(agent.id)}
              onSpawn={(kind, from) => setSpawn({ kind, from })}
              onStop={(agent) =>
                void run(async () => {
                  const result = await api<{ dropped: number }>(`/api/v1/agents/${agent.id}`, {
                    method: "POST",
                    body: JSON.stringify({ as: "human", action: "stop" }),
                  })
                  toast.success(`${agent.name} 停下了${result.dropped > 0 ? `，排队的 ${result.dropped} 条也取消了` : ""}`)
                })
              }
              onCompact={(agent) =>
                void run(async () => {
                  await api(`/api/v1/agents/${agent.id}`, {
                    method: "POST",
                    body: JSON.stringify({ as: "human", action: "compact" }),
                  })
                  toast.success(`${agent.name} 开始压缩上下文，好了会在群里说一声`)
                })
              }
              onJoin={(kind) => {
                setJoinKind(kind ?? null)
                setJoinOpen(true)
              }}
            />
          </aside>
          <section data-tour="chat" className={`${tab === "chat" ? "flex" : "hidden"} relative h-full min-h-0 flex-col lg:flex`}>
            {error ? (
              <p className="mx-3 rounded-xl bg-destructive/10 px-4 py-2 text-xs text-destructive">{error} 正在重试。</p>
            ) : null}
            <Thread
              // A fresh thread per project: it opens at the bottom of the new
              // room at once, instead of gliding there from the old one's spot.
              key={room.project.id}
              detail={detail}
              onDetail={showDetail}
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
              onOpenRun={setRunId}
              onRewake={(runId) =>
                void run(
                  () =>
                    api(`/api/v1/runs/${runId}`, {
                      method: "POST",
                      body: JSON.stringify({ as: "human", action: "rewake" }),
                    }).then(() => undefined),
                  "叫醒了，会带着原来那些消息接着做",
                )
              }
              onMention={mention}
              onExample={(text) => {
                draft.set(text)
                requestAnimationFrame(() => composerRef.current?.focus())
              }}
            />
            <DraftComposer
              agents={agents}
              reply={reply}
              busy={busy}
              inputRef={composerRef}
              files={files}
              onFiles={setFiles}
              onClearReply={() => setReply(null)}
              notice={
                room ? (
                  <>
                    <PermitBar room={room} />
                    <SummaryNudge
                      room={room}
                      busy={busy}
                      onRequest={(agent) =>
                        void run(
                          () => summaryCall({ action: "request", agentId: agent.id }),
                          `请 ${agent.name} 写摘要了`,
                        )
                      }
                      onSkip={() => void run(() => summaryCall({ action: "skip" }))}
                    />
                  </>
                ) : null
              }
              onSend={() => {
                const text = draft.get().trim()
                if ((!text && files.length === 0) || files.some((item) => item.uploading)) return
                const attachments = files.map(({ kind, name, path }) => ({ kind, name, path }))
                const replyTo = reply?.id
                // Named seats that are busy get this after what they're doing.
                const queued = agents.filter((agent) => agent.runId && text.includes(`@${agent.name}`))
                void run(async () => {
                  await api("/api/v1/say", {
                    method: "POST",
                    body: JSON.stringify({ as: "human", text, replyTo, attachments }),
                  })
                  for (const item of files) if (item.preview) URL.revokeObjectURL(item.preview)
                  setFiles([])
                  draft.set("")
                  setReply(null)
                  if (queued.length > 0) {
                    const first = queued[0]
                    toast.message(`${queued.map((agent) => agent.name).join("、")} 正在忙，这条排在它手上的事后面`, {
                      description: "着急的话单独和它说，会先打断它来回你",
                      action: { label: "单独说", onClick: () => setWhisperId(first.id) },
                    })
                  }
                })
              }}
            />
          </section>
          <aside data-tour="tasks" className={`${tab === "tasks" ? "block" : "hidden"} h-full min-h-0 overflow-hidden lg:block`}>
            <TasksPanel
              tasks={room.tasks}
              agents={agents}
              highlightId={highlight}
              busy={busy}
              header={
                <SummaryCard
                  room={room}
                  busy={busy}
                  onSave={async (text) => {
                    let saved = false
                    await run(async () => {
                      await summaryCall({ action: "edit", text })
                      saved = true
                    }, "摘要存好了")
                    return saved
                  }}
                />
              }
              onCreate={(title, ownerId, steps) =>
                void run(() =>
                  api("/api/v1/tasks", {
                    method: "POST",
                    body: JSON.stringify({
                      as: "human",
                      title,
                      owner: ownerId ?? undefined,
                      steps,
                    }),
                  }).then(() => undefined),
                )
              }
              onStep={(task, step, state) =>
                void run(() =>
                  api(`/api/v1/tasks/${task.id}`, {
                    method: "POST",
                    body: JSON.stringify({ as: "human", action: "step", step, state }),
                  }).then(() => undefined),
                )
              }
              onReview={(task, pass, note) =>
                void run(
                  () =>
                    api(`/api/v1/tasks/${task.id}`, {
                      method: "POST",
                      body: JSON.stringify({ as: "human", action: pass ? "pass" : "reject", note }),
                    }).then(() => undefined),
                  pass ? "验收通过" : "打回了，已经叫醒负责人",
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
              onFork={(task) =>
                void run(
                  () =>
                    api(`/api/v1/tasks/${task.id}`, {
                      method: "POST",
                      body: JSON.stringify({ as: "human", action: "fork" }),
                    }).then(() => undefined),
                  "复制成了一条新待办，原来那条没动",
                )
              }
            />
          </aside>
        </div>
      )}
      </div>
      </div>

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

      <SpawnDialog kind={spawn?.kind ?? null} from={spawn?.from ?? null} agents={agents} onClose={() => setSpawn(null)} />
      <ModelDialog agent={agents.find((agent) => agent.id === modelId) ?? null} onClose={() => setModelId(null)} />
      <CommitDialog />
      <WhisperDialog
        agent={agents.find((agent) => agent.id === whisperId) ?? null}
        onClose={() => setWhisperId(null)}
        onOpenRun={setRunId}
      />
      <RunPanel runId={runId} onClose={() => setRunId(null)} />

      <JoinDialog
        open={joinOpen}
        project={room?.project ?? null}
        preset={joinKind}
        agents={room?.agents ?? []}
        spawnable={SPAWNABLE_KINDS}
        userName={room?.userName ?? "用户"}
        busy={busy}
        onOpenChange={setJoinOpen}
        onSpawn={(kind) => {
          setJoinOpen(false)
          setSpawn({ kind, from: null })
        }}
        onReset={() =>
          void run(async () => {
            await api("/api/v1/reset", {
              method: "POST",
              body: JSON.stringify({ confirm: "清空" }),
            })
            setJoinOpen(false)
            setFocusId(null)
            setReply(null)
          }, "这个项目的记录清空了")
        }
      />
      <ProjectDialog
        open={projectDialog !== null}
        editing={projectDialog?.editing ?? null}
        canDelete={(projects?.length ?? 0) > 1}
        onClose={() => setProjectDialog(null)}
        onSaved={(project, created) => {
          setProjectDialog(null)
          void loadProjects().catch(() => {})
          if (created) {
            openProject(project.id)
            setJoinKind(null)
            setJoinOpen(true)
            toast.success(`「${project.name}」建好了，接几个 AI 进来吧`)
          } else {
            pullRef.current()
            toast.success("项目设置存好了")
          }
        }}
        onDeleted={(id) => {
          // Off the bench with a bang, before the list reload drops the card.
          smashProject(projects?.find((item) => item.id === id))
          setProjectDialog(null)
          // Deleting another project from the rail leaves this one open.
          const next = projects?.find((item) => item.id !== id)
          if (next && id === (room?.project.id ?? projectId)) openProject(next.id)
          void loadProjects().catch(() => {})
          toast.success("项目删掉了")
        }}
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

      <Dialog open={renaming !== null} onOpenChange={(open) => !open && setRenaming(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>给 {renaming?.name} 改名</DialogTitle>
            <DialogDescription>
              点名认的是席位，不是名字：它说过的话和点到它的消息都会换成新名字，别人还写旧名字也能找到它。
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              const agent = renaming
              const name = newName.trim()
              if (!agent || !name || name === agent.name) return
              void run(async () => {
                await api(`/api/v1/agents/${agent.id}`, {
                  method: "POST",
                  body: JSON.stringify({ as: "human", action: "rename", name }),
                })
                setRenaming(null)
              })
            }}
          >
            <Input
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              maxLength={24}
              autoFocus
              aria-label="新名字"
            />
            <DialogFooter className="mt-4">
              <Button type="button" variant="ghost" onClick={() => setRenaming(null)}>
                取消
              </Button>
              <Button type="submit" disabled={busy || !newName.trim() || newName.trim() === renaming?.name}>
                改名
              </Button>
            </DialogFooter>
          </form>
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

// The key never changes while the page is open (components/room/api.ts).
function noSubscribe() {
  return () => {}
}

// The composer, fed from the draft store: only it redraws as you type.
function DraftComposer(props: Omit<ComponentProps<typeof Composer>, "value" | "onChange">) {
  const value = useDraft()
  return <Composer {...props} value={value} onChange={draft.set} />
}
