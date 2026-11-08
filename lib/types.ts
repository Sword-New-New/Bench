export type AgentStatus = "idle" | "working" | "blocked" | "offline"

export type TaskStatus = "open" | "doing" | "blocked" | "done"

export type MessageKind = "chat" | "handoff" | "system"

export type PublicAgent = {
  id: string
  name: string
  model: string
  role: string
  strengths: string[]
  status: AgentStatus
  doing: string
  color: string
  demo: boolean
  agentName: string
  hasSession: boolean
  callable: boolean
  // Blocked in bench_wait right now: a message for it is delivered at once.
  standby: boolean
  // The wake it is in the middle of; its steps are at /api/v1/runs/<id>.
  runId?: string
  createdAt: number
  lastSeenAt: number
}

export type Handoff = {
  fromId: string
  fromName: string
  toId: string
  toName: string
  taskTitle: string
}

export type Message = {
  id: string
  seq: number
  kind: MessageKind
  authorId: string
  authorName: string
  authorModel?: string
  authorColor: string
  authorDemo: boolean
  text: string
  mentions: string[]
  replyTo?: string
  taskId?: string
  handoff?: Handoff
  // Posted during a wake: the steps that led to it.
  runId?: string
  createdAt: number
}

export type TaskEvent = {
  at: number
  actor: string
  action: string
  note: string
}

// The sheet an agent fills in when it hands a task on.
export type TaskBrief = {
  done: string
  left: string
  caveats: string
  by: string
  at: number
}

export type Task = {
  id: string
  seq: number
  title: string
  detail: string
  status: TaskStatus
  ownerId: string | null
  ownerName: string | null
  createdById: string
  createdByName: string
  updatedAt: number
  history: TaskEvent[]
  brief?: TaskBrief
}

// A running digest of the room, written by an agent the user picks.
export type RoomSummary = {
  text: string
  // Covers messages up to this seq.
  upToSeq: number
  by: string
  at: number
}

// A project: one room of its own, and optionally the folder its work is in.
export type ProjectInfo = {
  id: string
  name: string
  dir?: string
  createdAt: number
}

export type Project = ProjectInfo & {
  seats: number
  online: number
  working: number
  // When something last happened in it.
  lastAt: number
}

export type RoomSnapshot = {
  project: ProjectInfo
  agents: PublicAgent[]
  messages: Message[]
  tasks: Task[]
  seq: number
  rev: number
  summary: RoomSummary | null
  // Talk since the last summary (or since the user skipped one).
  sinceSummary: { count: number; chars: number }
  summaryDue: boolean
  // The seat writing a summary right now.
  summaryWriter: string | null
}

export type Actor = {
  type: "human" | "agent"
  id: string
  name: string
}

// One step of a wake: a tool call (with its result once it finishes), a bit
// of the agent's own text, or a note from the room.
export type RunStep = {
  id: string
  at: number
  kind: "tool" | "text" | "note"
  title: string
  input?: string
  output?: string
  state: "running" | "done" | "failed"
}

export type Run = {
  id: string
  agentId: string
  agentName: string
  purpose: "reply" | "summary" | "private"
  // A private run: what the user said and what it answered.
  ask?: string
  answer?: string
  state: "running" | "done" | "failed"
  startedAt: number
  endedAt?: number
  messageId?: string
  steps: RunStep[]
}
