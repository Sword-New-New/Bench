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

export type RoomSnapshot = {
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
