import { AsyncLocalStorage } from "node:async_hooks"
import { randomBytes } from "node:crypto"
import { EventEmitter } from "node:events"
import { existsSync, statSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

import { hasAdapter } from "@/lib/adapters"
import {
  dbCountMessages,
  dbCountOpenAsks,
  dbDeleteProject,
  dbDeleteSeat,
  dbFindMessageByRunField,
  dbGetMessage,
  dbGetMeta,
  dbLoadMessagesAfter,
  dbLoadOpenAsks,
  dbLoadProjects,
  dbLoadRecentMessages,
  dbLoadSeats,
  dbLoadTalkAfter,
  dbLoadTasks,
  dbOpenAskAuthorIds,
  dbPutMessage,
  dbPutTask,
  dbQueryMessages,
  dbResetProjectRoom,
  dbRewriteMessages,
  dbSaveProject,
  dbSaveRoomHeader,
  dbSetMeta,
  dbSyncSeats,
  inTransaction,
  seatMarkdownPath,
  writeSeatMarkdown,
} from "@/lib/db"
import { readLaneSnapshot } from "@/lib/lane-state"
import { mediaKind } from "@/lib/media"
import { ApiError, asRecord, asString } from "@/lib/http"
import { hasFull, permitsFor } from "@/lib/permits"
import { activeRun } from "@/lib/runs"
import { liveStatus } from "@/lib/status"
import { terminalOpen } from "@/lib/terminal-state"
import { awaitingReview, isReviewStep } from "@/lib/review"
import { mentionedAgentIds, mentionPattern, namedAgentIds, withAttachments } from "@/lib/text"
import type {
  Ask,
  AskOption,
  Actor,
  Attachment,
  InterruptedRun,
  LimitedRun,
  AgentStatus,
  Message,
  Project,
  ProjectEnd,
  ProjectInfo,
  PublicAgent,
  PublicSeatBinding,
  RoomSnapshot,
  RoomSummary,
  SeatBinding,
  SeatProfile,
  Task,
  TaskStatus,
  TaskStep,
  TaskStepState,
} from "@/lib/types"
import { mergeFlowSummaries, splitFlowSummaries } from "@/lib/flow-summary"

const STALE_MS = 40_000
const COLORS = [
  "#0f6e56",
  "#9a3412",
  "#1e4d8c",
  "#6d28d9",
  "#9f1239",
  "#3f6212",
  "#0f5266",
  "#8a4b08",
]
const RESERVED = new Set(["human", "room", "everyone", "所有人"])
const NAME_RE = /^[\p{L}\p{N}_-]{1,24}$/u
const UUID_RE = /^[A-Za-z0-9._-]{1,128}$/
const STATUSES = new Set<AgentStatus>(["idle", "working", "blocked", "offline"])
const TASK_STATUSES = new Set<TaskStatus>(["open", "doing", "blocked", "done"])
const STEP_STATES = new Set<TaskStepState>(["todo", "doing", "done"])
const STEP_ACTION: Record<TaskStepState, string> = { todo: "退回", doing: "开始", done: "做完" }
const MAX_STEPS = 30
const HOT_MESSAGES = 400
const SNAPSHOT_DONE_TASKS = 200
const MAX_PERSONA_CHARS = 2_000
const MAX_MEMORY_CHARS = 4_000
// How much talk a woken seat is handed at most (about 100 messages). Once this
// much has piled up since the last summary, the room suggests writing one.
export const CATCH_UP_CHARS = 10_000
// What a summary writer is handed: the last summary plus up to this much talk.
const SUMMARY_SOURCE_CHARS = 40_000

type Agent = Omit<
  PublicAgent,
  | "hasSession"
  | "callable"
  | "standby"
  | "status"
  | "agentName"
  | "queuedCount"
  | "queuePaused"
  | "queuedItems"
  | "hasProfile"
  | "previousBindings"
> & {
  token: string
  status: AgentStatus
  agentName?: string
  session?: string
  // The last message seq this seat has been shown, by its inbox or a wake.
  seenSeq?: number
  // Sessions the room created itself: the folder it works in, and whether it
  // has not been woken yet (its session only exists after the first wake).
  workdir?: string
  fresh?: boolean
  // The user chose to let it do anything whenever it is woken (「默认开启
  // 全部权限」 when it was made, or its seat menu): permission prompts and
  // bench_elevate pass without asking (lib/permits.ts).
  autoFull?: boolean
  // Names it had before, newest first: an @ to one still reaches it, unless
  // another seat has taken that name since.
  formerNames?: string[]
  // Portable persona & long-term memory decoupled from the underlying client session.
  profile?: SeatProfile
  profileDirty?: boolean
  reboundFrom?: { agentName: string; model: string; runId?: string }
  previousBindings?: SeatBinding[]
  // The house rules a wake ends with were last given whole to this session:
  // which version (sig), when, and how many short reminders since
  // (lib/summon.ts rulesFor).
  rulesGiven?: { sig: string; at: number; session?: string; shorts: number }
}

type State = {
  rev: number
  seq: number
  agents: Agent[]
  // Hot window of the latest HOT_MESSAGES; full history lives in SQLite.
  messages: Message[]
  tasks: Task[]
  summary?: RoomSummary
  // The user chose not to summarize talk up to this seq.
  summarySkipSeq?: number
  // An agent ended the round: agent messages wake nobody until the user speaks.
  relayClosed?: boolean
}

// One room per project: its own seats, talk, tasks and summary. A session
// sits in one project at a time.
type Room = {
  id: string
  state: State
  // In-memory only. waiting: seats blocked in a wait call right now.
  // standby: seats that run a wait loop, until this time; the room delivers
  // to them through the loop instead of waking them with a command.
  waiting?: Map<string, number>
  standby?: Map<string, number>
  // Questions whose asker is blocked in bench_ask right now: the answer goes
  // back through that call, so it must not also wake the asker.
  asking?: Set<string>
  // The seat writing a summary, and the seq its material ends at.
  summaryJob?: { agentId: string; upToSeq: number; flowsAt?: Record<string, number> }
}

type ProjectRecord = { id: string; name: string; dir?: string; createdAt: number }

type Runtime = {
  dbBacked?: boolean
  dataPath?: string
  projects: ProjectRecord[]
  rooms: Map<string, Room>
  bus: EventEmitter
  // Which project the code running now acts on. Routes enter it once
  // (`inProject`, `inSeat`); everything they call, and the wakes they start,
  // carry it along.
  scope: AsyncLocalStorage<string>
}

const globalStore = globalThis as typeof globalThis & { __benchRooms?: Runtime }

function emptyState(): State {
  return { rev: 0, seq: 0, agents: [], messages: [], tasks: [] }
}

function loadRoomFromDb(row: ReturnType<typeof dbLoadProjects>[number], prev?: Room): Room {
  let summary: RoomSummary | undefined
  if (row.summaryJson) {
    try {
      summary = JSON.parse(row.summaryJson) as RoomSummary
    } catch {}
  }
  const agents = dbLoadSeats<Agent>(row.id)
  return {
    id: row.id,
    state: {
      rev: row.rev,
      seq: row.seq,
      agents,
      messages: dbLoadRecentMessages(row.id, HOT_MESSAGES),
      tasks: dbLoadTasks(row.id),
      summary,
      summarySkipSeq: row.summarySkipSeq ?? undefined,
      relayClosed: row.relayClosed || undefined,
    },
    waiting: prev?.waiting,
    standby: prev?.standby,
    asking: prev?.asking,
    summaryJob: prev?.summaryJob,
  }
}

function runtime(): Runtime {
  const currentDataPath = process.env.BENCH_DATA_DIR || ""
  const prev = globalStore.__benchRooms
  if (!prev || !prev.dbBacked || prev.dataPath !== currentDataPath) {
    const bus = prev?.bus ?? new EventEmitter()
    bus.setMaxListeners(200)
    const scope = prev?.scope ?? new AsyncLocalStorage<string>()
    let rows = dbLoadProjects()
    if (rows.length === 0) {
      const first: ProjectRecord = { id: uid("p"), name: "默认项目", createdAt: Date.now() }
      dbSaveProject(first, 0, emptyState())
      rows = dbLoadProjects()
    }
    const projects: ProjectRecord[] = rows.map((r) => ({
      id: r.id,
      name: r.name,
      dir: r.dir,
      createdAt: r.createdAt,
    }))
    const rooms = new Map(rows.map((r) => [r.id, loadRoomFromDb(r, prev?.rooms.get(r.id))]))
    const next: Runtime = { dbBacked: true, dataPath: currentDataPath, projects, rooms, bus, scope }
    globalStore.__benchRooms = next
    return next
  }
  return prev
}

// The room the running code acts on.
function room(): Room {
  const rt = runtime()
  const id = rt.scope.getStore()
  const found = id ? rt.rooms.get(id) : undefined
  if (found) return found
  throw new ApiError(400, id ? "这个项目不在了" : "没指明是哪个项目")
}

export function currentProject() {
  return room().id
}

export function currentProjectInfo() {
  return projectInfo(room().id)
}

// For callbacks that run later (a wake's output, its timers): they act on the
// project that is current now. Once that project is deleted they do nothing.
export function bindProject<A extends unknown[]>(fn: (...args: A) => void) {
  const id = currentProject()
  return (...args: A) => {
    if (runtime().rooms.has(id)) runtime().scope.run(id, () => fn(...args))
  }
}

export function inProject<T>(id: string, fn: () => T): T {
  if (!runtime().rooms.has(id)) throw new ApiError(404, "没有这个项目")
  return runtime().scope.run(id, fn)
}

// The project a seat sits in. Seat ids are unique across projects.
// Whether a seat always has full permission (any project; lib/permits.ts).
export function autoFullOf(agentId: string) {
  const id = projectOfSeat(agentId)
  if (!id) return false
  return runtime().scope.run(id, () => Boolean(findAgent(agentId)?.autoFull))
}

// From the seat menu: always full permission when woken, or ask again.
export function setAutoFull(agentId: string, on: boolean) {
  const agent = findAgent(agentId)
  if (!agent) throw new ApiError(404, "这个席位不在了")
  if (on) agent.autoFull = true
  else delete agent.autoFull
  commit()
  return present(agent, Date.now())
}

export function projectOfSeat(agentId: string) {
  for (const [id, item] of runtime().rooms) if (item.state.agents.some((agent) => agent.id === agentId)) return id
  return undefined
}

export function inSeat<T>(agentId: string, fn: () => T): T {
  const id = projectOfSeat(agentId)
  if (!id) throw new ApiError(404, "这个席位不在了")
  return runtime().scope.run(id, fn)
}

// What a request acts on: the seat it comes from, the project it names
// (body or ?project=), or the only project there is.
export function inRequest<T>(input: { agentId?: unknown; project?: unknown }, fn: () => T): T {
  if (typeof input.agentId === "string" && input.agentId) return inSeat(input.agentId, fn)
  const named = typeof input.project === "string" ? input.project.trim() : ""
  if (named) return inProject(findProject(named).id, fn)
  const all = runtime().projects
  if (all.length === 1) return inProject(all[0].id, fn)
  throw new ApiError(400, `没指明是哪个项目（有：${all.map((item) => item.name).join("、")}）`)
}

function findProject(ref: string) {
  const all = runtime().projects
  const lower = ref.toLowerCase()
  const found = all.find((item) => item.id === ref) ?? all.find((item) => item.name.toLowerCase() === lower)
  if (!found) throw new ApiError(404, `没有叫「${ref}」的项目（有：${all.map((item) => item.name).join("、")}）`)
  return found
}

function projectInfo(id: string): ProjectInfo {
  const found = runtime().projects.find((item) => item.id === id)
  if (!found) throw new ApiError(404, "没有这个项目")
  return { id: found.id, name: found.name, dir: found.dir, createdAt: found.createdAt }
}

function saveProjects() {
  const rt = runtime()
  inTransaction(() => {
    for (let i = 0; i < rt.projects.length; i++) {
      const p = rt.projects[i]
      const r = rt.rooms.get(p.id)
      dbSaveProject(p, i, r?.state ?? emptyState())
    }
  })
  rt.bus.emit("projects")
}

// The user's name in the room, one for every project, kept in SQLite meta.
// Before there was a setting it was always jinbao: a room that already has
// the user's messages goes on with the name they were said under.
const userStore = globalThis as typeof globalThis & { __benchUserName?: string; __benchUserDataPath?: string }

export function userName(): string {
  const currentDataPath = process.env.BENCH_DATA_DIR || ""
  if (userStore.__benchUserName && userStore.__benchUserDataPath === currentDataPath) {
    return userStore.__benchUserName
  }
  let name = dbGetMeta("user_name")
  if (!name) {
    for (const current of runtime().rooms.values()) {
      name ??= current.state.messages.findLast((message) => message.authorId === "human")?.authorName
    }
  }
  userStore.__benchUserName = name || "用户"
  userStore.__benchUserDataPath = currentDataPath
  return userStore.__benchUserName
}

// A new name for the user. What they said, the tasks they own and what they
// did on tasks now read with it, in every project (including full SQLite history).
export function setUserName(input: unknown) {
  const name = asString(input)?.trim()
  checkName(name)
  const old = userName()
  if (name === old) return { name }
  const rt = runtime()
  for (const current of rt.rooms.values()) {
    if (current.state.agents.some((agent) => agent.name === name)) {
      throw new ApiError(409, `「${name}」已经是一个 AI 席位的名字，换一个，免得 @ 分不清`)
    }
  }
  inTransaction(() => {
    for (const current of rt.rooms.values()) {
      const state = current.state
      let touched = false
      for (const message of state.messages) {
        if (message.authorId === "human" && message.authorName !== name) {
          message.authorName = name
          touched = true
        }
      }
      dbRewriteMessages(current.id, (message) => {
        if (message.authorId === "human" && message.authorName !== name) {
          message.authorName = name
          touched = true
          return true
        }
        return false
      })
      for (const task of state.tasks) {
        let taskTouched = false
        if (task.ownerId === "human") {
          task.ownerName = name
          taskTouched = true
        }
        if (task.review?.by === old) {
          task.review.by = name
          taskTouched = true
        }
        for (const item of [...task.history, ...(task.steps ?? [])]) {
          if ("actor" in item && item.actor === old) item.actor = name
          else if ("by" in item && item.by === old) item.by = name
          else continue
          taskTouched = true
        }
        if (taskTouched) {
          touched = true
          dbPutTask(current.id, task)
        }
      }
      if (touched) {
        state.rev += 1
        dbSaveRoomHeader(current.id, state)
        rt.bus.emit("room", current.id)
      }
    }
    dbSetMeta("user_name", name)
  })
  userStore.__benchUserName = name
  userStore.__benchUserDataPath = process.env.BENCH_DATA_DIR || ""
  return { name }
}

export function listProjects(): Project[] {
  const now = Date.now()
  return runtime().projects.map((item) =>
    inProject(item.id, () => {
      const state = room().state
      const seats = state.agents.map((agent) => present(agent, now))
      const asking = new Set([
        ...permitsFor(item.id).map((permit) => permit.agentId),
        ...dbOpenAskAuthorIds(item.id),
      ])
      const review = new Set(state.tasks.filter(awaitingReview).flatMap((task) => (task.ownerId ? [task.ownerId] : [])))
      const spoke = new Map<string, number>()
      for (const message of state.messages) if (message.kind !== "system") spoke.set(message.authorId, message.createdAt)
      const rank = (agent: PublicAgent) => (agent.status === "working" ? 0 : asking.has(agent.id) ? 1 : 2)
      const bench = [...seats]
        .sort((a, b) => rank(a) - rank(b) || (spoke.get(b.id) ?? b.createdAt) - (spoke.get(a.id) ?? a.createdAt))
        .slice(0, 3)
        // Who gets a place goes by what they're doing; where they sit goes by
        // when they joined, so seats don't swap places as statuses change.
        .sort((a, b) => a.createdAt - b.createdAt)
        .map((agent) => ({
          id: agent.id,
          name: agent.name,
          color: agent.color,
          agentName: agent.agentName,
          model: agent.model,
          demo: agent.demo,
          status: agent.status,
          waiting: asking.has(agent.id),
          review: review.has(agent.id),
          saidAt: spoke.get(agent.id),
        }))
      return {
        ...projectInfo(item.id),
        seats: seats.length,
        online: seats.filter((agent) => agent.status !== "offline").length,
        working: seats.filter((agent) => agent.status === "working").length,
        lastAt: Math.max(item.createdAt, state.messages.at(-1)?.createdAt ?? 0),
        lastOtherAt: state.messages.findLast((message) => message.kind !== "system" && message.authorId !== "human")?.createdAt ?? 0,
        waiting: permitsFor(item.id).length + dbCountOpenAsks(item.id) + state.tasks.filter(awaitingReview).length,
        bench,
        names: seats.map((agent) => agent.name),
        lastEnd: lastEndOf(state.messages),
      }
    }),
  )
}

// The newest 「【本轮结束】」 a seat posted: the page turns a new one in a
// project the user isn't looking at into a desktop notification.
function lastEndOf(messages: Message[]): ProjectEnd | undefined {
  const found = messages.findLast((message) => message.end && !message.recalled && message.authorId !== "human")
  if (!found) return undefined
  const text = found.text.replace(END_MARK, "").replace(/\s+/g, " ").trim()
  return { id: found.id, at: found.createdAt, name: found.authorName, color: found.authorColor, text: text.length > 140 ? `${text.slice(0, 139)}…` : text }
}

function projectFields(body: Record<string, unknown>, current?: ProjectRecord) {
  const name = body.name === undefined && current ? current.name : clip(asString(body.name) ?? "", 24)
  if (!name) throw new ApiError(400, "给项目起个名字")
  if (/[「」"\n]/.test(name)) throw new ApiError(400, "项目名里不要有引号、「」或换行")
  const taken = runtime().projects.find((item) => item.name.toLowerCase() === name.toLowerCase() && item.id !== current?.id)
  if (taken) throw new ApiError(409, `已经有叫「${name}」的项目了`)
  let dir = current?.dir
  if (body.dir !== undefined) {
    const raw = (asString(body.dir) ?? "").replace(/^~(?=\/|$)/, homedir())
    if (!raw) dir = undefined
    else {
      if (!path.isAbsolute(raw)) throw new ApiError(400, "目录要填完整路径，比如 /home/you/project 或 C:\\work\\project")
      const resolved = path.resolve(raw)
      if (!existsSync(resolved)) throw new ApiError(400, `${resolved} 不存在`)
      dir = resolved
    }
  }
  return { name, dir }
}

export function createProject(input: unknown) {
  const fields = projectFields(asRecord(input))
  const record: ProjectRecord = { id: uid("p"), ...fields, createdAt: Date.now() }
  const rt = runtime()
  rt.projects.push(record)
  rt.rooms.set(record.id, { id: record.id, state: emptyState() })
  saveProjects()
  return { project: projectInfo(record.id) }
}

export function updateProject(id: string, input: unknown) {
  const record = runtime().projects.find((item) => item.id === id)
  if (!record) throw new ApiError(404, "没有这个项目")
  Object.assign(record, projectFields(asRecord(input), record))
  saveProjects()
  inProject(id, () => {
    bumpRev()
    commit()
  })
  return { project: projectInfo(id) }
}

// Deletes a project and everything in its room. The seats' sessions are left
// alone; they can join another project.
export function deleteProject(id: string) {
  const rt = runtime()
  if (!rt.rooms.has(id)) throw new ApiError(404, "没有这个项目")
  if (rt.projects.length === 1) throw new ApiError(400, "至少要留一个项目")
  rt.projects = rt.projects.filter((item) => item.id !== id)
  rt.rooms.delete(id)
  dbDeleteProject(id)
  saveProjects()
  rt.bus.emit("room", id)
  return { deleted: id }
}

// Which project a joining seat goes into: the one it names; else the one this
// session already sits in; else the one whose folder holds its working
// directory (the deepest such folder); else the only project there is.
export function pickProject(input: unknown): ProjectInfo {
  const body = asRecord(input)
  const named = asString(body.project)
  if (named) return projectInfo(findProject(named).id)
  const agentName = asString(body.agentName ?? body.agent_name ?? body.agent)
  const uuid = asString(body.uuid ?? body.session)
  if (agentName && uuid) {
    for (const [id, item] of runtime().rooms) {
      if (item.state.agents.some((agent) => agent.agentName === agentName && agent.session === uuid)) return projectInfo(id)
    }
  }
  const cwd = asString(body.cwd)
  if (cwd && path.isAbsolute(cwd)) {
    const inside = runtime()
      .projects.filter((item) => item.dir && (cwd === item.dir || cwd.startsWith(`${item.dir}${path.sep}`)))
      .sort((a, b) => (b.dir?.length ?? 0) - (a.dir?.length ?? 0))
    if (inside[0]) return projectInfo(inside[0].id)
  }
  const all = runtime().projects
  if (all.length === 1) return projectInfo(all[0].id)
  const list = all.map((item) => `「${item.name}」${item.dir ? `（${item.dir}）` : ""}`).join("、")
  // Not 409: bridges from before projects read any 409 on join as "name taken".
  throw new ApiError(
    400,
    `房间里有几个项目：${list}。问用户进哪个，再调用 bench_join 并填 project。bench_join 没有 project 参数的话，你的 bench 工具是分项目之前的旧版，请用户重开这个会话再接入。`,
  )
}

function persist() {
  const current = room()
  inTransaction(() => {
    dbSaveRoomHeader(current.id, current.state)
    dbSyncSeats(current.id, current.state.agents)
  })
}

function emit() {
  runtime().bus.emit("room", room().id)
}

// Changes to one project's room.
export function subscribe(project: string, listener: () => void) {
  const bus = runtime().bus
  const on = (id: string) => id === project && listener()
  bus.on("room", on)
  return () => bus.off("room", on)
}

// Changes to the project list, or to what it shows of each project.
export function subscribeProjects(listener: () => void) {
  const bus = runtime().bus
  bus.on("projects", listener)
  bus.on("room", listener)
  return () => {
    bus.off("projects", listener)
    bus.off("room", listener)
  }
}

// Called inside the message's project, so the listener acts on it too.
export function onMessage(listener: (message: Message) => void) {
  const bus = runtime().bus
  bus.on("message", listener)
  return () => bus.off("message", listener)
}

function uid(prefix: string) {
  return `${prefix}_${randomBytes(4).toString("hex")}`
}

function colorFor(name: string) {
  let hash = 0
  for (const char of name) hash = (hash * 33 + char.charCodeAt(0)) >>> 0
  return COLORS[hash % COLORS.length] ?? COLORS[0]
}

function publicBindings(list: SeatBinding[] | undefined): PublicSeatBinding[] | undefined {
  if (!list || list.length === 0) return undefined
  return list.map(({ session: _session, ...rest }, index) => {
    void _session
    return { ...rest, index }
  })
}

function present(agent: Agent, now = Date.now()): PublicAgent {
  // A seat the room has woken is working until that run ends, even through a
  // quiet stretch (a client queueing, a long command) longer than STALE_MS.
  const run = activeRun(agent.id)
  const laneView = readLaneSnapshot(agent.id)
  const hasProfile = Boolean(agent.profile && (agent.profile.persona.trim() || agent.profile.memory.trim()))
  return {
    id: agent.id,
    name: agent.name,
    model: agent.model,
    modelPick: agent.modelPick,
    effortPick: agent.effortPick,
    windowPick: agent.windowPick,
    compactPct: agent.compactPct,
    role: agent.role,
    strengths: agent.strengths,
    status: run ? "working" : liveStatus(agent.status, agent.lastSeenAt, now),
    doing: agent.doing,
    color: agent.color,
    demo: agent.demo,
    agentName: agent.agentName ?? "",
    hasSession: Boolean(agent.agentName && agent.session),
    callable: Boolean(agent.agentName && agent.session) && hasAdapter(agent.agentName ?? ""),
    standby: (waitingOf().get(agent.id) ?? 0) > 0,
    runId: run?.id,
    runStartedAt: run?.startedAt,
    stepAt: run ? (run.steps.at(-1)?.at ?? run.startedAt) : undefined,
    fullAccess: hasFull(agent.id) || undefined,
    autoFull: agent.autoFull || undefined,
    terminal: terminalOpen(agent.id) || undefined,
    queuedCount: laneView?.queuedCount || undefined,
    queuePaused: laneView?.paused || undefined,
    queuedItems: laneView && laneView.queuedItems.length > 0 ? laneView.queuedItems.slice(0, 20) : undefined,
    hasProfile: hasProfile || undefined,
    previousBindings: publicBindings(agent.previousBindings),
    createdAt: agent.createdAt,
    lastSeenAt: agent.lastSeenAt,
  }
}

function sortAgents(agents: PublicAgent[]) {
  const rank: Record<AgentStatus, number> = {
    working: 0,
    blocked: 1,
    idle: 2,
    offline: 3,
  }
  return [...agents].sort(
    (a, b) => rank[a.status] - rank[b.status] || b.lastSeenAt - a.lastSeenAt,
  )
}

function sortTasks(tasks: Task[]) {
  const rank: Record<TaskStatus, number> = { doing: 0, blocked: 1, open: 2, done: 3 }
  return [...tasks].sort(
    (a, b) => rank[a.status] - rank[b.status] || b.updatedAt - a.updatedAt,
  )
}

function snapshotTasks(tasks: Task[]): Task[] {
  const sorted = sortTasks(tasks)
  const active = sorted.filter((t) => t.status !== "done")
  const done = sorted.filter((t) => t.status === "done").slice(0, SNAPSHOT_DONE_TASKS)
  return [...active, ...done]
}

export function snapshot(): RoomSnapshot {
  const current = room()
  const state = current.state
  const talk = talkSince(summaryBase())
  const chars = talk.reduce((sum, message) => sum + withAttachments(message.text, message.attachments).length, 0)
  const firstHotSeq = state.messages[0]?.seq
  const openAsks = firstHotSeq !== undefined && firstHotSeq > 1 ? dbLoadOpenAsks(current.id, firstHotSeq) : undefined
  const totalMessages = dbCountMessages(current.id)
  return {
    project: projectInfo(current.id),
    agents: sortAgents(state.agents.map((agent) => present(agent))),
    messages: state.messages,
    tasks: snapshotTasks(state.tasks),
    openAsks: openAsks && openAsks.length > 0 ? openAsks : undefined,
    totalMessages,
    seq: state.seq,
    rev: state.rev,
    summary: state.summary ?? null,
    sinceSummary: { count: talk.length, chars },
    summaryDue: chars >= CATCH_UP_CHARS,
    summaryWriter: current.summaryJob?.agentId ?? null,
    relayClosed: state.relayClosed === true,
    permits: permitsFor(current.id),
    userName: userName(),
  }
}

function summaryBase() {
  const state = room().state
  return Math.max(state.summary?.upToSeq ?? 0, state.summarySkipSeq ?? 0)
}

function talkSince(after: number) {
  const current = room()
  const firstHotSeq = current.state.messages[0]?.seq
  if (firstHotSeq !== undefined && after < firstHotSeq - 1) {
    return dbLoadTalkAfter(current.id, after)
  }
  return current.state.messages.filter((message) => message.seq > after && message.kind !== "system" && !message.recalled)
}

// A message as an agent reads it: its id, so it can answer that one, and
// what it was answering. The summary writer gets them without ids.
// `viewer`: the seat the line is for, which a verdict on its own task names as 你.
function talkLine(message: Message, ids = true, viewer?: string) {
  const time = new Date(message.createdAt).toTimeString().slice(0, 5)
  const head = ids ? `${time} [${message.id}] ${message.authorName}` : `${time} ${message.authorName}`
  const answer = replyOf(message)
  const hint = answer ? `（回复${ids ? ` [${answer.id}]` : ""} ${answer.authorName}：${answer.gist}）` : ""
  return `${head}${hint}：${withAttachments(message.text, message.attachments)}${verdictNote(message, ids, viewer)}`
}

function verdictNote(message: Message, ids: boolean, viewer?: string) {
  const owner = message.verdict?.ownerId
  if (!owner) return ""
  const name = owner === viewer ? "你" : (findAgent(owner)?.name ?? "已离开的席位")
  return ids ? `（负责人：${name}，席位 ${owner}，待办 ${message.verdict?.taskId}）` : `（负责人：${name}）`
}

// One line of a message, enough to tell which one is meant.
function gist(message: Message) {
  const line = message.text.replace(/\s+/g, " ").trim()
  if (!line) return message.attachments?.length ? `[附件 ${message.attachments.length} 个]` : ""
  return line.length > 30 ? `${line.slice(0, 30)}…` : line
}

function findMessageAny(id: string | undefined): Message | undefined {
  if (!id) return undefined
  const current = room()
  return current.state.messages.find((item) => item.id === id) ?? dbGetMessage(current.id, id) ?? undefined
}

// The message this one answers, if it is still in the room.
function replyOf(message: Message) {
  if (!message.replyTo) return undefined
  const target = findMessageAny(message.replyTo)
  return target ? { id: target.id, authorName: target.authorName, gist: gist(target) } : undefined
}

function withReply(message: Message) {
  const reply = replyOf(message)
  return reply ? { ...message, reply } : message
}

// A message as data, for an agent that wants the whole thread the way the
// page shows it: who said it (a person, an agent or the room), whom it calls,
// what it answers, what it carries.
function structured(message: Message) {
  const names = (ids: string[]) => ids.map((id) => findAgent(id)?.name ?? id)
  return {
    id: message.id,
    seq: message.seq,
    kind: message.kind,
    at: new Date(message.createdAt).toISOString(),
    author: {
      id: message.authorId,
      name: message.authorName,
      type: message.authorId === "human" ? "human" : message.authorId === "room" ? "room" : "agent",
    },
    text: message.text,
    mentions: names(message.mentions),
    replyTo: message.replyTo,
    reply: replyOf(message),
    attachments: message.attachments,
    ask: message.ask,
    recalled: message.recalled ? true : undefined,
    taskId: message.taskId,
    verdict: message.verdict && {
      taskId: message.verdict.taskId,
      state: message.verdict.state,
      owner: message.verdict.ownerId
        ? { id: message.verdict.ownerId, name: findAgent(message.verdict.ownerId)?.name ?? null }
        : null,
    },
    handoff: message.handoff,
    end: message.end,
  }
}

const MESSAGES_LIMIT = 200

// The room's talk as data, backed by full SQLite history.
// `chain`: every message of the reply chain that message is in.
// `about`: what a seat said, was called in, or handed on.
// `q`: full-text / substring search across messages.
// `before`: only messages older than that seq, to page back. Newest `limit` kept.
export function messagesFor(input: unknown) {
  const body = asRecord(input)
  actorFrom(body)
  const current = room()
  const singleId = asString(body.id)
  if (singleId) {
    const found = findMessageAny(singleId)
    if (!found) throw new ApiError(404, "这条消息不在房间里了")
    return { messages: [structured(found)], raw: [found], hasMore: false, roomSeq: current.state.seq }
  }
  const chain = asString(body.chain)
  if (chain && !findMessageAny(chain)) {
    throw new ApiError(404, "这条消息不在房间里了")
  }
  const about = asString(body.about)
  let seatId: string | undefined
  if (about) {
    const seat = resolveAgent(about)
    if (!seat) throw new ApiError(404, `没有叫 ${about} 的席位`)
    seatId = seat.id
  }
  const query = asString(body.q ?? body.query)?.trim() || undefined
  const before = Number(body.before ?? 0)
  const beforeSeq = Number.isFinite(before) && before > 0 ? before : undefined
  const asked = Number(body.limit ?? 50)
  const limit = Math.min(MESSAGES_LIMIT, Math.max(1, Number.isFinite(asked) ? Math.floor(asked) : 50))
  const { messages: page, hasMore } = dbQueryMessages(current.id, {
    chainId: chain || undefined,
    seatId,
    query,
    beforeSeq,
    limit,
  })
  return {
    messages: page.map(structured),
    raw: body.raw === true ? page : undefined,
    hasMore,
    roomSeq: current.state.seq,
  }
}

function bumpRev() {
  room().state.rev += 1
}

// Every project's room, when something they all show changed (the wake commands).
export function refreshRooms() {
  for (const id of runtime().rooms.keys()) {
    inProject(id, () => {
      bumpRev()
      commit()
    })
  }
}

// These messages were handed to a seat in the middle of its run.
export function markReached(ids: string[], agentId: string) {
  const agent = findAgent(agentId)
  if (!agent) return
  const current = room()
  const at = Date.now()
  inTransaction(() => {
    for (const id of ids) {
      const hot = current.state.messages.find((m) => m.id === id)
      const target = hot ?? dbGetMessage(current.id, id)
      if (!target) continue
      const list = (target.reached ?? []).filter((item) => item.id !== agent.id)
      target.reached = [...list, { id: agent.id, name: agent.name, at }]
      dbPutMessage(current.id, target)
    }
  })
  bumpRev()
  commit()
}

// Something the snapshot shows changed outside the room's own state.
export function roomChanged() {
  bumpRev()
  emit()
}

function nextSeq() {
  const state = room().state
  state.seq += 1
  state.rev += 1
  return state.seq
}

function commit() {
  persist()
  emit()
}

function findAgent(id: string) {
  return room().state.agents.find((agent) => agent.id === id)
}

function resolveAgent(ref: string) {
  const agents = room().state.agents
  return (
    agents.find((agent) => agent.id === ref || agent.name === ref) ??
    agents.find((agent) => agent.formerNames?.includes(ref))
  )
}

function checkName(name: string | undefined): asserts name is string {
  if (!name || !NAME_RE.test(name) || RESERVED.has(name.toLowerCase()) || RESERVED.has(name)) {
    throw new ApiError(400, "名字用 1 到 24 个字母、数字或中文，不要空格，方便别人 @你")
  }
}

// Mentions are kept as seat ids; the name is only how they read. A message
// is said in current names: an @ to a seat's former name becomes its name
// now, so who it reaches is settled when it is sent.
function lockMentions(text: string) {
  const agents = room().state.agents
  const current = new Set(agents.map((agent) => agent.name))
  let out = text
  for (const agent of agents) {
    for (const old of agent.formerNames ?? []) {
      if (!current.has(old)) out = out.replace(mentionPattern(old), `@${agent.name}`)
    }
  }
  return { text: out, mentions: mentionedAgentIds(out, agents) }
}

// A new name for a seat, by the user from the page or by the seat itself
// (bench_join with another name). Everything that points at the seat holds
// its id, so the old messages follow: what it said and the @s to it now read
// with the new name.
export function renameAgent(id: string, input: unknown) {
  const agent = findAgent(id)
  if (!agent) throw new ApiError(404, "这个席位不在了")
  const name = asString(input)?.trim()
  checkName(name)
  const old = agent.name
  if (name === old) return { agent: present(agent) }
  const current = room()
  if (current.state.agents.some((other) => other.id !== id && other.name === name)) {
    throw new ApiError(409, `已经有人叫 ${name}，换个名字`)
  }
  agent.name = name
  agent.formerNames = [old, ...(agent.formerNames ?? []).filter((item) => item !== name && item !== old)].slice(0, 5)
  const pattern = mentionPattern(old)
  inTransaction(() => {
    for (const message of current.state.messages) {
      if (message.authorId === id) message.authorName = name
      if (message.mentions.includes(id)) message.text = message.text.replace(pattern, `@${name}`)
    }
    dbRewriteMessages(current.id, (message) => {
      let changed = false
      if (message.authorId === id && message.authorName !== name) {
        message.authorName = name
        changed = true
      }
      if (message.mentions.includes(id)) {
        const replaced = message.text.replace(pattern, `@${name}`)
        if (replaced !== message.text) {
          message.text = replaced
          changed = true
        }
      }
      return changed
    })
    for (const task of current.state.tasks) {
      if (task.ownerId === id) {
        task.ownerName = name
        dbPutTask(current.id, task)
      }
    }
  })
  if (agent.profile) writeSeatMarkdown(agent.id, agent.name, agent.role, agent.profile)
  postSystem(`${old} 改名为 ${name}，之后 @${name}；@${old} 也还能找到它`)
  return { agent: present(agent) }
}

// ---- Seat profile (persona & long-term memory) and cross-vendor rebinding ----

export function getSeatProfile(id: string) {
  const agent = findAgent(id)
  if (!agent) throw new ApiError(404, "这个席位不在了")
  return {
    agent: present(agent),
    profile: agent.profile ?? { persona: "", memory: "", updatedAt: 0 },
    markdownPath: seatMarkdownPath(agent.id),
  }
}

export function setSeatProfile(
  id: string,
  input: { persona?: string; memory?: string },
  byAgentSelf = false,
) {
  const agent = findAgent(id)
  if (!agent) throw new ApiError(404, "这个席位不在了")
  const persona =
    input.persona !== undefined
      ? clip(input.persona.trim(), MAX_PERSONA_CHARS)
      : (agent.profile?.persona ?? "")
  const memory =
    input.memory !== undefined
      ? clip(input.memory.trim(), MAX_MEMORY_CHARS)
      : (agent.profile?.memory ?? "")
  const updatedAt = Date.now()
  if (!persona && !memory) {
    delete agent.profile
  } else {
    agent.profile = { persona, memory, updatedAt }
  }
  if (!byAgentSelf) agent.profileDirty = true
  writeSeatMarkdown(agent.id, agent.name, agent.role, agent.profile)
  bumpRev()
  commit()
  return {
    agent: present(agent),
    profile: agent.profile ?? { persona: "", memory: "", updatedAt },
    markdownPath: seatMarkdownPath(agent.id),
  }
}

function appendMemoryEntry(existing: string, note: string) {
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ")
  const formatted = note.startsWith("- ") || note.startsWith("* ") ? note : `- [${stamp}] ${note}`
  const combined = existing.trim() ? `${existing.trim()}\n${formatted}` : formatted
  if (combined.length <= MAX_MEMORY_CHARS) return combined
  // Trim oldest lines when full so new lessons always land cleanly.
  const lines = combined.split("\n")
  while (lines.length > 1 && lines.join("\n").length > MAX_MEMORY_CHARS) {
    lines.shift()
  }
  return lines.join("\n").slice(-MAX_MEMORY_CHARS)
}

export function memoryAction(input: unknown) {
  const body = asRecord(input)
  const actor = actorFrom(body)
  let target: Agent | undefined
  if (actor.type === "agent") {
    const named = asString(body.seat)
    target = named ? resolveAgent(named) : findAgent(actor.id)
    if (!target) throw new ApiError(404, "没有找到对应席位")
    const action = asString(body.action) ?? "read"
    if (action !== "read" && target.id !== actor.id) {
      throw new ApiError(403, "只能修改自己席位的长期记忆；看队友档案可用 action: read")
    }
  } else {
    const ref = asString(body.targetId ?? body.seat)
    if (!ref) throw new ApiError(400, "请指明席位 targetId 或 seat")
    target = resolveAgent(ref)
    if (!target) throw new ApiError(404, `没有叫 ${ref} 的席位`)
  }

  const action = asString(body.action) ?? "read"
  if (action === "read") {
    return getSeatProfile(target.id)
  }
  if (action === "append") {
    const note = clip((asString(body.note ?? body.text ?? body.memory ?? body.content) ?? "").trim(), 1500)
    if (!note) throw new ApiError(400, "要追加的记忆 note 不能为空")
    const nextMemory = appendMemoryEntry(target.profile?.memory ?? "", note)
    return setSeatProfile(target.id, { memory: nextMemory }, actor.type === "agent")
  }
  if (action === "replace") {
    const memory = body.memory !== undefined ? (asString(body.memory) ?? "") : undefined
    const persona =
      actor.type === "human" && body.persona !== undefined ? (asString(body.persona) ?? "") : undefined
    if (memory === undefined && persona === undefined) {
      throw new ApiError(400, "replace 需要提供 memory（或由用户提供 persona）")
    }
    return setSeatProfile(target.id, { persona, memory }, actor.type === "agent")
  }
  throw new ApiError(400, "action 只能是 read、append 或 replace")
}

// Compact seat briefing injected when a session is fresh, rebound across AI
// vendors, or after its persona/memory was edited.
export function seatBriefing(id: string): string {
  const agent = findAgent(id)
  if (!agent) return ""
  const blocks: string[] = []
  if (agent.reboundFrom) {
    blocks.push(
      `【跨客户端接力说明】你正在接手席位「${agent.name}」（分工：${agent.role}）。此前该席位运行在 ${agent.reboundFrom.agentName}（${agent.reboundFrom.model}），现已切换到当前客户端继续工作，你的席位身份、待办归属和工作目录保持不变。需要查看更早的房间讨论时，可用 bench_messages（支持 q 关键词搜索或 chain 回复链）按需翻阅。`,
    )
  }
  if (agent.profile?.persona?.trim()) {
    blocks.push(`【席位职责与规范】\n${agent.profile.persona.trim()}`)
  }
  if (agent.profile?.memory?.trim()) {
    blocks.push(`【席位长期记忆与备忘】（发现新的关键约定或踩坑结论时，可用 bench_memory 记录）\n${agent.profile.memory.trim()}`)
  }
  const ownedTasks = room().state.tasks.filter((t) => t.ownerId === id && t.status !== "done")
  if (ownedTasks.length > 0 && (agent.reboundFrom || agent.fresh)) {
    const taskLines = ownedTasks.map((t) => {
      const steps = (t.steps ?? [])
        .map((s, idx) => `  ${idx + 1}. [${s.state}] ${s.text}${s.note ? `（${s.note}）` : ""}`)
        .join("\n")
      const brief = t.brief ? `\n  交接记录：已完成 ${t.brief.done}；剩余 ${t.brief.left}；注意 ${t.brief.caveats}` : ""
      return `- [${t.id}] ${t.title}（状态：${t.status}）${t.detail ? `\n  说明：${clip(t.detail, 240)}` : ""}${brief}${steps ? `\n${steps}` : ""}`
    })
    blocks.push(`【当前由你负责的待办】\n${taskLines.join("\n")}`)
  }
  return blocks.join("\n\n")
}

// Internal seat credentials & metadata for `lib/spawn.ts` when rebinding a seat
// to another AI client while keeping the exact same seat id and token.
export function seatCredentials(id: string) {
  const agent = findAgent(id)
  if (!agent) throw new ApiError(404, "这个席位不在了")
  return {
    id: agent.id,
    token: agent.token,
    name: agent.name,
    role: agent.role,
    workdir: agent.workdir,
    agentName: agent.agentName,
    session: agent.session,
    model: agent.model,
    modelPick: agent.modelPick,
    effortPick: agent.effortPick,
    windowPick: agent.windowPick,
    compactPct: agent.compactPct,
    previousBindings: agent.previousBindings ? [...agent.previousBindings] : [],
  }
}

export function rebindAgent(
  id: string,
  input: {
    agentName: string
    session: string
    model: string
    modelPick?: string | null
    effortPick?: string | null
    workdir?: string
    fromRunId?: string
  },
) {
  const agent = findAgent(id)
  if (!agent) throw new ApiError(404, "这个席位不在了")
  const prevClient = agent.agentName || "未绑定"
  const prevModel = agent.model
  if (agent.agentName && agent.session && (agent.agentName !== input.agentName || agent.session !== input.session)) {
    const entry: SeatBinding = {
      agentName: agent.agentName,
      session: agent.session,
      model: agent.model,
      modelPick: agent.modelPick,
      effortPick: agent.effortPick,
      workdir: agent.workdir,
      switchedAt: Date.now(),
    }
    const rest = (agent.previousBindings ?? []).filter(
      (b) => !(b.agentName === entry.agentName && b.session === entry.session),
    )
    agent.previousBindings = [entry, ...rest].slice(0, 5)
  }
  agent.agentName = input.agentName
  agent.session = input.session
  agent.token = randomBytes(18).toString("hex")
  agent.model = clip(input.model || "默认模型", 48)
  if (input.modelPick) agent.modelPick = input.modelPick
  else delete agent.modelPick
  if (input.effortPick) agent.effortPick = input.effortPick
  else delete agent.effortPick
  if (input.workdir) agent.workdir = input.workdir
  agent.fresh = true
  agent.reboundFrom = { agentName: prevClient, model: prevModel, runId: input.fromRunId }
  agent.lastSeenAt = Date.now()
  if (agent.status === "offline") agent.status = "idle"
  standbyOf().delete(agent.id)
  postSystem(
    `${agent.name} 切换客户端：${prevClient}（${prevModel}）→ ${input.agentName}（${agent.model}），席位身份、待办与长期记忆已接续`,
  )
  leaveOtherProjects({ agentName: input.agentName, uuid: input.session }, agent.id)
  return { agent: present(agent), token: agent.token }
}

export function restoreAgentBinding(id: string, index: number) {
  const agent = findAgent(id)
  if (!agent) throw new ApiError(404, "这个席位不在了")
  const list = agent.previousBindings ?? []
  const target = list[index]
  if (!target) throw new ApiError(404, "没有找到这条历史会话记录")
  const prevClient = agent.agentName || "未绑定"
  const prevModel = agent.model
  const nextList = list.filter((_, i) => i !== index)
  if (agent.agentName && agent.session && (agent.agentName !== target.agentName || agent.session !== target.session)) {
    nextList.unshift({
      agentName: agent.agentName,
      session: agent.session,
      model: agent.model,
      modelPick: agent.modelPick,
      effortPick: agent.effortPick,
      workdir: agent.workdir,
      switchedAt: Date.now(),
    })
  }
  agent.previousBindings = nextList.slice(0, 5)
  agent.agentName = target.agentName
  agent.session = target.session
  agent.token = randomBytes(18).toString("hex")
  agent.model = target.model
  if (target.modelPick) agent.modelPick = target.modelPick
  else delete agent.modelPick
  if (target.effortPick) agent.effortPick = target.effortPick
  else delete agent.effortPick
  if (target.workdir) agent.workdir = target.workdir
  // Historical sessions already exist on disk in their client, so resume rather than create.
  agent.fresh = false
  agent.reboundFrom = { agentName: prevClient, model: prevModel }
  agent.lastSeenAt = Date.now()
  if (agent.status === "offline") agent.status = "idle"
  standbyOf().delete(agent.id)
  postSystem(`${agent.name} 切回原客户端会话：${target.agentName}（${target.model}）`)
  leaveOtherProjects({ agentName: target.agentName, uuid: target.session }, agent.id)
  return { agent: present(agent), restored: target, token: agent.token }
}

// The user picks the model a seat's wakes run on; null goes back to the
// default of its command or client. Takes effect from its next wake.
// `window` (the most context it may hold) and `pct` (where it compacts, as a
// share of that): undefined leaves each as it is.
export function setSeatModel(
  id: string,
  pick: string | null,
  shown: string,
  effort: string | null = null,
  window?: number | null,
  pct?: number | null,
) {
  const agent = findAgent(id)
  if (!agent) throw new ApiError(404, "这个席位不在了")
  const sameModel = (agent.modelPick ?? null) === pick
  const sameEffort = (agent.effortPick ?? null) === effort
  const sameWindow = window === undefined || (agent.windowPick ?? null) === window
  const samePct = pct === undefined || (agent.compactPct ?? null) === pct
  if (sameModel && sameEffort && sameWindow && samePct) return { agent: present(agent) }
  if (pick) agent.modelPick = pick
  else delete agent.modelPick
  if (effort) agent.effortPick = effort
  else delete agent.effortPick
  if (window) agent.windowPick = window
  else if (window === null) delete agent.windowPick
  if (pct) agent.compactPct = pct
  else if (pct === null) delete agent.compactPct
  agent.model = shown
  const said = [
    sameModel ? "" : pick ? `改用 ${pick}` : "改回默认模型",
    sameEffort ? "" : effort ? `思考强度 ${effort}` : "思考强度改回默认",
    sameWindow ? "" : window ? `最大上下文 ${window / 10_000} 万` : "最大上下文改回模型自带的",
    samePct ? "" : pct ? `用到 ${pct}% 时自动压缩` : "自动压缩改回客户端自己的设置",
  ].filter(Boolean)
  postSystem(`${agent.name} 之后${said.join("，")}，下次被叫醒时生效`)
  return { agent: present(agent) }
}

function waitingOf() {
  return (room().waiting ??= new Map())
}

function standbyOf() {
  return (room().standby ??= new Map())
}

// On standby: blocked in a wait right now, or between two waits of a loop.
// Between waits only while its session is still there: the bridge pulses
// every 20 s while the client runs, so a seat whose pulses stopped (a woken
// run that called bench_wait and then ended) is woken the usual way again
// instead of having its mentions skipped until the grace runs out.
export function isStandby(id: string) {
  if ((waitingOf().get(id) ?? 0) > 0) return true
  if ((standbyOf().get(id) ?? 0) <= Date.now()) return false
  const agent = findAgent(id)
  return Boolean(agent && Date.now() - agent.lastSeenAt < STALE_MS + 20_000)
}

// Blocked in a wait call right now: a message reaches it at once.
export function isWaiting(id: string) {
  return (waitingOf().get(id) ?? 0) > 0
}

// A woken run of this seat ended: whatever wait loop it ran inside that run
// is over with it (lib/summon.ts).
export function clearStandby(id: string) {
  if (isWaiting(id)) return
  if (standbyOf().delete(id)) bumpRev()
}

export function agentState(id: string): Readonly<Agent> | undefined {
  return findAgent(id)
}

export function requireAgent(id: string, token: string) {
  const agent = findAgent(id)
  if (!agent || agent.token !== token) {
    throw new ApiError(401, "席位凭证不对，重新入座或检查 token")
  }
  return agent
}

function actorFrom(input: unknown): Actor {
  const body = asRecord(input)
  const agentId = asString(body.agentId)
  if (agentId) {
    const token = asString(body.token)
    if (!token) throw new ApiError(401, "缺少 token")
    const agent = requireAgent(agentId, token)
    return { type: "agent", id: agent.id, name: agent.name }
  }
  if (body.as === "human") return { type: "human", id: "human", name: userName() }
  throw new ApiError(400, "要带 agentId 和 token，或标明 as 为 human")
}

// Paths that exist on this computer, at most 10 to a message.
function attachmentsOf(value: unknown): Attachment[] | undefined {
  if (value == null) return undefined
  if (!Array.isArray(value)) throw new ApiError(400, "attachments 要是数组")
  if (value.length > 10) throw new ApiError(400, "一条消息最多带 10 个附件")
  const list = value.map((item) => {
    const entry = asRecord(item)
    const file = asString(entry.path) ?? ""
    const stat = path.isAbsolute(file) ? statSync(file, { throwIfNoEntry: false }) : undefined
    if (!stat) throw new ApiError(400, `附件不存在：${file || "（没有路径）"}`)
    // What it is comes from the disk, not from what the caller said.
    const kind = stat.isDirectory() ? "dir" : (mediaKind(file) ?? "file")
    const name = clip(asString(entry.name) || path.basename(file), 120)
    return { kind, name, path: path.resolve(file), size: stat.isDirectory() ? undefined : stat.size } as Attachment
  })
  return list.length ? list : undefined
}

function clip(value: string, max: number) {
  return value.length > max ? value.slice(0, max) : value
}

function agentKeyOf(value: unknown) {
  if (value == null || value === "") return undefined
  const name = asString(value)
  if (!name || !NAME_RE.test(name)) {
    throw new ApiError(400, "agent 名用 1 到 24 个字母、数字或中文，不要空格，比如 cursor")
  }
  return name
}

function uuidOf(value: unknown) {
  if (value == null || value === "") return undefined
  const uuid = asString(value)
  if (!uuid || !UUID_RE.test(uuid)) {
    throw new ApiError(400, "uuid 只能是字母、数字、点、下划线或短横线")
  }
  return uuid
}

function reportedLink(body: Record<string, unknown>) {
  const agentName = agentKeyOf(body.agentName ?? body.agent_name ?? body.agent)
  const uuid = uuidOf(body.uuid ?? body.session)
  if (!agentName && !uuid) return undefined
  if (!agentName || !uuid) {
    throw new ApiError(400, "要一起报 agent 名和 uuid，比如 agent_name:cursor,uuid:123456")
  }
  return { agentName, uuid }
}

function strengthsOf(value: unknown) {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 6)
    .map((item) => clip(item, 16))
}

export function join(input: unknown) {
  const body = asRecord(input)
  const token = asString(body.token)
  // The token finds the seat whatever it is called now, and it keeps that
  // name unless the call asks for a rename (bench_join with a new name sends
  // rename: true). Bridges from before renames always send the name they
  // remember, which must not undo a rename made from the page.
  const mine = token ? room().state.agents.find((agent) => agent.token === token) : undefined
  const name = mine && body.rename !== true ? mine.name : asString(body.name)
  checkName(name)
  const existing = mine ?? room().state.agents.find((agent) => agent.name === name)
  const model = clip(asString(body.model) || existing?.model || "未填模型", 48)
  const role = clip(asString(body.role) || existing?.role || "未分工", 24)
  const strengths = Array.isArray(body.strengths)
    ? strengthsOf(body.strengths)
    : (existing?.strengths ?? [])
  const link = reportedLink(body)

  if (existing) {
    if (!token || existing.token !== token) {
      throw new ApiError(409, `已经有人叫 ${name}。带上原来的 token 才能回到这个席位`)
    }
    if (
      link &&
      existing.agentName &&
      existing.session &&
      (link.agentName !== existing.agentName || link.uuid !== existing.session) &&
      existing.previousBindings?.some((b) => b.agentName === link.agentName && b.session === link.uuid)
    ) {
      throw new ApiError(409, `席位「${existing.name}」已切换到其他客户端会话，旧会话不能自动抢回；如需切回请在网页席位菜单操作`)
    }
    if (existing.name !== name) renameAgent(existing.id, name)
    existing.model = model
    existing.role = role
    existing.strengths = strengths
    if (link) {
      existing.agentName = link.agentName
      existing.session = link.uuid
    }
    existing.lastSeenAt = Date.now()
    if (existing.status === "offline") existing.status = "idle"
    bumpRev()
    commit()
    if (link) leaveOtherProjects(link, existing.id)
    return { agent: present(existing), token: existing.token, rejoined: true }
  }

  const agent: Agent = {
    id: uid("a"),
    token: randomBytes(18).toString("hex"),
    name,
    model,
    role,
    strengths,
    status: "idle",
    doing: clip(asString(body.doing) || "", 120),
    color: colorFor(name),
    demo: false,
    agentName: link?.agentName,
    session: link?.uuid,
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
  }
  room().state.agents.push(agent)
  appendMessage({
    kind: "system",
    authorId: "room",
    authorName: "并坐",
    authorColor: "#8a8175",
    authorDemo: false,
    text: `${name} 入座 · ${model} · ${role}${link ? ` · ${link.agentName}` : ""}`,
    mentions: [],
  })
  bumpRev()
  commit()
  if (link) leaveOtherProjects(link, agent.id)
  return { agent: present(agent), token: agent.token, rejoined: false }
}

// A session sits in one project at a time: seated here, it leaves the seat it
// had anywhere else.
function leaveOtherProjects(link: { agentName: string; uuid: string }, keep: string) {
  const here = projectInfo(room().id)
  for (const id of runtime().rooms.keys()) {
    if (id === here.id) continue
    inProject(id, () => {
      for (const agent of [...room().state.agents]) {
        if (agent.id !== keep && agent.agentName === link.agentName && agent.session === link.uuid) {
          removeAgent(agent.id, false, `${agent.name} 去了「${here.name}」`)
        }
      }
    })
  }
}

// A seat for a session the room is creating itself (「开新会话」). Returns the
// seat with its token, which the room hands to the session's bench tools.
export function seatCreated(input: {
  name: string
  role: string
  model: string
  modelPick?: string | null
  effortPick?: string | null
  windowPick?: number | null
  compactPct?: number | null
  agentName: string
  session: string
  workdir: string
  autoFull?: boolean
}) {
  if (room().state.agents.some((agent) => agent.name === input.name)) {
    throw new ApiError(409, `已经有人叫 ${input.name}，换个名字`)
  }
  const result = join({
    name: input.name,
    role: input.role,
    model: input.model,
    agentName: input.agentName,
    uuid: input.session,
    doing: "刚开的新会话，等第一次被点名",
  })
  const agent = findAgent(result.agent.id)
  if (agent) {
    agent.workdir = input.workdir
    agent.fresh = true
    if (input.modelPick) agent.modelPick = input.modelPick
    if (input.effortPick) agent.effortPick = input.effortPick
    if (input.windowPick) agent.windowPick = input.windowPick
    if (input.compactPct) agent.compactPct = input.compactPct
    if (input.autoFull) agent.autoFull = true
    commit()
    return { ...result, agent: present(agent) }
  }
  return result
}

// Its wake went through: clear fresh/rebound/profile-dirty flags, unless the
// seat was rebound to another client/session while that wake was running.
export function markWoken(
  id: string,
  wokenLink?: { agentName?: string; session?: string },
  rules?: { sig: string; at: number; short?: boolean },
) {
  const agent = findAgent(id)
  if (!agent) return
  if (wokenLink && (agent.agentName !== wokenLink.agentName || agent.session !== wokenLink.session)) {
    return
  }
  // What the wake said of the house rules: whole (from now on the reference)
  // or the short reminder.
  if (rules) {
    agent.rulesGiven = rules.short && agent.rulesGiven
      ? { ...agent.rulesGiven, shorts: agent.rulesGiven.shorts + 1 }
      : { sig: rules.sig, at: rules.at, session: agent.session, shorts: 0 }
  }
  if (!agent.fresh && !agent.profileDirty && !agent.reboundFrom) {
    if (rules) commit()
    return
  }
  agent.fresh = false
  delete agent.profileDirty
  delete agent.reboundFrom
  commit()
}

// The demo seats (阿证、阿构、阿衡) are gone; a room saved with them still
// seated drops them quietly.
let demosDropped = false
export function dropDemoSeats() {
  if (demosDropped) return
  demosDropped = true
  for (const id of runtime().rooms.keys()) {
    inProject(id, () => {
      for (const agent of [...room().state.agents]) if (agent.demo) removeAgent(agent.id, true)
    })
  }
}

export function registerSession(input: unknown) {
  const body = asRecord(input)
  const actor = actorFrom(body)
  if (actor.type !== "agent") throw new ApiError(400, "只有入座的 agent 能报会话")
  const agent = findAgent(actor.id)
  if (!agent) throw new ApiError(404, "这个席位不在了")
  if (agent.demo) throw new ApiError(400, "演示席位不用报会话")
  const link = reportedLink(body)
  if (!link) throw new ApiError(400, "要一起报 agent 名和 uuid，比如 agent_name:cursor,uuid:123456")
  if (
    agent.agentName &&
    agent.session &&
    (link.agentName !== agent.agentName || link.uuid !== agent.session) &&
    agent.previousBindings?.some((b) => b.agentName === link.agentName && b.session === link.uuid)
  ) {
    throw new ApiError(409, `席位「${agent.name}」已切换到其他客户端会话，旧会话不能覆盖当前绑定`)
  }
  const changed = agent.agentName !== link.agentName || agent.session !== link.uuid
  agent.agentName = link.agentName
  agent.session = link.uuid
  agent.lastSeenAt = Date.now()
  if (changed) postSystem(`${agent.name} 报了 ${link.agentName}`)
  else {
    bumpRev()
    commit()
  }
  if (changed) leaveOtherProjects(link, agent.id)
  return { agent: present(agent) }
}

export function summonCandidates(message: Message) {
  if (message.kind === "system" || message.recalled) return []
  const ids = new Set(namedAgentIds(message.text, room().state.agents))
  if (message.handoff?.toId) ids.add(message.handoff.toId)
  // The user replying to an agent calls it, no @ needed. Between agents a
  // reply alone doesn't: every wake's answer replies to what woke it, and
  // that would bounce back and forth.
  const answered = message.authorId === "human" && message.replyTo ? findMessageAny(message.replyTo) : undefined
  if (answered && findAgent(answered.authorId)) ids.add(answered.authorId)
  ids.delete(message.authorId)
  // An answer the asker is waiting for in bench_ask reaches it there.
  if (answered?.ask?.answerId === message.id && answered.ask.handed) ids.delete(answered.authorId)
  const found: { id: string; name: string; agentName?: string; session?: string }[] = []
  for (const id of ids) {
    const agent = findAgent(id)
    if (!agent || agent.demo) continue
    found.push({
      id: agent.id,
      name: agent.name,
      agentName: agent.agentName,
      session: agent.session,
    })
  }
  return found
}

export function pulse(input: unknown) {
  const body = asRecord(input)
  const actor = actorFrom(body)
  if (actor.type !== "agent") throw new ApiError(400, "只有入座的 agent 能报进度")
  // Presence only: the MCP bridge keeps a seat online without touching its status line.
  if (body.keepalive === true && body.status === undefined) {
    touch(actor.id)
    const agent = findAgent(actor.id)
    if (!agent) throw new ApiError(404, "这个席位不在了")
    return { agent: present(agent) }
  }
  const status = asString(body.status) as AgentStatus | undefined
  if (!status || !STATUSES.has(status) || status === "offline") {
    throw new ApiError(400, "status 只能是 idle、working 或 blocked")
  }
  const doing = clip(asString(body.doing) ?? "", 120)
  return pulseAgent(actor.id, status, doing)
}

export function pulseAgent(id: string, status: AgentStatus, doing: string) {
  const agent = findAgent(id)
  if (!agent) throw new ApiError(404, "这个席位不在了")
  agent.status = status
  agent.doing = clip(doing, 120)
  agent.lastSeenAt = Date.now()
  bumpRev()
  commit()
  return { agent: present(agent) }
}

export function touch(id: string) {
  const agent = findAgent(id)
  if (!agent) return
  agent.lastSeenAt = Date.now()
  bumpRev()
  commit()
}

// Files a woken seat pinned with bench_attach go out with the next thing it
// says in that wake: its posted answer, or a bench_say. Kept in memory only.
type Pinned = { runId: string; list: Attachment[] }
type PinGlobal = typeof globalThis & { __benchPinned?: Map<string, Pinned> }

function pinned() {
  const store = globalThis as PinGlobal
  store.__benchPinned ??= new Map()
  return store.__benchPinned
}

export function pinAttachments(input: unknown) {
  const body = asRecord(input)
  const actor = actorFrom(body)
  const agent = actor.type === "agent" ? findAgent(actor.id) : undefined
  if (!agent) throw new ApiError(400, "只有席位能挂附件")
  const run = activeRun(agent.id)
  if (!run) throw new ApiError(409, "不在一次唤起里：直接用 bench_say 的 attachments 发")
  const paths = Array.isArray(body.paths) ? body.paths : []
  const added = attachmentsOf(paths.map((item) => ({ path: item }))) ?? []
  if (added.length === 0) throw new ApiError(400, "paths 里至少给一个本机绝对路径")
  const held = pinned().get(agent.id)
  const before = held?.runId === run.id ? held.list : []
  const list = [...before.filter((item) => !added.some((next) => next.path === item.path)), ...added]
  if (list.length > 10) throw new ApiError(400, "一条消息最多带 10 个附件")
  pinned().set(agent.id, { runId: run.id, list })
  return { attachments: list }
}

function takePinned(agentId: string) {
  const held = pinned().get(agentId)
  if (!held) return []
  pinned().delete(agentId)
  return held.runId === activeRun(agentId)?.id ? held.list : []
}

// `final`: the room posting a wake's answer (lib/summon.ts), never from the API.
export function say(input: unknown, { final = false }: { final?: boolean } = {}) {
  const body = asRecord(input)
  const actor = actorFrom(body)
  const own = attachmentsOf(body.attachments) ?? []
  const pins = actor.type === "agent" ? takePinned(actor.id) : []
  const merged = [...pins.filter((item) => !own.some((next) => next.path === item.path)), ...own].slice(0, 10)
  const attachments = merged.length ? merged : undefined
  const text = asString(body.text) ?? ""
  if (!text.trim() && !attachments) throw new ApiError(400, "消息是空的")
  const asked = asString(body.replyTo)
  const there = (id?: string) => Boolean(findMessageAny(id))
  if (asked && !there(asked)) {
    throw new ApiError(404, "要回复的那条消息不在了")
  }
  const agent = actor.type === "agent" ? findAgent(actor.id) : undefined
  // Said during a wake without naming a message: it answers what woke the seat.
  const woke = agent ? activeRun(agent.id)?.replyTo : undefined
  const replyTo = asked ?? (there(woke) ? woke : undefined)
  // Ending the round is said in the open, starts with the marker, and calls
  // nobody; from then on agents' messages wake no one until the user speaks.
  const end = Boolean(agent) && (body.end === true || text.startsWith(END_MARK))
  const said = end ? { text: clip(text.startsWith(END_MARK) ? text : `${END_MARK}${text}`, 4000), mentions: [] } : lockMentions(clip(text, 4000))
  if (end) room().state.relayClosed = true
  else if (actor.type === "human") room().state.relayClosed = undefined
  const message = appendMessage({
    kind: "chat",
    authorId: actor.id,
    authorName: actor.name,
    authorModel: agent?.model,
    authorColor: agent?.color ?? "#1f1a14",
    authorDemo: agent?.demo ?? false,
    ...said,
    attachments,
    replyTo,
    end: end || undefined,
    // Said during a wake, by stdout or by its own bench_say: tie it to the steps.
    runId: agent ? activeRun(agent.id)?.id : undefined,
    runEnd: (final && Boolean(agent && activeRun(agent.id))) || undefined,
  })
  if (agent) agent.lastSeenAt = Date.now()
  if (actor.type === "human" && replyTo) answerAsk(replyTo, message)
  commit()
  runtime().bus.emit("message", message)
  return { message }
}

// ---- questions to the user (bench_ask) ----

const ASK_WAIT_DEFAULT_MS = 10 * 60_000
const ASK_WAIT_MAX_MS = 13 * 60_000

function askingOf() {
  return (room().asking ??= new Set())
}

function optionsOf(value: unknown): AskOption[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new ApiError(400, "options 要是一个数组")
  const options = value
    .map((item) => {
      if (typeof item === "string") return { label: clip(item.trim(), 80) }
      const record = asRecord(item)
      const label = clip((asString(record.label) ?? "").trim(), 80)
      const detail = clip((asString(record.detail) ?? asString(record.description) ?? "").trim(), 200)
      return detail ? { label, detail } : { label }
    })
    .filter((item) => item.label)
  if (options.length > 6) throw new ApiError(400, "选项最多 6 个")
  if (new Set(options.map((item) => item.label)).size !== options.length) throw new ApiError(400, "选项不能重名")
  return options.length ? options : undefined
}

// The user's reply to an open question is its answer (even if older than HOT_MESSAGES).
function answerAsk(questionId: string, reply: Message) {
  const current = room()
  const hot = current.state.messages.find((item) => item.id === questionId)
  const question = hot ?? dbGetMessage(current.id, questionId) ?? undefined
  if (!question?.ask || question.ask.state !== "open") return
  question.ask = {
    ...question.ask,
    state: "answered",
    answer: withAttachments(reply.text, reply.attachments),
    answerId: reply.id,
    answeredAt: reply.createdAt,
    handed: askingOf().has(questionId) || undefined,
  }
  dbPutMessage(current.id, question)
  bumpRev()
}

// An agent puts a question to the user: it shows in the thread as a card to
// answer, and the asker's seat says it is waiting.
export function askUser(input: unknown) {
  const body = asRecord(input)
  const actor = actorFrom(body)
  if (actor.type !== "agent") throw new ApiError(400, "只有入座的 agent 能提问")
  const agent = findAgent(actor.id)
  if (!agent) throw new ApiError(404, "这个席位不在了")
  const text = clip((asString(body.text) ?? asString(body.question) ?? "").trim(), 2000)
  if (!text) throw new ApiError(400, "问题是空的")
  const options = optionsOf(body.options)
  const ask: Ask = { state: "open", options, multi: options && body.multi === true ? true : undefined }
  const woke = activeRun(agent.id)?.replyTo
  const message = appendMessage({
    kind: "chat",
    authorId: agent.id,
    authorName: agent.name,
    authorModel: agent.model,
    authorColor: agent.color,
    authorDemo: agent.demo,
    text,
    mentions: [],
    ask,
    replyTo: woke && Boolean(findMessageAny(woke)) ? woke : undefined,
    runId: activeRun(agent.id)?.id,
  })
  agent.status = "blocked"
  agent.doing = clip(`等 ${userName()} 回答：${text.replace(/\s+/g, " ")}`, 120)
  agent.lastSeenAt = Date.now()
  bumpRev()
  commit()
  runtime().bus.emit("message", message)
  return { message }
}

// Block until the user answers that question, or the time is up. While this
// waits, the answer doesn't wake the asker a second time.
export async function awaitAnswer(input: unknown, signal?: AbortSignal) {
  const body = asRecord(input)
  const actor = actorFrom(body)
  if (actor.type !== "agent") throw new ApiError(400, "只有入座的 agent 能等回答")
  const id = asString(body.id) ?? ""
  const question = () => findMessageAny(id)
  const first = question()
  if (!first?.ask) throw new ApiError(404, "这个问题不在房间里了")
  if (first.authorId !== actor.id) throw new ApiError(403, "只能等自己提的问题")
  const raw = Number(body.timeoutMs ?? ASK_WAIT_DEFAULT_MS)
  const timeoutMs = Math.min(ASK_WAIT_MAX_MS, Math.max(1_000, Number.isFinite(raw) ? raw : ASK_WAIT_DEFAULT_MS))
  const result = () => {
    const found = question()
    return { state: found?.ask?.state ?? "gone", answer: found?.ask?.answer, answerId: found?.ask?.answerId }
  }
  if (first.ask.state !== "open") return { ...result(), timedOut: false }
  const asking = askingOf()
  asking.add(id)
  const timedOut = await new Promise<boolean>((resolve) => {
    let done = false
    const finish = (value: boolean) => {
      if (done) return
      done = true
      clearTimeout(timer)
      stop()
      signal?.removeEventListener("abort", onAbort)
      resolve(value)
    }
    const stop = onMessage((message) => {
      if (message.replyTo === id && question()?.ask?.state !== "open") finish(false)
    })
    const timer = setTimeout(() => finish(true), timeoutMs)
    const onAbort = () => finish(true)
    signal?.addEventListener("abort", onAbort)
  })
  asking.delete(id)
  const agent = findAgent(actor.id)
  if (agent && agent.status === "blocked" && /^等 .+ 回答：/.test(agent.doing)) {
    agent.status = timedOut ? "idle" : "working"
    agent.doing = timedOut ? `问了 ${userName()}，还没回答` : `收到 ${userName()} 的回答`
    bumpRev()
    commit()
  }
  return { ...result(), timedOut }
}

// What a seat shows once its question to the user is settled (above). The
// run that asked is still going, and its progress lines take the seat back
// from these (summon.ts busy()); before, the seat stayed on 「收到 … 的回答」
// for the rest of the run and after it.
export function askSettled(doing: string) {
  return /^收到 .+ 的回答$/.test(doing) || /^问了 .+，还没回答$/.test(doing)
}

export const END_MARK = "【本轮结束】"

// The user takes back one of their own messages. Its line stays in the thread
// as 「jinbao 撤回了一条消息」; agents no longer see it anywhere. The text
// comes back to the page that asked, so it can be edited and sent again.
// Not a seat's: its own session still holds what it said, and the thread
// would stop matching what it remembers.
export function recall(input: unknown) {
  const body = asRecord(input)
  const actor = actorFrom(body)
  if (actor.type !== "human") throw new ApiError(403, `只有 ${userName()} 能撤回`)
  const current = room()
  const targetId = asString(body.id)
  const hot = current.state.messages.find((item) => item.id === targetId)
  const message = hot ?? (targetId ? dbGetMessage(current.id, targetId) : null) ?? undefined
  if (!message) throw new ApiError(404, "这条消息不在房间里了")
  if (message.authorId !== "human") throw new ApiError(403, "只能撤回自己发的消息")
  if (message.recalled) throw new ApiError(409, "这条已经撤回了")
  const original = { text: message.text, attachments: message.attachments, replyTo: message.replyTo }
  message.recalled = { at: Date.now() }
  message.text = ""
  message.mentions = []
  message.attachments = undefined
  message.ask = undefined
  dbPutMessage(current.id, message)
  bumpRev()
  commit()
  return { message, original }
}

export function relayClosed() {
  return room().state.relayClosed === true
}

export function postSystem(text: string) {
  const message = appendMessage({
    kind: "system",
    authorId: "room",
    authorName: "并坐",
    authorColor: "#8a8175",
    authorDemo: false,
    text: clip(text, 500),
    mentions: [],
  })
  commit()
  return message
}

// After a restart: the wakes it cut off, with a button each to wake them again.
export function postInterrupted(text: string, interrupted: InterruptedRun[]) {
  const message = appendMessage({
    kind: "system",
    authorId: "room",
    authorName: "并坐",
    authorColor: "#8a8175",
    authorDemo: false,
    text: clip(text, 500),
    mentions: [],
    interrupted,
  })
  commit()
  return message
}

// The note and card for a wake that ended on the usage limit.
export function postLimited(text: string, limited: LimitedRun) {
  const message = appendMessage({
    kind: "system",
    authorId: "room",
    authorName: "并坐",
    authorColor: "#8a8175",
    authorDemo: false,
    text: clip(text, 500),
    mentions: [],
    limited,
  })
  commit()
  return message
}

// Where the card has got to; false if it is no longer in this room.
export function markLimited(runId: string, patch: Partial<LimitedRun>) {
  const current = room()
  for (const message of current.state.messages) {
    if (message.limited?.runId !== runId) continue
    Object.assign(message.limited, patch)
    dbPutMessage(current.id, message)
    bumpRev()
    commit()
    return true
  }
  const older = dbFindMessageByRunField(current.id, (m) => m.limited?.runId === runId)
  if (older?.limited) {
    Object.assign(older.limited, patch)
    dbPutMessage(current.id, older)
    bumpRev()
    commit()
    return true
  }
  return false
}

export function markInterruptedResumed(runId: string, at: number) {
  const current = room()
  for (const message of current.state.messages) {
    const item = message.interrupted?.find((entry) => entry.runId === runId)
    if (!item) continue
    item.resumedAt = at
    dbPutMessage(current.id, message)
    bumpRev()
    commit()
    return
  }
  const older = dbFindMessageByRunField(current.id, (m) => Boolean(m.interrupted?.some((entry) => entry.runId === runId)))
  const olderItem = older?.interrupted?.find((entry) => entry.runId === runId)
  if (older && olderItem) {
    olderItem.resumedAt = at
    dbPutMessage(current.id, older)
    bumpRev()
    commit()
  }
}

function appendMessage(input: Omit<Message, "id" | "seq" | "createdAt">) {
  const current = room()
  const message: Message = {
    ...input,
    id: uid("m"),
    seq: nextSeq(),
    createdAt: Date.now(),
  }
  dbPutMessage(current.id, message)
  const state = current.state
  state.messages.push(message)
  if (state.messages.length > HOT_MESSAGES) {
    state.messages.splice(0, state.messages.length - HOT_MESSAGES)
  }
  return message
}

export function inbox(input: unknown) {
  const body = asRecord(input)
  const agentId = asString(body.agentId)
  const token = asString(body.token)
  if (!agentId || !token) throw new ApiError(401, "收件箱要带 agentId 和 token")
  const agent = requireAgent(agentId, token)
  const afterRaw = body.after ?? 0
  const after = typeof afterRaw === "number" ? afterRaw : Number(afterRaw)
  if (!Number.isFinite(after) || after < 0) {
    throw new ApiError(400, "after 要是一个不小于 0 的数字")
  }
  const current = room()
  const firstHotSeq = current.state.messages[0]?.seq
  const pending =
    firstHotSeq !== undefined && after < firstHotSeq - 1
      ? dbLoadMessagesAfter(current.id, after, 101)
      : current.state.messages.filter((message) => message.seq > after && !message.recalled)
  const fresh = pending.slice(0, 100)
  const cursor = fresh.at(-1)?.seq ?? after
  agent.lastSeenAt = Date.now()
  agent.seenSeq = Math.max(agent.seenSeq ?? 0, cursor)
  bumpRev()
  commit()
  const view = snapshot()
  const forYou = fresh.filter((message) => isForAgent(message, agent.id, view.messages))
  return {
    you: present(agent),
    needsSession: !agent.demo && !(agent.agentName && agent.session),
    peers: view.agents.filter((item) => item.id !== agent.id),
    tasks: view.tasks,
    messages: fresh.map(withReply),
    forYou: forYou.map(withReply),
    seq: cursor,
    roomSeq: view.seq,
    hasMore: pending.length > fresh.length,
  }
}

// Everything said since this seat last looked, newest kept when it runs past
// `limit` characters, and marks it as seen. Join and leave notices are left
// out; lines aimed at the seat are starred so they stand out in a long batch.
export function catchUp(id: string, limit: number, omitIds?: ReadonlySet<string>) {
  const agent = findAgent(id)
  if (!agent) return { text: "", skipped: 0 }
  const current = room()
  const { messages, seq } = current.state
  const seen = agent.seenSeq ?? 0
  const firstHotSeq = messages[0]?.seq
  const unseen = (
    firstHotSeq !== undefined && seen < firstHotSeq - 1
      ? dbLoadTalkAfter(current.id, seen).filter((message) => message.authorId !== id)
      : messages.filter(
          (message) =>
            message.seq > seen && message.kind !== "system" && message.authorId !== id && !message.recalled,
        )
  ).filter((message) => !omitIds?.has(message.id))
  const lines: string[] = []
  let size = 0
  let index = unseen.length - 1
  for (; index >= 0; index--) {
    const message = unseen[index]
    const line = (isForAgent(message, id, messages) ? "★ " : "") + talkLine(message, true, id)
    if (lines.length > 0 && size + line.length > limit) break
    lines.unshift(line)
    size += line.length
  }
  agent.seenSeq = seq
  commit()
  const skipped = index + 1
  return { text: lines.join("\n\n"), skipped, summary: skipped > 0 ? current.state.summary : undefined }
}

// What a summary writer works from: the last summary and the talk after it.
export function summarySource() {
  const state = room().state
  const talk = talkSince(state.summary?.upToSeq ?? 0)
  const lines: string[] = []
  let size = 0
  for (let index = talk.length - 1; index >= 0; index--) {
    const line = talkLine(talk[index], false)
    if (lines.length > 0 && size + line.length > SUMMARY_SOURCE_CHARS) break
    lines.unshift(line)
    size += line.length
  }
  return { previous: state.summary, text: lines.join("\n\n"), count: talk.length, shown: lines.length, upToSeq: state.seq }
}

export function summaryJob() {
  return room().summaryJob
}

export function startSummaryJob(agentId: string, upToSeq: number, flowsAt?: Record<string, number>) {
  room().summaryJob = { agentId, upToSeq, flowsAt }
  bumpRev()
  commit()
}

export function endSummaryJob(agentId: string) {
  if (room().summaryJob?.agentId !== agentId) return
  room().summaryJob = undefined
  bumpRev()
  commit()
}

// `flowsAt`: the 「流程」 pieces the writer was asked about (lib/flow-summary.ts);
// their summaries come after the summary proper and are kept apart from it.
export function saveSummary(text: string, by: string, upToSeq = room().state.seq, flowsAt?: Record<string, number>) {
  const { main, flows } = splitFlowSummaries(text)
  const clean = main.trim()
  if (!clean) throw new ApiError(400, "摘要是空的")
  const state = room().state
  const kept = mergeFlowSummaries(state.summary?.flows, flows, flowsAt, by)
  state.summary = { text: clip(clean, 8000), upToSeq, by, at: Date.now(), ...(Object.keys(kept).length > 0 ? { flows: kept } : {}) }
  bumpRev()
  commit()
  return state.summary
}

// The user's side of summaries: skip this stretch, or edit the text by hand.
// Writing by an agent goes through the bench_summary tool (agentId + token).
export function summaryAction(input: unknown) {
  const body = asRecord(input)
  const actor = actorFrom(body)
  const action = asString(body.action)
  if (actor.type === "agent") {
    if (action !== "write") throw new ApiError(400, "agent 只能 write 摘要")
    const job = room().summaryJob
    const mine = job?.agentId === actor.id
    return { summary: saveSummary(asString(body.text) ?? "", actor.name, mine ? job.upToSeq : undefined, mine ? job.flowsAt : undefined) }
  }
  if (action === "skip") {
    room().state.summarySkipSeq = room().state.seq
    bumpRev()
    commit()
    return snapshot()
  }
  if (action === "edit") {
    const upTo = room().state.summary?.upToSeq
    return { summary: saveSummary(asString(body.text) ?? "", actor.name, upTo) }
  }
  throw new ApiError(400, "action 只能是 request、skip 或 edit")
}

function isForAgent(message: Message, agentId: string, messages: Message[]) {
  if (message.authorId === agentId) return false
  if (message.mentions.includes(agentId)) return true
  if (message.handoff?.toId === agentId) return true
  if (!message.replyTo) return false
  const hit = messages.find((item) => item.id === message.replyTo)
  if (hit) return hit.authorId === agentId
  return findMessageAny(message.replyTo)?.authorId === agentId
}

function withActor(actor: Actor, input: Record<string, unknown>) {
  if (actor.type === "human") return { ...input, as: "human" }
  const agent = findAgent(actor.id)
  if (!agent) throw new ApiError(404, "这个席位不在了")
  return { ...input, agentId: agent.id, token: agent.token }
}

export function sayAs(
  actor: Actor,
  input: { text: string; replyTo?: string; attachments?: { path: string }[] },
  options: { final?: boolean } = {},
) {
  return say(withActor(actor, input), options)
}

export function createTaskAs(
  actor: Actor,
  input: { title: string; detail?: string; owner?: string; status?: TaskStatus },
) {
  return createTask(withActor(actor, input))
}

export function actOnTaskAs(
  actor: Actor,
  input: {
    taskId: string
    action: string
    to?: string
    note?: string
  },
) {
  return actOnTask(withActor(actor, input))
}

// Step texts as given, one per item: a list of strings, or lines of one string.
function stepsFrom(value: unknown, by: string, now: number): TaskStep[] {
  if (value == null) return []
  const texts = Array.isArray(value) ? value : typeof value === "string" ? value.split("\n") : null
  if (!texts) throw new ApiError(400, "steps 要是字符串数组，或一行一步的字符串")
  return texts
    .map((item) => asString(item))
    .filter((text): text is string => Boolean(text))
    .map((text) => ({ id: uid("s"), text: clip(text, 120), state: "todo", by, at: now, updatedAt: now }))
}

function moveStep(step: TaskStep, state: TaskStepState, by: string, now: number, note?: string) {
  step.state = state
  step.by = by
  step.updatedAt = now
  step.doneAt = state === "done" ? now : undefined
  step.note = note
}

export function createTask(input: unknown) {
  const body = asRecord(input)
  const actor = actorFrom(body)
  const title = asString(body.title)
  if (!title) throw new ApiError(400, "任务要有一个标题，写这阶段要交出来的东西")
  const detail = clip(asString(body.detail) ?? "", 2000)
  const statusInput = asString(body.status) as TaskStatus | undefined
  if (statusInput && !TASK_STATUSES.has(statusInput)) {
    throw new ApiError(400, "任务状态不对")
  }
  const ownerRef = asString(body.owner)
  const owner = ownerRef ? resolveAgent(ownerRef) : null
  if (ownerRef && !owner) throw new ApiError(404, `没有叫 ${ownerRef} 的席位`)
  const status = statusInput ?? (owner ? "doing" : "open")
  const steps = stepsFrom(body.steps, actor.name, Date.now())
  if (steps.length > MAX_STEPS) throw new ApiError(400, `一条待办最多 ${MAX_STEPS} 步`)
  const task: Task = {
    id: uid("t"),
    seq: nextSeq(),
    title: clip(title, 80),
    detail,
    status,
    ownerId: owner?.id ?? null,
    ownerName: owner?.name ?? null,
    createdById: actor.id,
    createdByName: actor.name,
    updatedAt: Date.now(),
    steps: steps.length ? steps : undefined,
    history: [
      {
        at: Date.now(),
        actor: actor.name,
        action: "建立",
        note: owner ? `负责人是 ${owner.name}` : "还没有负责人",
      },
    ],
  }
  const current = room()
  current.state.tasks.push(task)
  dbPutTask(current.id, task)
  commit()
  return { task }
}

export function actOnTask(input: unknown) {
  const body = asRecord(input)
  const actor = actorFrom(body)
  const taskId = asString(body.taskId)
  if (!taskId) throw new ApiError(400, "缺少任务 id")
  const current = room()
  const task = current.state.tasks.find((item) => item.id === taskId)
  if (!task) throw new ApiError(404, "没有这条任务")
  const action = asString(body.action)
  const note = clip(asString(body.note) ?? "", 500)
  const now = Date.now()

  // A copy to carry on in: the same title, detail and steps (all to do again),
  // as a new task. The original is not touched.
  if (action === "fork") {
    const owner = task.ownerId ? findAgent(task.ownerId) : undefined
    const { task: copy } = createTask({
      ...body,
      title: task.title,
      detail: task.detail,
      owner: owner?.name,
      steps: (task.steps ?? []).map((step) => step.text),
    })
    copy.forkedFrom = { id: task.id, title: task.title }
    copy.history[0].note = `复制自「${task.title}」（${task.id}）${copy.history[0].note ? `，${copy.history[0].note}` : ""}`
    dbPutTask(current.id, copy)
    commit()
    return { task: copy }
  }
  // A finished task is a record: nothing on it changes (steps, owner, review,
  // notes). To go on, copy it.
  if (task.status === "done") {
    throw new ApiError(409, "这条待办已经完成，不能再改。要接着做，用 fork 复制一份新的（页面上点「复制一份」），或者用 bench_task 新建一条")
  }

  if (action === "claim") {
    if (actor.type !== "agent") throw new ApiError(400, "人不能把自己认成负责人，请交给一个 agent")
    if (task.ownerId && task.ownerId !== actor.id) {
      throw new ApiError(409, `这阶段已经由 ${task.ownerName} 负责`)
    }
    task.ownerId = actor.id
    task.ownerName = actor.name
    task.status = "doing"
    task.history.push({ at: now, actor: actor.name, action: "认领", note: note || "接下来由我做" })
  } else if (action === "done") {
    if (actor.type === "agent" && task.steps?.some((step) => isReviewStep(step) && step.state !== "done")) {
      throw new ApiError(403, `这条还等 ${userName()} 验收：用 review 请他验收，他点通过才算完成`)
    }
    task.status = "done"
    task.history.push({ at: now, actor: actor.name, action: "完成", note: note || "这阶段做完了" })
  } else if (action === "block") {
    task.status = "blocked"
    task.history.push({
      at: now,
      actor: actor.name,
      action: "卡住",
      note: note || "先停着",
    })
  } else if (action === "handoff") {
    const toRef = asString(body.to)
    if (!toRef) throw new ApiError(400, "交接要写明交给谁")
    const to = resolveAgent(toRef)
    if (!to) throw new ApiError(404, `没有叫 ${toRef} 的席位`)
    if (to.id === actor.id) throw new ApiError(400, "不用把任务交给自己")
    // An agent handing on fills in the sheet, so whoever picks the task up
    // knows where it stands without reading back through the chat.
    let sheet = note
    if (actor.type === "agent") {
      const done = clip(asString(body.done)?.trim() ?? "", 1000)
      const left = clip(asString(body.left)?.trim() ?? "", 1000)
      const caveats = clip(asString(body.caveats)?.trim() ?? "", 1000)
      const missing = [!done && "done（做完了什么）", !left && "left（还剩什么）", !caveats && "caveats（注意事项，没有就写「无」）"]
        .filter(Boolean)
        .join("、")
      if (missing) throw new ApiError(400, `交接单要填全：缺 ${missing}`)
      task.brief = { done, left, caveats, by: actor.name, at: now }
      sheet = [`做完了：${done}`, `还剩：${left}`, `注意：${caveats}`, note && `补充：${note}`].filter(Boolean).join("\n")
    }
    task.ownerId = to.id
    task.ownerName = to.name
    task.status = "doing"
    task.history.push({
      at: now,
      actor: actor.name,
      action: "交给",
      note: sheet || `交给 ${to.name}`,
    })
    const fromAgent = actor.type === "agent" ? findAgent(actor.id) : undefined
    if (actor.type === "human") room().state.relayClosed = undefined
    const message = appendMessage({
      kind: "handoff",
      authorId: actor.id,
      authorName: actor.name,
      authorModel: fromAgent?.model,
      authorColor: fromAgent?.color ?? "#1f1a14",
      authorDemo: fromAgent?.demo ?? false,
      text: sheet || `交给 ${to.name}`,
      mentions: [to.id],
      taskId: task.id,
      handoff: {
        fromId: actor.id,
        fromName: actor.name,
        toId: to.id,
        toName: to.name,
        taskTitle: task.title,
      },
    })
    task.updatedAt = now
    task.seq = message.seq
    dbPutTask(current.id, task)
    commit()
    runtime().bus.emit("message", message)
    return { task, message }
  } else if (action === "review") {
    // Done on the agent's side: the task waits for the user's sign-off.
    task.review = { state: "waiting", at: now, by: actor.name, note: note || undefined }
    for (const step of task.steps ?? []) {
      if (isReviewStep(step) && step.state !== "done") moveStep(step, "doing", actor.name, now)
    }
    task.history.push({ at: now, actor: actor.name, action: "请验收", note: note || `做完了，等 ${userName()} 验收` })
  } else if (action === "pass" || action === "reject") {
    if (actor.type !== "human") throw new ApiError(403, `验收只有 ${userName()} 能点：做完了用 review 请他验收`)
    const pass = action === "pass"
    if (!pass && !note) throw new ApiError(400, "打回要写一句原因，负责人照着改")
    task.review = { state: pass ? "passed" : "rejected", at: now, by: actor.name, note: note || undefined }
    for (const step of task.steps ?? []) {
      if (isReviewStep(step)) moveStep(step, pass ? "done" : "todo", actor.name, now, note || (pass ? "验收通过" : undefined))
    }
    task.status = pass ? "done" : "doing"
    task.history.push({ at: now, actor: actor.name, action: pass ? "验收通过" : "打回", note })
    // Said in the room as the user. Sending it back calls the owner, who wakes
    // and works from the reason; passing it calls nobody.
    room().state.relayClosed = undefined
    const owner = task.ownerId ? findAgent(task.ownerId) : undefined
    const message = appendMessage({
      kind: "chat",
      authorId: actor.id,
      authorName: actor.name,
      authorColor: "#1f1a14",
      authorDemo: false,
      text: pass
        ? `验收通过「${task.title}」${note ? `：${note}` : ""}`
        : `${owner ? `@${owner.name} ` : ""}打回「${task.title}」：${note}`,
      mentions: !pass && owner ? [owner.id] : [],
      taskId: task.id,
      verdict: { taskId: task.id, state: pass ? "passed" : "rejected", ownerId: task.ownerId ?? undefined },
    })
    task.updatedAt = now
    task.seq = message.seq
    dbPutTask(current.id, task)
    commit()
    runtime().bus.emit("message", message)
    return { task, message }
  } else if (action === "step") {
    // The to-do list: add steps, and/or move one along. `step` is its number
    // (from 1) or id; `state` is todo, doing or done.
    const steps = (task.steps ??= [])
    const added = stepsFrom(body.add, actor.name, now)
    if (steps.length + added.length > MAX_STEPS) throw new ApiError(400, `一条待办最多 ${MAX_STEPS} 步`)
    const ref = body.step
    if (added.length === 0 && ref == null) throw new ApiError(400, "要么用 add 加步骤，要么用 step 和 state 推进一步")
    steps.push(...added)
    if (added.length) {
      task.history.push({ at: now, actor: actor.name, action: "加步骤", note: added.map((step) => step.text).join("；") })
    }
    if (ref != null) {
      const number = Number(ref)
      const index = Number.isInteger(number) ? number - 1 : steps.findIndex((step) => step.id === ref)
      const step = steps[index]
      if (!step) throw new ApiError(404, `没有第 ${String(ref)} 步`)
      const state = asString(body.state) as TaskStepState | undefined
      if (!state || !STEP_STATES.has(state)) throw new ApiError(400, "state 只能是 todo、doing 或 done")
      if (actor.type === "agent" && state === "done" && isReviewStep(step)) {
        throw new ApiError(403, `验收这一步只有 ${userName()} 能勾：做完了用 bench_task_update 的 review 请他验收，他在右栏点通过或打回`)
      }
      moveStep(step, state, actor.name, now, note || undefined)
      task.history.push({
        at: now,
        actor: actor.name,
        action: `${STEP_ACTION[state]}第 ${index + 1} 步`,
        note: note ? `${step.text}（${note}）` : step.text,
      })
      if (task.status === "open" && state !== "todo") task.status = "doing"
    }
  } else {
    throw new ApiError(400, `action 只能是 claim、done、block、handoff、step、review、fork，或 ${userName()} 的 pass、reject`)
  }

  task.updatedAt = now
  task.seq = nextSeq()
  dbPutTask(current.id, task)
  commit()
  return { task }
}

export function removeAgent(id: string, silent = false, note?: string) {
  const current = room()
  const state = current.state
  const agent = state.agents.find((item) => item.id === id)
  if (!agent) throw new ApiError(404, "这个席位不在了")
  const now = Date.now()
  inTransaction(() => {
    for (const task of state.tasks) {
      if (task.ownerId === agent.id && task.status !== "done") {
        task.status = "blocked"
        task.updatedAt = now
        task.history.push({
          at: now,
          actor: "并坐",
          action: "卡住",
          note: `${note ?? `${agent.name} 离席`}，这阶段先停着`,
        })
        dbPutTask(current.id, task)
      }
    }
    dbDeleteSeat(agent.id)
  })
  state.agents = state.agents.filter((item) => item.id !== agent.id)
  standbyOf().delete(agent.id)
  if (!silent) {
    appendMessage({
      kind: "system",
      authorId: "room",
      authorName: "并坐",
      authorColor: "#8a8175",
      authorDemo: false,
      text: note ?? `${agent.name} 离席`,
      mentions: [],
    })
  }
  commit()
  return { removed: present(agent) }
}

export function leave(input: unknown) {
  const body = asRecord(input)
  if (body.as === "human") {
    const agentId = asString(body.agentId)
    if (!agentId) throw new ApiError(400, "要写明请哪个席位离开")
    return removeAgent(agentId)
  }
  const actor = actorFrom(body)
  if (actor.type !== "agent") throw new ApiError(400, "缺少席位")
  return removeAgent(actor.id)
}

const WAIT_DEFAULT_MS = 50_000
const WAIT_MAX_MS = 15 * 60_000
// After a wait returns the agent is busy answering; keep treating it as on
// standby this long so the room queues for the next wait instead of waking it.
const STANDBY_GRACE_MS = 10 * 60_000

// Long poll: resolve when a message for this seat lands after `after`, or on
// timeout. Returns the same shape as inbox plus `timedOut`.
export async function waitFor(input: unknown, signal?: AbortSignal) {
  const body = asRecord(input)
  const agentId = asString(body.agentId)
  const token = asString(body.token)
  if (!agentId || !token) throw new ApiError(401, "等待要带 agentId 和 token")
  const agent = requireAgent(agentId, token)
  const afterRaw = body.after ?? 0
  const after = typeof afterRaw === "number" ? afterRaw : Number(afterRaw)
  if (!Number.isFinite(after) || after < 0) throw new ApiError(400, "after 要是一个不小于 0 的数字")
  const timeoutRaw = Number(body.timeoutMs ?? WAIT_DEFAULT_MS)
  const timeoutMs = Math.min(WAIT_MAX_MS, Math.max(1_000, Number.isFinite(timeoutRaw) ? timeoutRaw : WAIT_DEFAULT_MS))
  const id = agent.id
  standbyOf().set(id, Date.now() + timeoutMs + STANDBY_GRACE_MS)

  const pending = () => {
    const current = room()
    const firstHotSeq = current.state.messages[0]?.seq
    const source =
      firstHotSeq !== undefined && after < firstHotSeq - 1
        ? dbLoadMessagesAfter(current.id, after, 100)
        : current.state.messages
    return source.some((message) => message.seq > after && isForAgent(message, id, current.state.messages))
  }
  const reply = (timedOut: boolean) => ({ ...inbox({ agentId, token, after }), timedOut })
  if (pending()) {
    standbyOf().set(id, Date.now() + STANDBY_GRACE_MS)
    return reply(false)
  }

  const waiting = waitingOf()
  waiting.set(id, (waiting.get(id) ?? 0) + 1)
  bumpRev()
  commit()
  const timedOut = await new Promise<boolean>((resolve) => {
    let done = false
    const finish = (value: boolean) => {
      if (done) return
      done = true
      clearTimeout(timer)
      stop()
      signal?.removeEventListener("abort", onAbort)
      resolve(value)
    }
    const stop = onMessage((message) => {
      if (message.seq > after && isForAgent(message, id, room().state.messages)) finish(false)
    })
    const timer = setTimeout(() => finish(true), timeoutMs)
    const onAbort = () => finish(true)
    signal?.addEventListener("abort", onAbort)
  })
  const left = (waiting.get(id) ?? 1) - 1
  if (left > 0) waiting.set(id, left)
  else waiting.delete(id)
  // Counted from now, not from when the wait began: a wait answered early
  // used to leave the seat "on standby" for its whole timeout plus the grace.
  if (left <= 0) standbyOf().set(id, Date.now() + STANDBY_GRACE_MS)
  if (!findAgent(id)) throw new ApiError(404, "这个席位不在了")
  if (signal?.aborted) {
    bumpRev()
    commit()
    return { timedOut: true, aborted: true }
  }
  return reply(timedOut)
}

// Debug menu only: forget how far a seat has read, so its next wake carries
// the whole backlog (and the cut, once it runs past the limit).
export function debugForgetSeen(id: string) {
  const agent = findAgent(id)
  if (!agent) throw new ApiError(404, "这个席位不在了")
  agent.seenSeq = undefined
  commit()
  return { name: agent.name }
}

// Debug menu only: drop the room summary and any skipped stretch.
export function debugClearSummary() {
  const state = room().state
  state.summary = undefined
  state.summarySkipSeq = undefined
  bumpRev()
  commit()
}

export function resetRoom() {
  const current = room()
  dbResetProjectRoom(current.id)
  current.state = emptyState()
  standbyOf().clear()
  commit()
  return snapshot()
}

export const PRESENCE_STALE_MS = STALE_MS
