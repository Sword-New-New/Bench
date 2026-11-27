"use client"

import { type ComponentProps, startTransition, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import { BellRing, FolderOpen, Gauge, ListTodo, MessageSquare, Monitor, Moon, Plug, Settings, SlidersHorizontal, Smartphone, Sparkles, Sun, TerminalSquare, Type, UserRound, Users } from "lucide-react"
import { useTheme } from "next-themes"
import { toast } from "sonner"

import { AdaptersDialog } from "@/components/room/adapters-dialog"
import { NameField } from "@/components/room/name-field"
import { Composer } from "@/components/room/composer"
import { WorkflowsDialog } from "@/components/room/workflows-dialog"
import { draft, useDraft } from "@/components/room/draft"
import { Ambient, FLOW_EVENT, flowOn, setFlow } from "@/components/room/ambient"
import { FONT_SIZES, setFontSize, useFontSize, type FontSizeId } from "@/components/room/font-size"
import { ProjectNotices } from "@/components/room/project-notices"
import { notifyOn, notifySupported, onNotifyChange, setNotify, useProjectNotices } from "@/components/room/notify"
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
import { TerminalDialog } from "@/components/room/terminal-dialog"
import { Trajectory } from "@/components/room/trajectory"
import { WhisperDialog } from "@/components/room/whisper-dialog"
import { CommitDialog } from "@/components/room/commit-dialog"
import { PUSH_OPEN, PushDialog } from "@/components/room/push-dialog"
import { GOTO_EVENT, OPEN_PROJECT_EVENT, goto, openFile, rememberTasks, type Goto, type OpenProject } from "@/components/room/refs"
import { JustSaid } from "@/components/room/progress"
import { digestOf, type Digest } from "@/lib/digest"
import { FlowView } from "@/components/room/flow"
import { flowsOf, namedTasks } from "@/lib/flow"
import { SpawnDialog, type SpawnPreset } from "@/components/room/spawn-dialog"
import { deskSeat, FRONT_ROLE, FRONT_SEAT, FrontBar, FrontButton, rememberBack, useBack } from "@/components/room/front"
import { useSeen } from "@/components/room/project-rail"
import { SeatProfileDialog } from "@/components/room/seat-profile-dialog"
import { type Pending } from "@/components/room/attachments"
import { api, human, inOpenProject, setOpenProject, storedHumanKey, type AdapterInfo } from "@/components/room/api"
import { ModelDialog } from "@/components/room/model-field"
import { ProjectDialog, ProjectMenu, ProjectPlace } from "@/components/room/project-menu"
import { LEFT_TIER, LeftPane } from "@/components/room/left-pane"
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
  DropdownMenuCheckboxItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { FirstOpen } from "@/components/room/first-open"
import { WaitingPanel } from "@/components/room/waiting-panel"
import { parseSlash } from "@/lib/commands"
import { mentionedAgentIds } from "@/lib/text"
import { KINDS } from "@/lib/kinds"
import {
  collectOpenAsks,
  groupLimited,
  isPendingInterrupted,
  type WaitingOverview,
} from "@/lib/waiting-shared"
import type { Message, Project, ProjectInfo, PublicAgent, RoomSnapshot, Task } from "@/lib/types"

type TabId = "chat" | "people" | "tasks"
type SimpleTabId = "chat" | "waiting"

// Two UI layers remembered in this browser (defaults to first/simple layer:
// conversation + 「等你定」; full three-column detail view sits on the second layer).
const LAYER_KEY = "bench-ui-layer"
const LAYER_EVENT = "bench-ui-layer"
type UiLayer = "simple" | "full"
let layerNow: UiLayer = "simple"

function onLayerChange(callback: () => void) {
  window.addEventListener(LAYER_EVENT, callback)
  return () => window.removeEventListener(LAYER_EVENT, callback)
}

function layerSaved(): UiLayer {
  try {
    const saved = localStorage.getItem(LAYER_KEY)
    if (saved === "full" || saved === "simple") layerNow = saved
  } catch {}
  return layerNow
}

function setUiLayer(value: UiLayer) {
  layerNow = value
  try {
    localStorage.setItem(LAYER_KEY, value)
  } catch {}
  window.dispatchEvent(new Event(LAYER_EVENT))
}

// The thread always shows replies by their gist, the full text a click away;
// 「摘要 / 详细」 was taken out on 2026-11-16 (t_d196dffc): at the largest text
// size it crowded the header, and the steps it put in the thread are a click
// away in 「查看过程」 anyway.
const VIEW_EVENT = "bench-thread-view"

function onViewChange(callback: () => void) {
  window.addEventListener(VIEW_EVENT, callback)
  return () => window.removeEventListener(VIEW_EVENT, callback)
}

// 「进展 / 对话 / 流程」 for the thread, remembered in this browser. 「进展」 is
// what you get until you pick another.
type ThreadView = "progress" | "chat" | "flow"
const VIEW_KEY = "bench-thread-view"
let viewNow: ThreadView = "progress"

function viewSaved(): ThreadView {
  try {
    const saved = localStorage.getItem(VIEW_KEY)
    return saved === "flow" || saved === "chat" || saved === "progress" ? saved : viewNow
  } catch {
    return viewNow
  }
}

function showView(value: ThreadView) {
  viewNow = value
  try {
    localStorage.setItem(VIEW_KEY, value)
  } catch {}
  window.dispatchEvent(new Event(VIEW_EVENT))
}

// What the progress tab holds while the page is not drawn.
const EMPTY_DIGEST: Digest = { counts: { you: 0, stuck: 0, doing: 0, done: 0 }, you: [], stuck: [], doing: [], done: [], talk: [] }

// Kinds the room can open a session of itself (lib/spawn.ts SPAWNABLE).
const SPAWNABLE_KINDS = KINDS.filter((kind) => kind.spawn).map((kind) => kind.id)

// The front desk: how its seat is opened. It reads a lot, so the note asks
// for a big window and quota; it needs no project folder, so a scratch one.
const FRONT_KINDS = SPAWNABLE_KINDS
const NO_PROJECTS: Project[] = []
const FRONT_PRESET: SpawnPreset = {
  name: FRONT_SEAT,
  role: FRONT_ROLE,
  mode: "temp",
  kinds: FRONT_KINDS,
  title: "挑一个 AI 来值班",
  note: "前台要读各项目的摘要、待办和对话，挑上下文大、额度宽裕的那家。",
}

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

// How long a snapshot fetched ahead of a switch stays good to use.
const AHEAD_FOR = 4000

function onFlowChange(listener: () => void) {
  window.addEventListener(FLOW_EVENT, listener)
  return () => window.removeEventListener(FLOW_EVENT, listener)
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
  const [tab, setTab] = useState<TabId>("chat")
  const [simpleTab, setSimpleTab] = useState<SimpleTabId>("chat")
  const layer = useSyncExternalStore(onLayerChange, layerSaved, (): UiLayer => "simple")
  const simple = layer === "simple"
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
  const [workflowsOpen, setWorkflowsOpen] = useState(false)
  const [workflowPick, setWorkflowPick] = useState<{ projectId: string; id: string } | null>(null)
  const selectedWorkflow = workflowPick?.projectId === room?.project.id
    ? room?.workflows?.find((item) => item.id === workflowPick?.id) ?? null : null
  const [focusId, setFocusId] = useState<string | null>(null)
  const [joinOpen, setJoinOpen] = useState(false)
  const [firstDone, setFirstDone] = useState(false)
  const [joinKind, setJoinKind] = useState<string | null>(null)
  const [joinTour, setJoinTour] = useState(false)
  const [nameOpen, setNameOpen] = useState(false)
  // The tour opens and closes the real 接入 dialog for its steps.
  useEffect(() => {
    const onTour = (event: Event) => {
      const open = Boolean((event as CustomEvent<boolean>).detail)
      setJoinKind(null)
      setJoinTour(open)
      setJoinOpen(open)
    }
    window.addEventListener(TOUR_JOIN, onTour)
    return () => window.removeEventListener(TOUR_JOIN, onTour)
  }, [])
  const [runId, setRunId] = useState<string | null>(null)
  const [whisperId, setWhisperId] = useState<string | null>(null)
  // The seat whose model is being picked (「换模型…」).
  const [modelId, setModelId] = useState<string | null>(null)
  const picked = useSyncExternalStore(onViewChange, viewSaved, (): ThreadView => "progress")
  // The front desk has no to-dos to line up: it stays a plain conversation.
  const view: ThreadView = room?.project.front && picked === "progress" ? "chat" : picked
  // No key in this browser: whatever the user does here is refused.
  const keyless = useSyncExternalStore(noSubscribe, () => !storedHumanKey(), () => false)
  // 「背景缓慢流动」 (ambient.tsx): the dark wallpaper drifts.
  const flow = useSyncExternalStore(onFlowChange, flowOn, () => false)
  // 「其他项目做完时通知我」 (notify.ts).
  const notify = useSyncExternalStore(onNotifyChange, notifyOn, () => false)
  const canNotify = useSyncExternalStore(noSubscribe, notifySupported, () => false)
  const [spawn, setSpawn] = useState<{ kind: string; from: PublicAgent | null; preset?: SpawnPreset } | null>(null)
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
  const fontSize = useFontSize()
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const pullRef = useRef<() => void>(() => {})

  // The list as it last came, to tell a poll that brought nothing new.
  const projectsText = useRef("")
  const loadProjects = useCallback(() => {
    return api<{ projects: Project[] }>("/api/v1/projects").then((data) => {
      // Polled every five seconds: the same list again must not redraw the room.
      const text = JSON.stringify(data.projects)
      if (text !== projectsText.current) {
        projectsText.current = text
        setProjects(data.projects)
      }
      setProjectId((current) => {
        const ids = data.projects.map((item) => item.id)
        if (current && ids.includes(current)) return current
        const wanted = current ? null : projectWanted()
        const byName = wanted ? data.projects.find((item) => item.name === wanted)?.id : undefined
        // With nothing asked for, a project rather than the front desk
        // (listed first), unless the desk is all there is.
        const first = data.projects.find((item) => !item.front)?.id ?? ids[0] ?? null
        return wanted && ids.includes(wanted) ? wanted : (byName ?? first)
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
  // The project id changes only together with its snapshot: changing it on
  // the click re-drew the whole old room once before the fetch even started
  // (200–400ms in dev). The rail asks for the snapshot ahead while the
  // pointer is on a project (`prefetch`).
  const ahead = useRef(new Map<string, { at: number; snapshot: Promise<RoomSnapshot> }>())
  const prefetch = useCallback((id: string) => {
    const kept = ahead.current.get(id)
    if (kept && Date.now() - kept.at < AHEAD_FOR) return kept.snapshot
    const snapshot = fetch(`/api/v1/room?project=${encodeURIComponent(id)}`, { cache: "no-store", headers: human() }).then(
      (res) => (res.ok ? (res.json() as Promise<RoomSnapshot>) : Promise.reject(new Error(String(res.status)))),
    )
    ahead.current.set(id, { at: Date.now(), snapshot })
    snapshot.catch(() => ahead.current.delete(id))
    return snapshot
  }, [])
  const openedId = useRef<string | null>(null)
  useEffect(() => {
    openedId.current = projectId
  }, [projectId])
  const wanted = useRef<string | null>(null)
  // `then`: more to change in the same transition (left-pane.tsx: the left
  // column walks into the room as it arrives).
  const openProject = useCallback(
    (id: string, then?: () => void) => {
      wanted.current = id
      if (id === openedId.current) {
        then?.()
        return
      }
      const go = (snapshot: RoomSnapshot | null) => {
        // Only the last project picked.
        if (wanted.current !== id || id === openedId.current) return
        ahead.current.delete(id)
        setFocusId(null)
        setReply(null)
        setSimpleTab("chat")
        setOpenProject(id)
        draft.set("")
        startTransition(() => {
          then?.()
          setProjectId(id)
          // Without it (the fetch failed) the room's own pull takes over.
          if (snapshot?.project.id === id) setRoom(snapshot)
        })
      }
      prefetch(id).then(go, () => go(null))
    },
    [prefetch],
  )

  // A click on a notification walks into that project's room.
  useProjectNotices(projects, projectId, (id) => {
    window.dispatchEvent(new CustomEvent(LEFT_TIER, { detail: "room" }))
    openProject(id)
  })

  // The front desk (components/room/front.tsx). 「回到」 goes to the last
  // project open before it, kept in this browser so a reload in the desk
  // still knows.
  const backId = useBack()
  // What the user has seen where, kept current whichever tier the left
  // column shows (the desk's dot in the header depends on it).
  useSeen(projects ?? NO_PROJECTS, projectId)
  const frontProject = projects?.find((item) => item.front)
  const backProject = projects?.find((item) => item.id === backId && !item.front) ?? projects?.find((item) => !item.front)
  const walkInto = useCallback(
    (id: string) => {
      window.dispatchEvent(new CustomEvent(LEFT_TIER, { detail: "room" }))
      openProject(id)
    },
    [openProject],
  )
  // Opening the desk: make it, walk in, and ask who sits at it.
  const staffing = useRef(false)
  const staffFront = useCallback(() => {
    setSpawn({ kind: FRONT_KINDS[0], from: null, preset: FRONT_PRESET })
  }, [])
  const enableFront = useCallback(() => {
    void api<{ project: ProjectInfo }>("/api/v1/projects", {
      method: "POST",
      body: JSON.stringify({ as: "human", front: true }),
    })
      .then(async ({ project }) => {
        await loadProjects().catch(() => {})
        staffing.current = true
        walkInto(project.id)
      })
      .catch((error: unknown) => toast.error(error instanceof Error ? error.message : "前台没开出来"))
  }, [loadProjects, walkInto])

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

  // The desk's room is on screen (so new sessions go into it): ask who sits
  // there, if it was just opened and nobody does yet. Remember the last
  // project that isn't the desk, for 「回到」.
  useEffect(() => {
    if (!room) return
    if (!room.project.front) {
      rememberBack(room.project.id)
      return
    }
    if (!staffing.current) return
    staffing.current = false
    if (room.agents.some((agent) => !agent.demo)) return
    // After this commit's effects, so the page's open project (api.ts) is
    // the desk when the dialog asks for its folders.
    // Not called off by the next snapshot (the first one often comes twice).
    setTimeout(staffFront, 0)
  }, [room, staffFront])

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
    // Opened from the rail, the snapshot is already on screen.
    if (shown.current !== projectId) pull()
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
    return () => {
      stopped = true
      clearInterval(poll)
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
  // Older completed tasks pulled on demand (when clicking a t_… ref in chat or
  // when the 「流程」 view names a task finished > 48h ago).
  const [extraTasksState, setExtraTasksState] = useState<{ projectId: string; list: Task[] }>({
    projectId: "",
    list: [],
  })
  const allTasks = useMemo(() => {
    const base = room?.tasks ?? []
    const pid = room?.project.id ?? ""
    const extra = extraTasksState.projectId === pid ? extraTasksState.list : []
    if (extra.length === 0) return base
    const seen = new Set(base.map((t) => t.id))
    const merged = [...base]
    for (const item of extra) {
      if (!seen.has(item.id)) {
        seen.add(item.id)
        merged.push(item)
      }
    }
    return merged
  }, [room?.tasks, room?.project.id, extraTasksState])

  useEffect(() => {
    if (view !== "flow" || !room) return
    const pid = room.project.id
    const known = new Set(allTasks.map((t) => t.id))
    const missing = new Set<string>()
    for (const msg of room.messages) {
      if (msg.taskId && !known.has(msg.taskId)) missing.add(msg.taskId)
      if (msg.verdict?.taskId && !known.has(msg.verdict.taskId)) missing.add(msg.verdict.taskId)
      for (const id of namedTasks(msg.text)) {
        if (!known.has(id)) missing.add(id)
      }
    }
    if (missing.size === 0) return
    let live = true
    Promise.all(
      [...missing].map((id) =>
        api<{ task?: Task }>(`/api/v1/tasks/${encodeURIComponent(id)}`)
          .then((res) => res.task ?? null)
          .catch(() => null),
      ),
    ).then((loaded) => {
      if (!live) return
      const valid = loaded.filter((t): t is Task => Boolean(t))
      if (valid.length === 0) return
      setExtraTasksState((prev) => {
        const cur = prev.projectId === pid ? prev.list : []
        const seen = new Set(cur.map((t) => t.id))
        const next = [...cur]
        for (const item of valid) {
          if (!seen.has(item.id)) {
            seen.add(item.id)
            next.push(item)
          }
        }
        return { projectId: pid, list: next }
      })
    })
    return () => {
      live = false
    }
  }, [view, room, allTasks])

  const [waitingOverview, setWaitingOverview] = useState<WaitingOverview | null>(null)
  const waitingTextRef = useRef("")
  const loadWaiting = useCallback(() => {
    return api<WaitingOverview>("/api/v1/waiting")
      .then((data) => {
        const text = JSON.stringify(data)
        if (text !== waitingTextRef.current) {
          waitingTextRef.current = text
          setWaitingOverview(data)
        }
      })
      .catch(() => {})
  }, [])
  useEffect(() => {
    if (!simple || !room?.project.front) return
    const first = window.setTimeout(() => void loadWaiting(), 0)
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void loadWaiting()
    }, 4000)
    return () => {
      window.clearTimeout(first)
      window.clearInterval(timer)
    }
  }, [simple, room?.project.front, room?.rev, projects, loadWaiting])

  // The 「进展」 rows, computed when the progress tab is shown OR on the
  // simple first layer for an ordinary project (reused for 「等你定」).
  const digest = useMemo(
    () =>
      room && ((simple && !room.project.front) || view === "progress")
        ? digestOf({
            messages: room.messages,
            tasks: allTasks,
            agents: room.agents,
            permits: room.permits ?? [],
            userName: room.userName,
            now: Date.now(),
          })
        : null,
    [simple, view, room, allTasks],
  )
  // The 「流程」 view's pictures, worked out only while it is showing.
  const flows = useMemo(
    () => (view === "flow" && room ? flowsOf(room.messages, allTasks, room.agents, room.userName) : []),
    [view, room, allTasks],
  )

  // Who spoke in the room, latest first, for the composer's chips.
  const speakers = useMemo(() => {
    const seats = new Set((room?.agents ?? []).map((agent) => agent.id))
    const out: string[] = []
    const messages = room?.messages ?? []
    for (let index = messages.length - 1; index >= 0 && out.length < 10; index--) {
      const { kind, authorId } = messages[index]
      if (kind !== "system" && seats.has(authorId) && !out.includes(authorId)) out.push(authorId)
    }
    return out
  }, [room?.messages, room?.agents])

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

  // A slash command from the input (lib/commands.ts): to each seat @'d in it,
  // through the seat actions; nothing is said in the room.
  function sendWorkflow(input: { id?: string; command?: string; text: string; targets?: string[] }) {
    if (!input.text) return void toast.error("先写上要做什么")
    void run(async () => {
      await api("/api/v1/workflows", {
        method: "POST",
        body: JSON.stringify({ as: "human", action: "run", ...input, replyTo: reply?.id,
          attachments: files.map(({ kind, name, path }) => ({ kind, name, path })),
        }),
      })
      for (const item of files) if (item.preview) URL.revokeObjectURL(item.preview)
      setFiles([])
      draft.set("")
      setReply(null)
    })
  }

  function sendSlash({ command, targets: named, text }: NonNullable<ReturnType<typeof parseSlash>>) {
    if (command.mode === "workflow") {
      sendWorkflow({ id: command.workflowId, command: command.name, text, targets: named })
      return
    }
    // At the front desk there is one seat to mean: no @ needed.
    const sole = room?.project.front ? deskSeat(agents)?.name : undefined
    const targets = named.length === 0 && sole ? [sole] : named
    if (targets.length === 0) return void toast.error(`/${command.name} 要发给谁？@ 一个席位`)
    if (command.needsText && !text) return void toast.error(`/${command.name} 后面写上${command.hint}`)
    void run(async () => {
      const done: string[] = []
      // To everyone: the seats it doesn't apply to (not running, no /goal) are passed over quietly.
      const everyone = targets.includes("所有人")
      const names = everyone ? agents.map((agent) => agent.name) : targets
      for (const name of names) {
        const seat = agents.find((agent) => agent.name === name)
        if (!seat) continue
        try {
          const result = await api<{ dropped?: number; queued?: boolean }>(`/api/v1/agents/${seat.id}`, {
            method: "POST",
            body: JSON.stringify({ as: "human", action: command.name, ...(command.name === "goal" ? { text } : {}) }),
          })
          done.push(
            command.name === "stop"
              ? `${name} 停下了${result.dropped ? `，排队的 ${result.dropped} 条也取消了` : ""}`
              : command.name === "compact"
                ? `${name} 开始压缩上下文，好了会在群里说一声`
                : result.queued
                  ? `${name} 正在忙，目标排在手上的事后面`
                  : `${name} 收到目标了`,
          )
        } catch (err) {
          if (!everyone) toast.error(`${name}：${err instanceof Error ? err.message : "没做成"}`)
        }
      }
      if (everyone && done.length === 0) toast.error(`没有席位能 /${command.name}`)
      if (done.length) {
        toast.success(done.join("；"))
        draft.set("")
      }
    })
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

  // 「t_…」 in a message reads as the to-do's title (components/room/refs.ts).
  useEffect(() => {
    rememberTasks(allTasks)
  }, [allTasks])
  // A task id clicked in a message (components/room/refs.ts).
  const openTaskRef = useRef(openTask)
  const tasksRef = useRef(allTasks)
  const projectIdRef = useRef(room?.project.id ?? "")
  useEffect(() => {
    openTaskRef.current = openTask
    tasksRef.current = allTasks
    projectIdRef.current = room?.project.id ?? ""
  })
  useEffect(() => {
    const onGoto = (event: Event) => {
      const { kind, id } = (event as CustomEvent<Goto>).detail
      if (kind !== "task") return
      if (tasksRef.current && tasksRef.current.some((task) => task.id === id)) {
        openTaskRef.current(id)
        return
      }
      const pid = projectIdRef.current
      api<{ task?: Task }>(`/api/v1/tasks/${encodeURIComponent(id)}`)
        .then((res) => {
          if (!res.task) {
            toast("这个项目里没有这条待办")
            return
          }
          const fetched = res.task
          setExtraTasksState((prev) => {
            const cur = prev.projectId === pid ? prev.list : []
            if (cur.some((t) => t.id === fetched.id)) return prev
            return { projectId: pid, list: [...cur, fetched] }
          })
          requestAnimationFrame(() => openTaskRef.current(id))
        })
        .catch(() => {
          toast("这个项目里没有这条待办")
        })
    }
    window.addEventListener(GOTO_EVENT, onGoto)
    return () => window.removeEventListener(GOTO_EVENT, onGoto)
  }, [])
  // A card at the front desk pointing into another project (relay-card.tsx):
  // open that room, at the to-do when it names one.
  const openProjectRef = useRef(openProject)
  useEffect(() => {
    openProjectRef.current = openProject
  })
  useEffect(() => {
    const onOpen = (event: Event) => {
      const { project, task } = (event as CustomEvent<OpenProject>).detail
      openProjectRef.current(project, task ? () => openTaskRef.current(task) : undefined)
    }
    window.addEventListener(OPEN_PROJECT_EVENT, onOpen)
    return () => window.removeEventListener(OPEN_PROJECT_EVENT, onOpen)
  }, [])

  function scrollTaskIntoView(taskId: string, tries = 30) {
    const step = (left: number) => {
      const node = document.getElementById(`task-${taskId}`)
      if (node) {
        node.scrollIntoView({ block: "center" })
        return
      }
      if (left > 0) requestAnimationFrame(() => step(left - 1))
    }
    requestAnimationFrame(() => step(tries))
  }

  function openTask(taskId: string) {
    const pid = room?.project.id ?? ""
    if (layerSaved() === "simple") setUiLayer("full")
    if (!allTasks.some((t) => t.id === taskId)) {
      const query = pid ? `?project=${encodeURIComponent(pid)}` : ""
      api<{ task?: Task }>(`/api/v1/tasks/${encodeURIComponent(taskId)}${query}`)
        .then((res) => {
          if (!res.task) return
          const fetched = res.task
          setExtraTasksState((prev) => {
            const cur = prev.projectId === pid ? prev.list : []
            if (cur.some((t) => t.id === fetched.id)) return prev
            return { projectId: pid, list: [...cur, fetched] }
          })
          scrollTaskIntoView(taskId, 30)
        })
        .catch(() => {})
    }
    setTab("tasks")
    setHighlight(taskId)
    scrollTaskIntoView(taskId, 30)
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
  // The front desk shows as one chat window (FrontBar over the thread).
  const desk = Boolean(room?.project.front)
  const simpleWaitingCount = !room
    ? 0
    : desk
      ? waitingOverview
        ? waitingOverview.permits.length +
          waitingOverview.asks.length +
          waitingOverview.limited.length +
          waitingOverview.interrupted.length +
          waitingOverview.reviews.length
        : 0
      : (room.permits?.length ?? 0) +
        collectOpenAsks(room.messages, room.openAsks).length +
        groupLimited(room.messages).length +
        room.messages.filter(isPendingInterrupted).length +
        (digest?.you.filter((row) => row.need === "review").length ?? 0)
  const simpleWorkingCount = desk
    ? (waitingOverview?.workingTotal ??
      (projects?.filter((item) => !item.front).reduce((sum, item) => sum + item.working, 0) ?? 0))
    : working

  // Stop a seat's run (and what is queued for it): the seat menu and the
  // working bubble in the thread.
  const stopSeat = (agent: PublicAgent) =>
    void run(async () => {
      const result = await api<{ dropped: number; retryCancelled?: boolean }>(`/api/v1/agents/${agent.id}`, {
        method: "POST",
        body: JSON.stringify({ as: "human", action: "stop" }),
      })
      if (result.retryCancelled) return void toast.success(`${agent.name} 不再自动重试了`)
      toast.success(`${agent.name} 停下了${result.dropped > 0 ? `，排队的 ${result.dropped} 条也取消了` : ""}`)
    })

  // Have the room compact a seat's context: the seat menu, and the desk's bar.
  const compactSeat = (agent: PublicAgent) =>
    void run(async () => {
      await api(`/api/v1/agents/${agent.id}`, {
        method: "POST",
        body: JSON.stringify({ as: "human", action: "compact" }),
      })
      toast.success(`${agent.name} 开始压缩上下文，好了会在群里说一声`)
    })

  // 「第一次打开」: nobody has sat or spoken here yet (the server checks every
  // project before it shows). Gone for good once anything has happened.
  if (room && !firstDone && !room.agents.some((agent) => !agent.demo) && !room.messages.some((message) => message.authorId === "human")) {
    return (
      <main className="relative isolate flex h-dvh flex-col overflow-y-auto">
        <Ambient />
        <FirstOpen
          onMore={() => setFirstDone(true)}
          onStarted={(id) => {
            setFirstDone(true)
            openProject(id)
          }}
        />
      </main>
    )
  }

  return (
    <main className="relative isolate flex h-dvh flex-col">
      <Ambient />
      <ProjectNotices />
      <Tour />
      <SpeedPanel />
      <TerminalDialog />
      {keyless ? (
        <p role="alert" className="shrink-0 bg-destructive px-4 py-2 text-center text-sm text-white">
          这个页面没有口令，发消息、批准权限这些操作都会被拒。用 <code>npm run open</code> 或桌面上的「并坐」图标重新打开一次，之后就不用了。
        </p>
      ) : null}
      <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
      <div className="shrink-0 px-3 pt-2 lg:px-4">
      <header className="flex h-12 items-center gap-3 pr-1 pl-1">
        <Mark />
        <h1 className="sr-only">并坐</h1>
        <div className="min-w-0" data-tour="project">
          {/* From lg on the second layer the project rail switches, creates and opens settings, so
              the header only says where this one lives. On the first layer and at the desk there is no rail. */}
          <div className={simple || currentProject?.front ? "" : "lg:hidden"}>
            <ProjectMenu
              projects={projects ?? []}
              current={currentProject}
              alwaysShowName={simple}
              onPick={openProject}
              onCreate={() => setProjectDialog({ editing: null })}
              onEdit={() => room && setProjectDialog({ editing: room.project })}
              onEnableFront={frontProject ? undefined : enableFront}
            />
          </div>
          {simple || currentProject?.front ? null : <ProjectPlace project={currentProject} />}
        </div>
        {currentProject?.dir && !currentProject.front ? (
          <button
            type="button"
            className="-ml-1.5 grid size-7 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
            title={`在文件管理器里打开 ${currentProject.dir}`}
            aria-label="在文件管理器里打开项目文件夹"
            onClick={() => void openFile(currentProject.dir!, undefined, undefined)}
          >
            <FolderOpen className="size-4" />
          </button>
        ) : null}
        <div className="ml-auto flex items-center gap-1.5">
          {projects ? (
            <FrontButton
              front={frontProject}
              current={currentProject}
              back={backProject}
              onEnter={() => frontProject && walkInto(frontProject.id)}
              onBack={() => backProject && walkInto(backProject.id)}
              onEnable={enableFront}
            />
          ) : null}
          {!simple ? (
            <span
              className="pill mr-1 hidden items-center gap-1.5 rounded-full px-2.5 py-1 text-xs text-muted-foreground sm:flex"
              title={live ? "实时连接正常" : "正在重连"}
            >
              <span className={`size-1.5 rounded-full ${live ? "bg-emerald-500" : "animate-pulse bg-amber-500"}`} />
              {room ? `${seated} 在线 · ${working} 在做` : "正在打开"}
            </span>
          ) : null}
          <button
            type="button"
            className="flex h-7 items-center gap-1 rounded-full border border-foreground/12 px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
            title={simple ? "打开完整项目、席位和待办栏" : "回到对话与等你定界面"}
            onClick={() => setUiLayer(simple ? "full" : "simple")}
          >
            {simple ? "看细节" : "回到简单"}
          </button>
          {!simple && DEBUG_MENU ? (
            <DebugMenu
              view={debug}
              agents={agents}
              busy={busy}
              onView={setDebug}
              onNote={(kind) => void run(() => debugCall({ action: "note", kind }))}
              onForget={(agent) =>
                void run(() => debugCall({ action: "forget", agentId: agent.id }), `${agent.name} 下次被叫醒会收到全部积压`)
              }
              onClearSummary={() => void run(() => debugCall({ action: "clearSummary", confirm: "清空摘要" }), "房间摘要清空了")}
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
              <DropdownMenuGroup>
                <DropdownMenuLabel className="flex items-center gap-1.5">
                  <Type className="size-3.5" />
                  字号
                </DropdownMenuLabel>
                {/* Stays open: the page resizes behind it as you pick. */}
                <DropdownMenuRadioGroup value={fontSize} onValueChange={(value) => setFontSize(value as FontSizeId)}>
                  {FONT_SIZES.map((size) => (
                    <DropdownMenuRadioItem key={size.id} value={size.id}>
                      {size.label}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              {canNotify ? (
                <DropdownMenuCheckboxItem
                  checked={notify}
                  closeOnClick
                  onCheckedChange={(on) => {
                    void setNotify(on).then((result) => {
                      if (result === "blocked") toast.error("浏览器拦下了通知：点地址栏左边的图标，把「通知」改成允许，再打开一次")
                      else if (result === "on") toast.success("好了：页面不在前台时，别的项目做完或有事等你也会弹到桌面")
                    })
                  }}
                >
                  别的项目做完时也弹桌面通知
                </DropdownMenuCheckboxItem>
              ) : null}
              <DropdownMenuItem onClick={() => window.dispatchEvent(new Event(PUSH_OPEN))}>
                <Smartphone />
                推送到手机…
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setNameOpen(true)}>
                <UserRound />
                你的名字…
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <SlidersHorizontal />
                  高级
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="min-w-52">
                  <DropdownMenuItem
                    onClick={() => {
                      setAdapterName(null)
                      setAdaptersOpen(true)
                    }}
                  >
                    <TerminalSquare />
                    唤起命令…
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => window.dispatchEvent(new Event(SPEED_OPEN))}>
                    <Gauge />
                    Token 测速台
                  </DropdownMenuItem>
                  {room || theme !== "light" ? <DropdownMenuSeparator /> : null}
                  {room ? (
                    <DropdownMenuCheckboxItem
                      checked={room.netRetry}
                      closeOnClick
                      title="叫醒因为断网、连接被重置、网关 502/503/504 这类原因没成功时，房间隔 20 秒、60 秒带着同样的消息再叫两次，都不行才在群里报错"
                      onCheckedChange={(on) =>
                        void run(
                          () => api("/api/v1/retry", { method: "POST", body: JSON.stringify({ as: "human", on }) }).then(() => undefined),
                          on ? "网络错误会自动重试了" : "网络错误不再自动重试",
                        )
                      }
                    >
                      网络错误自动重试
                    </DropdownMenuCheckboxItem>
                  ) : null}
                  {room ? (
                    <DropdownMenuCheckboxItem
                      checked={room.limitResume}
                      closeOnClick
                      title="叫醒撞上 5 小时额度、读得出几点重置时，到点后自动带着同样的消息再叫一次；卡片上能取消。每周额度不自动，仍由你决定"
                      onCheckedChange={(limit) =>
                        void run(
                          () => api("/api/v1/retry", { method: "POST", body: JSON.stringify({ as: "human", limit }) }).then(() => undefined),
                          limit ? "撞到 5 小时额度会到点自动继续了" : "撞到 5 小时额度不再自动继续",
                        )
                      }
                    >
                      5 小时额度到点自动继续
                    </DropdownMenuCheckboxItem>
                  ) : null}
                  {theme !== "light" ? (
                    <DropdownMenuCheckboxItem checked={flow} onCheckedChange={(on) => setFlow(on)} closeOnClick>
                      深色背景缓慢流动
                    </DropdownMenuCheckboxItem>
                  ) : null}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={() => {
                      // The tour walks the full page (project rail, seats): show that first.
                      if (simple) setUiLayer("full")
                      window.dispatchEvent(new Event(TOUR_START))
                    }}
                  >
                    <Sparkles />
                    新手引导
                  </DropdownMenuItem>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            </DropdownMenuContent>
          </DropdownMenu>
          {!simple ? (
            <Button
              type="button"
              size="sm"
              className="rounded-full"
              data-tour="join"
              onClick={() => {
                setJoinKind(null)
                setJoinTour(false)
                setJoinOpen(true)
              }}
            >
              <Plug />
              接入 AI
            </Button>
          ) : null}
        </div>
      </header>
      </div>

      {!room ? (
        <div
          className={`grid min-h-0 flex-1 gap-4 p-3 lg:px-4 lg:pt-1 lg:pb-4 ${
            simple ? "lg:grid-cols-[1fr_340px]" : "lg:grid-cols-[300px_1fr_300px]"
          }`}
        >
          {(simple ? ["对话", "等你定"] : ["入口", "对话", "待办"]).map((label) => (
            <div key={label} className="frost animate-pulse rounded-2xl p-4 text-sm text-muted-foreground">
              正在打开{label}
            </div>
          ))}
        </div>
      ) : (
        <div
          className={`grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)] pt-2 lg:gap-4 lg:px-4 lg:pt-1 lg:pb-4 ${
            simple ? "lg:grid-cols-[minmax(0,1fr)_340px]" : desk ? "lg:grid-cols-[300px_minmax(0,1fr)]" : "lg:grid-cols-[300px_minmax(0,1fr)_300px]"
          }`}
        >
          {/* Second layer only: project rail + seats column (ordinary projects). */}
          {/* At the desk too, from lg: walking in from the project list, the
              list stays, so a project is one click back (AverageJoe
              2026-11-18: 「能点进去但点不回来」). There it is the list, not a roster. */}
          {!simple ? (
            <aside className={`${tab === "people" && !desk ? "block" : "hidden"} h-full min-h-0 lg:block`}>
              <LeftPane
                projects={projects ?? []}
                current={room.project}
                className="h-full min-h-0"
                onOpen={openProject}
                onPrefetch={prefetch}
                onCreate={() => setProjectDialog({ editing: null })}
                onEdit={(project) => setProjectDialog({ editing: project })}
                onEnableFront={enableFront}
                roster={(head) => (
              <Roster
                head={head}
                agents={agents}
                adapters={adapters}
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
                onStop={stopSeat}
                onCompact={compactSeat}
                onJoin={(kind) => {
                  setJoinKind(kind ?? null)
                  setJoinTour(false)
                  setJoinOpen(true)
                }}
              />
                )}
              />
            </aside>
          ) : null}
          <section
            data-tour="chat"
            className={`${(simple ? simpleTab === "chat" : tab === "chat" || desk) ? "flex" : "hidden"} relative h-full min-h-0 min-w-0 flex-col lg:flex`}
          >
            {desk ? (
              <FrontBar
                seat={deskSeat(agents)}
                showDeputyBar={!simple}
                refreshKey={String(room.rev)}
                onStop={stopSeat}
                onOpenRun={setRunId}
                onLeave={setLeaving}
                onStaff={staffFront}
                onCompact={compactSeat}
                onModel={(agent) => setModelId(agent.id)}
              />
            ) : null}
            {error ? (
              <p className="mx-3 rounded-xl bg-destructive/10 px-4 py-2 text-xs text-destructive">{error} 正在重试。</p>
            ) : null}
            <Thread
              // A fresh thread per project: it opens at the bottom of the new
              // room at once, instead of gliding there from the old one's spot.
              key={room.project.id}
              view={simple ? "chat" : view}
              onView={simple || desk ? undefined : showView}
              progress={simple || room.project.front ? undefined : { digest: digest ?? EMPTY_DIGEST, permits: room.permits ?? [] }}
              flow={
                !simple && view === "flow" ? (
                  <FlowView
                    flows={flows}
                    agents={agents}
                    notes={room.summary?.flows}
                    onOpen={(id) => {
                      showView("chat")
                      // Once the thread is showing again.
                      requestAnimationFrame(() => goto("message", id))
                    }}
                  />
                ) : null
              }
              messages={visibleMessages}
              openAsks={focusAgent ? undefined : room.openAsks}
              totalMessages={room.totalMessages}
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
              onStop={stopSeat}
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
              front={Boolean(room.project.front)}
              simple={simple}
              onStaff={staffFront}
            />
            {/* Over the thread, in the blank to its left; lets the scroll through. */}
            {!simple && view === "chat" && !desk ? <Trajectory agents={agents} messages={visibleMessages} onOpenRun={setRunId} /> : null}
            <DraftComposer
              workflows={room.workflows ?? []}
              workflow={selectedWorkflow}
              onWorkflow={(item) => setWorkflowPick(item ? { projectId: room.project.id, id: item.id } : null)}
              onManageWorkflows={() => setWorkflowsOpen(true)}
              placeholder={room.project.front ? frontHint(agents) : undefined}
              sole={room.project.front ? deskSeat(agents)?.name : undefined}
              agents={agents}
              speakers={speakers}
              reply={reply}
              busy={busy}
              inputRef={composerRef}
              files={files}
              onFiles={setFiles}
              onClearReply={() => setReply(null)}
              notice={
                room ? (
                  <>
                    {/* In simple mode, permit & ask buttons live solely in 「等你定」. */}
                    {!simple ? (
                      <>
                        {/* On the progress page a permission is a button on its row; the bar only holds those no row has. */}
                        <PermitBar
                          room={
                            digest
                              ? { ...room, permits: (room.permits ?? []).filter((item) => !digest.you.some((row) => row.permitId === item.id)) }
                              : room
                          }
                        />
                        {digest ? <JustSaid messages={room.messages} agents={room.agents} digest={digest} onOpenRun={setRunId} /> : null}
                      </>
                    ) : null}
                    <SummaryNudge
                      room={room}
                      busy={busy}
                      onRequest={(agent) =>
                        void run(
                          () => summaryCall({ action: "request", agentId: agent.id }),
                          `请 ${agent.name} 写房间摘要了`,
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
                // Nobody at the desk to hear it: pick one first, the words stay in the input.
                if (room.project.front && !deskSeat(agents)) {
                  toast("还没有人值班，先挑一个 AI")
                  staffFront()
                  return
                }
                const slash = parseSlash(
                  text,
                  agents.map((agent) => agent.name),
                  room.workflows,
                )
                if (slash) {
                  sendSlash(slash)
                  return
                }
                if (selectedWorkflow) {
                  sendWorkflow({ id: selectedWorkflow.id, text })
                  return
                }
                const attachments = files.map(({ kind, name, path }) => ({ kind, name, path }))
                const replyTo = reply?.id
                // Seats called (@) that are busy get this after what they're doing.
                // Whole names, the way the room takes them: @Opus2 is not @Opus.
                const named = new Set(mentionedAgentIds(text, agents))
                const queued = agents.filter((agent) => agent.runId && named.has(agent.id))
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
          {simple ? (
            <div className={`${simpleTab === "waiting" ? "block" : "hidden"} h-full min-h-0 px-3 pb-2 lg:block lg:px-0 lg:pb-0`}>
              <WaitingPanel
                room={room}
                digest={digest}
                overview={waitingOverview}
                workingCount={simpleWorkingCount}
                refreshKey={`${room.project.id}:${room.rev}:${room.doneTotal ?? 0}:${simpleWorkingCount}`}
                busy={busy}
                onEnterFull={(taskId) => {
                  if (taskId) openTask(taskId)
                  else setUiLayer("full")
                }}
                onOpenRun={setRunId}
                onRewake={(wakeRunId) =>
                  void run(
                    () =>
                      api(`/api/v1/runs/${wakeRunId}`, {
                        method: "POST",
                        body: JSON.stringify({ as: "human", action: "rewake" }),
                      }).then(() => undefined),
                    "叫醒了，会带着原来那些消息接着做",
                  )
                }
                onReview={async (taskId, pass, reviewNote) => {
                  let ok = false
                  await run(
                    async () => {
                      await api(`/api/v1/tasks/${taskId}`, {
                        method: "POST",
                        body: JSON.stringify({ as: "human", action: pass ? "pass" : "reject", note: reviewNote }),
                      })
                      ok = true
                    },
                    pass ? "验收通过" : "打回了，已经叫醒负责人",
                  )
                  return ok
                }}
                onPassForeignReview={(targetProject, taskId) =>
                  run(async () => {
                    await api(`/api/v1/tasks/${taskId}`, {
                      method: "POST",
                      body: JSON.stringify({ as: "human", project: targetProject, action: "pass" }),
                    })
                    await loadWaiting()
                    void loadProjects().catch(() => {})
                  }, "验收通过")
                }
              />
            </div>
          ) : (
            <aside data-tour="tasks" className={`${tab === "tasks" && !desk ? "block" : "hidden"} h-full min-h-0 overflow-hidden ${desk ? "" : "lg:block"}`}>
              <TasksPanel
                tasks={allTasks}
                doneTotal={room.doneTotal}
                projectId={room.project.id}
                agents={agents}
                highlightId={highlight}
                busy={busy}
                onOpenRun={setRunId}
                header={
                  <SummaryCard
                    room={room}
                    busy={busy}
                    onSave={async (text) => {
                      let saved = false
                      await run(async () => {
                        await summaryCall({ action: "edit", text })
                        saved = true
                      }, "房间摘要存好了")
                      return saved
                    }}
                  />
                }
                onStep={(task, step, state) =>
                  void run(() =>
                    api(`/api/v1/tasks/${task.id}`, {
                      method: "POST",
                      body: JSON.stringify({ as: "human", action: "step", step, state }),
                    }).then(() => undefined),
                  )
                }
                onReview={(task, pass, reviewNote) =>
                  void run(
                    () =>
                      api(`/api/v1/tasks/${task.id}`, {
                        method: "POST",
                        body: JSON.stringify({ as: "human", action: pass ? "pass" : "reject", note: reviewNote }),
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
          )}
        </div>
      )}
      </div>
      </div>

      {simple ? (
        <nav className="frost grid shrink-0 grid-cols-2 lg:hidden">
          <button
            type="button"
            className={`flex flex-col items-center gap-0.5 py-2 text-[0.6875rem] ${simpleTab === "chat" ? "text-foreground" : "text-muted-foreground"}`}
            onClick={() => setSimpleTab("chat")}
            aria-current={simpleTab === "chat" ? "page" : undefined}
          >
            <MessageSquare className="size-5" />
            <span>对话</span>
          </button>
          <button
            type="button"
            className={`flex flex-col items-center gap-0.5 py-2 text-[0.6875rem] ${simpleTab === "waiting" ? "text-foreground" : "text-muted-foreground"}`}
            onClick={() => setSimpleTab("waiting")}
            aria-current={simpleTab === "waiting" ? "page" : undefined}
          >
            <BellRing className="size-5" />
            <span>{simpleWaitingCount > 0 ? `等你定（${simpleWaitingCount}）` : "等你定"}</span>
          </button>
        </nav>
      ) : (
        <nav className={`frost grid shrink-0 grid-cols-3 lg:hidden ${room?.project.front ? "hidden" : ""}`}>
          {tabs.map((item) => {
            const Icon = item.icon
            const on = tab === item.id
            return (
              <button
                key={item.id}
                type="button"
                className={`flex flex-col items-center gap-0.5 py-2 text-[0.6875rem] ${on ? "text-foreground" : "text-muted-foreground"}`}
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
      )}

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

      <SpawnDialog
        kind={spawn?.kind ?? null}
        from={spawn?.from ?? null}
        agents={agents}
        preset={spawn?.preset ?? null}
        onKind={(kind) => setSpawn((current) => (current ? { ...current, kind } : current))}
        onClose={() => setSpawn(null)}
      />
      <SeatProfileDialog agents={agents} adapters={adapters} />
      <ModelDialog agent={agents.find((agent) => agent.id === modelId) ?? null} onClose={() => setModelId(null)} />
      <CommitDialog />
      <PushDialog />
      {room ? <WorkflowsDialog key={room.project.id} open={workflowsOpen} onOpenChange={setWorkflowsOpen}
        workflows={room.workflows ?? []} agents={agents}
        onChanged={() => { void api<RoomSnapshot>("/api/v1/room").then(setRoom).catch((err: unknown) => toast.error(err instanceof Error ? err.message : "刷新失败")) }} /> : null}
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
        expandAdvanced={joinTour}
        onOpenChange={(open) => {
          setJoinOpen(open)
          if (!open) setJoinTour(false)
        }}
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

      <Dialog open={nameOpen} onOpenChange={setNameOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>你的名字</DialogTitle>
            <DialogDescription>AI 会这样称呼你，房间里你说的话和待办也署这个名字。</DialogDescription>
          </DialogHeader>
          <NameField
            label="名字"
            submitLabel="保存"
            hint=""
            className="mt-1"
            onCancel={() => setNameOpen(false)}
            onNext={(changed) => {
              setNameOpen(false)
              if (changed) {
                pullRef.current()
                toast.success("名字已修改")
              }
            }}
          />
        </DialogContent>
      </Dialog>

      <Dialog open={leaving !== null} onOpenChange={(open) => !open && setLeaving(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{desk ? `换掉 ${leaving?.name}` : `把 ${leaving?.name} 移出？`}</DialogTitle>
            <DialogDescription>
              {desk
                ? "它会离开前台，聊天记录留着。接着挑一个新的 AI 来值班。"
                : "这个席位会从房间消失。它名下还没做完的待办会先停着，等别人接手。"}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setLeaving(null)}>
              {desk ? "不换" : "取消"}
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
                  // The desk is never left empty-handed: who sits there next.
                  if (desk) setTimeout(staffFront, 0)
                })
              }}
            >
              {desk ? "换人" : "移出"}
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

// The front desk's composer: whatever is said there goes to its one AI.
function frontHint(agents: PublicAgent[]) {
  const seat = deskSeat(agents)
  return seat ? `问${seat.name}… 它替你看各项目，每件事带上项目名和编号` : "先挑一个 AI 来值班"
}
