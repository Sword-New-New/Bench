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
}

export type RoomSnapshot = {
  agents: PublicAgent[]
  messages: Message[]
  tasks: Task[]
  seq: number
  rev: number
}

export type Actor = {
  type: "human" | "agent"
  id: string
  name: string
}
