import { AsyncLocalStorage } from "node:async_hooks"
import { randomBytes } from "node:crypto"
import { EventEmitter } from "node:events"
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

import { hasAdapter } from "@/lib/adapters"
import { ApiError, asRecord, asString } from "@/lib/http"
import { activeRun } from "@/lib/runs"
import { liveStatus } from "@/lib/status"
import { mentionedAgentIds, namedAgentIds } from "@/lib/text"
import type {
  Actor,
  AgentStatus,
  Message,
  Project,
  ProjectInfo,
  PublicAgent,
  RoomSnapshot,
  RoomSummary,
  Task,
  TaskStatus,
} from "@/lib/types"

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
// How much talk a woken seat is handed at most (about 100 messages). Once this
// much has piled up since the last summary, the room suggests writing one.
export const CATCH_UP_CHARS = 10_000
// What a summary writer is handed: the last summary plus up to this much talk.
const SUMMARY_SOURCE_CHARS = 40_000

type Agent = Omit<PublicAgent, "hasSession" | "callable" | "standby" | "status" | "agentName"> & {
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
}

type State = {
  rev: number
  seq: number
  agents: Agent[]
  messages: Message[]
  tasks: Task[]
  summary?: RoomSummary
  // The user chose not to summarize talk up to this seq.
  summarySkipSeq?: number
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
  // The seat writing a summary, and the seq its material ends at.
  summaryJob?: { agentId: string; upToSeq: number }
}

type ProjectRecord = { id: string; name: string; dir?: string; createdAt: number }

type Runtime = {
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

function dataDir() {
  return path.join(process.cwd(), "data")
}

function projectsFile() {
  return path.join(dataDir(), "projects.json")
}

function roomFile(id: string) {
  return path.join(dataDir(), "projects", `${id}.json`)
}

function load(file: string): State {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<State>
    if (!parsed || !Array.isArray(parsed.agents) || !Array.isArray(parsed.messages)) {
      return emptyState()
    }
    return {
      rev: typeof parsed.rev === "number" ? parsed.rev : 0,
      seq: typeof parsed.seq === "number" ? parsed.seq : 0,
      agents: parsed.agents as Agent[],
      messages: parsed.messages,
      tasks: Array.isArray(parsed.tasks) ? (parsed.tasks as Task[]) : [],
      summary: parsed.summary,
      summarySkipSeq: parsed.summarySkipSeq,
    }
  } catch {
    return emptyState()
  }
}

function writeJson(file: string, data: unknown) {
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2))
  renameSync(tmp, file)
}

// The projects, and each one's room. A room saved before there were projects
// (data/room.json) becomes the first project, 「默认项目」.
function loadProjects(): ProjectRecord[] {
  try {
    const parsed = JSON.parse(readFileSync(projectsFile(), "utf8")) as { projects?: ProjectRecord[] }
    if (Array.isArray(parsed.projects)) return parsed.projects
  } catch {}
  const first: ProjectRecord = { id: uid("p"), name: "默认项目", createdAt: Date.now() }
  const old = path.join(dataDir(), "room.json")
  if (existsSync(old)) {
    writeJson(roomFile(first.id), load(old))
    renameSync(old, `${old}.before-projects`)
  }
  writeJson(projectsFile(), { projects: [first] })
  return [first]
}

function runtime(): Runtime {
  if (!globalStore.__benchRooms) {
    const bus = new EventEmitter()
    bus.setMaxListeners(200)
    const projects = loadProjects()
    const rooms = new Map(projects.map((project) => [project.id, { id: project.id, state: load(roomFile(project.id)) }]))
    globalStore.__benchRooms = { projects, rooms, bus, scope: new AsyncLocalStorage() }
  }
  return globalStore.__benchRooms
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
  writeJson(projectsFile(), { projects: runtime().projects })
  runtime().bus.emit("projects")
}

export function listProjects(): Project[] {
  const now = Date.now()
  return runtime().projects.map((item) =>
    inProject(item.id, () => {
      const state = room().state
      const seats = state.agents.map((agent) => present(agent, now))
      return {
        ...projectInfo(item.id),
        seats: seats.length,
        online: seats.filter((agent) => agent.status !== "offline").length,
        working: seats.filter((agent) => agent.status === "working").length,
        lastAt: Math.max(item.createdAt, state.messages.at(-1)?.createdAt ?? 0),
      }
    }),
  )
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
      if (!path.isAbsolute(raw)) throw new ApiError(400, "目录要填完整路径，比如 /home/you/project")
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
  inProject(record.id, persist)
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
  saveProjects()
  rmSync(roomFile(id), { force: true })
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
  throw new ApiError(409, `房间里有几个项目：${list}。问用户进哪个，再调用 bench_join 并填 project。`)
}

function persist() {
  const current = room()
  writeJson(roomFile(current.id), current.state)
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

function present(agent: Agent, now = Date.now()): PublicAgent {
  // A seat the room has woken is working until that run ends, even through a
  // quiet stretch (a client queueing, a long command) longer than STALE_MS.
  const run = activeRun(agent.id)
  return {
    id: agent.id,
    name: agent.name,
    model: agent.model,
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

export function snapshot(): RoomSnapshot {
  const state = room().state
  const talk = talkSince(summaryBase())
  const chars = talk.reduce((sum, message) => sum + message.text.length, 0)
  return {
    project: projectInfo(room().id),
    agents: sortAgents(state.agents.map((agent) => present(agent))),
    messages: state.messages,
    tasks: sortTasks(state.tasks),
    seq: state.seq,
    rev: state.rev,
    summary: state.summary ?? null,
    sinceSummary: { count: talk.length, chars },
    summaryDue: chars >= CATCH_UP_CHARS,
    summaryWriter: room().summaryJob?.agentId ?? null,
  }
}

function summaryBase() {
  const state = room().state
  return Math.max(state.summary?.upToSeq ?? 0, state.summarySkipSeq ?? 0)
}

function talkSince(after: number) {
  return room().state.messages.filter((message) => message.seq > after && message.kind !== "system")
}

function talkLine(message: Message) {
  const time = new Date(message.createdAt).toTimeString().slice(0, 5)
  return `${time} ${message.authorName}：${message.text}`
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
  return room().state.agents.find((agent) => agent.id === ref || agent.name === ref)
}

function waitingOf() {
  return (room().waiting ??= new Map())
}

function standbyOf() {
  return (room().standby ??= new Map())
}

export function isStandby(id: string) {
  return (standbyOf().get(id) ?? 0) > Date.now()
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
  if (body.as === "human") return { type: "human", id: "human", name: "jinbao" }
  throw new ApiError(400, "要带 agentId 和 token，或标明 as 为 human")
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
  const name = asString(body.name)
  if (!name || !NAME_RE.test(name) || RESERVED.has(name.toLowerCase()) || RESERVED.has(name)) {
    throw new ApiError(400, "名字用 1 到 24 个字母、数字或中文，不要空格，方便别人 @你")
  }
  const token = asString(body.token)
  const existing = room().state.agents.find((agent) => agent.name === name)
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
  agentName: string
  session: string
  workdir: string
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
    commit()
  }
  return result
}

// Its first wake went through: the session exists now.
export function markWoken(id: string) {
  const agent = findAgent(id)
  if (!agent?.fresh) return
  agent.fresh = false
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
  if (message.kind === "system") return []
  const ids = new Set(namedAgentIds(message.text, room().state.agents))
  if (message.handoff?.toId) ids.add(message.handoff.toId)
  ids.delete(message.authorId)
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

export function say(input: unknown) {
  const body = asRecord(input)
  const actor = actorFrom(body)
  const text = asString(body.text)
  if (!text) throw new ApiError(400, "消息是空的")
  const replyTo = asString(body.replyTo)
  if (replyTo && !room().state.messages.some((message) => message.id === replyTo)) {
    throw new ApiError(404, "要回复的那条消息不在了")
  }
  const agent = actor.type === "agent" ? findAgent(actor.id) : undefined
  const message = appendMessage({
    kind: "chat",
    authorId: actor.id,
    authorName: actor.name,
    authorModel: agent?.model,
    authorColor: agent?.color ?? "#1f1a14",
    authorDemo: agent?.demo ?? false,
    text: clip(text, 4000),
    mentions: mentionedAgentIds(text, room().state.agents),
    replyTo,
    // Said during a wake, by stdout or by its own bench_say: tie it to the steps.
    runId: agent ? activeRun(agent.id)?.id : undefined,
  })
  if (agent) agent.lastSeenAt = Date.now()
  commit()
  runtime().bus.emit("message", message)
  return { message }
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

function appendMessage(input: Omit<Message, "id" | "seq" | "createdAt">) {
  const message: Message = {
    ...input,
    id: uid("m"),
    seq: nextSeq(),
    createdAt: Date.now(),
  }
  const state = room().state
  state.messages.push(message)
  if (state.messages.length > 400) {
    state.messages.splice(0, state.messages.length - 400)
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
  const pending = room().state.messages.filter((message) => message.seq > after)
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
    messages: fresh,
    forYou,
    seq: cursor,
    roomSeq: view.seq,
    hasMore: pending.length > fresh.length,
  }
}

// Everything said since this seat last looked, newest kept when it runs past
// `limit` characters, and marks it as seen. Join and leave notices are left
// out; lines aimed at the seat are starred so they stand out in a long batch.
export function catchUp(id: string, limit: number) {
  const agent = findAgent(id)
  if (!agent) return { text: "", skipped: 0 }
  const { messages, seq } = room().state
  const unseen = messages.filter(
    (message) => message.seq > (agent.seenSeq ?? 0) && message.kind !== "system" && message.authorId !== id,
  )
  const lines: string[] = []
  let size = 0
  let index = unseen.length - 1
  for (; index >= 0; index--) {
    const message = unseen[index]
    const line = (isForAgent(message, id, messages) ? "★ " : "") + talkLine(message)
    if (lines.length > 0 && size + line.length > limit) break
    lines.unshift(line)
    size += line.length
  }
  agent.seenSeq = seq
  commit()
  const skipped = index + 1
  return { text: lines.join("\n\n"), skipped, summary: skipped > 0 ? room().state.summary : undefined }
}

// What a summary writer works from: the last summary and the talk after it.
export function summarySource() {
  const state = room().state
  const talk = talkSince(state.summary?.upToSeq ?? 0)
  const lines: string[] = []
  let size = 0
  for (let index = talk.length - 1; index >= 0; index--) {
    const line = talkLine(talk[index])
    if (lines.length > 0 && size + line.length > SUMMARY_SOURCE_CHARS) break
    lines.unshift(line)
    size += line.length
  }
  return { previous: state.summary, text: lines.join("\n\n"), count: talk.length, shown: lines.length, upToSeq: state.seq }
}

export function summaryJob() {
  return room().summaryJob
}

export function startSummaryJob(agentId: string, upToSeq: number) {
  room().summaryJob = { agentId, upToSeq }
  bumpRev()
  commit()
}

export function endSummaryJob(agentId: string) {
  if (room().summaryJob?.agentId !== agentId) return
  room().summaryJob = undefined
  bumpRev()
  commit()
}

export function saveSummary(text: string, by: string, upToSeq = room().state.seq) {
  const clean = text.trim()
  if (!clean) throw new ApiError(400, "摘要是空的")
  const state = room().state
  state.summary = { text: clip(clean, 8000), upToSeq, by, at: Date.now() }
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
    const upTo = job?.agentId === actor.id ? job.upToSeq : undefined
    return { summary: saveSummary(asString(body.text) ?? "", actor.name, upTo) }
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
  return messages.some((item) => item.id === message.replyTo && item.authorId === agentId)
}

function withActor(actor: Actor, input: Record<string, unknown>) {
  if (actor.type === "human") return { ...input, as: "human" }
  const agent = findAgent(actor.id)
  if (!agent) throw new ApiError(404, "这个席位不在了")
  return { ...input, agentId: agent.id, token: agent.token }
}

export function sayAs(actor: Actor, input: { text: string; replyTo?: string }) {
  return say(withActor(actor, input))
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
    history: [
      {
        at: Date.now(),
        actor: actor.name,
        action: "建立",
        note: owner ? `负责人是 ${owner.name}` : "还没有负责人",
      },
    ],
  }
  const state = room().state
  state.tasks.push(task)
  if (state.tasks.length > 200) state.tasks.splice(0, state.tasks.length - 200)
  commit()
  return { task }
}

export function actOnTask(input: unknown) {
  const body = asRecord(input)
  const actor = actorFrom(body)
  const taskId = asString(body.taskId)
  if (!taskId) throw new ApiError(400, "缺少任务 id")
  const task = room().state.tasks.find((item) => item.id === taskId)
  if (!task) throw new ApiError(404, "没有这条任务")
  const action = asString(body.action)
  const note = clip(asString(body.note) ?? "", 500)
  const now = Date.now()

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
    commit()
    runtime().bus.emit("message", message)
    return { task, message }
  } else {
    throw new ApiError(400, "action 只能是 claim、done、block 或 handoff")
  }

  task.updatedAt = now
  task.seq = nextSeq()
  commit()
  return { task }
}

export function removeAgent(id: string, silent = false, note?: string) {
  const state = room().state
  const agent = state.agents.find((item) => item.id === id)
  if (!agent) throw new ApiError(404, "这个席位不在了")
  const now = Date.now()
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
    }
  }
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

  const pending = () =>
    room().state.messages.some((message) => message.seq > after && isForAgent(message, id, room().state.messages))
  const reply = (timedOut: boolean) => ({ ...inbox({ agentId, token, after }), timedOut })
  if (pending()) return reply(false)

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
  room().state = emptyState()
  standbyOf().clear()
  commit()
  return snapshot()
}

export const PRESENCE_STALE_MS = STALE_MS
