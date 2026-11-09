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
  // When that wake started, and when its latest step began: the drawer keeps
  // seats in the order they started, and says how long a step has been going.
  runStartedAt?: number
  stepAt?: number
  // The user let it do anything for the rest of this wake.
  fullAccess?: boolean
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

// A file, folder or image sent with a message. Everyone in the room is on this
// computer, so it travels as a path: picked from disk where it lies, or, for
// something pasted or dropped, the copy the room saved under data/uploads.
export type Attachment = {
  kind: "file" | "dir" | "image" | "video" | "audio"
  name: string
  path: string
  size?: number
}

// A question an agent put to the user with bench_ask, instead of its own
// client's ask tool (a woken turn has nobody at its terminal). The user
// answers by replying to it: a choice from the card, or words of their own.
export type AskOption = {
  label: string
  detail?: string
}

export type Ask = {
  options?: AskOption[]
  // More than one option may be picked.
  multi?: boolean
  state: "open" | "answered"
  answer?: string
  answerId?: string
  answeredAt?: number
  // The asker was still waiting in bench_ask and got the answer there, so the
  // reply did not wake it again.
  handed?: boolean
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
  attachments?: Attachment[]
  ask?: Ask
  // The user took it back: text and attachments are gone, the line stays.
  recalled?: { at: number }
  // Seats that were already working when it called them and got it mid-run
  // (lib/summon.ts takeQueued), instead of after their turn.
  reached?: { id: string; name: string; at: number }[]
  // An agent saying its round of handoffs is over: it mentions nobody, and
  // agents stop waking each other until the user speaks again.
  end?: boolean
  // The user's verdict on a task, said in the room. The owner goes by seat
  // id: the page shows its current name, agents get the id.
  verdict?: { taskId: string; state: "passed" | "rejected"; ownerId?: string }
  // A room note after a restart: the wakes it cut off.
  interrupted?: InterruptedRun[]
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
  // The to-do list of this feature: worked, and accepted, one step at a time.
  steps?: TaskStep[]
  // The user's sign-off: an agent asks for it when the work is done, and only
  // the user passes it or sends it back with a reason.
  review?: TaskReview
}

export type TaskReview = {
  state: "waiting" | "passed" | "rejected"
  at: number
  // Who asked for it, or what the user said sending it back.
  by: string
  note?: string
}

export type TaskStepState = "todo" | "doing" | "done"

export type TaskStep = {
  id: string
  text: string
  state: TaskStepState
  // Who last moved it, when, and what they said.
  by: string
  at: number
  updatedAt: number
  doneAt?: number
  note?: string
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
  // When someone other than the user last said something; the page compares it
  // with when the user last looked, for the unread dot.
  lastOtherAt: number
  // Things in it that wait on the user: permits, open questions, sign-offs.
  waiting: number
  // Who sits on its bench in the project rail: at most three, the working
  // first, then those waiting on the user, then whoever spoke last.
  bench: BenchSeat[]
  // Every seat's name, for the card's tooltip.
  names: string[]
}

export type BenchSeat = {
  id: string
  name: string
  color: string
  agentName: string
  model: string
  demo: boolean
  status: AgentStatus
  // Has a permit or a question out to the user.
  waiting: boolean
  // Owns a task waiting for the user's sign-off.
  review: boolean
  // When it last said something here; the rail makes it hop when this moves.
  saidAt?: number
}

// A woken Claude Code turn waiting on the user: to run one tool, or for full
// permission for the rest of its wake.
export type PermitRequest = {
  id: string
  agentId: string
  agentName: string
  runId?: string
  kind: "tool" | "full"
  tool?: string
  // What it would run or touch.
  input?: string
  reason?: string
  at: number
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
  // An agent ended the round; agents wake nobody until the user speaks.
  relayClosed: boolean
  // Permission prompts waiting on the user.
  permits: PermitRequest[]
  // What the user goes by in the room.
  userName: string
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
  // A reply run: the message that woke the seat. What it says during the run
  // answers that message unless it names another.
  replyTo?: string
  // The project it ran in, and for a reply run the room messages it was
  // answering: enough to wake the seat again if the room stops mid-run.
  project?: string
  body?: string
  // The room stopped while it ran; `resumedAt` once the user woke it again.
  interrupted?: boolean
  announced?: boolean
  resumedAt?: number
  steps: RunStep[]
}

// A wake the room stopped in the middle of, listed so the user can wake it again.
export type InterruptedRun = {
  runId: string
  agentId: string
  agentName: string
  purpose: Run["purpose"]
  replyTo?: string
  resumedAt?: number
}
