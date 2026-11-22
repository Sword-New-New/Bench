export type AgentStatus = "idle" | "working" | "blocked" | "offline"

export type TaskStatus = "open" | "doing" | "blocked" | "done"

export type MessageKind = "chat" | "handoff" | "system"

export type PublicAgent = {
  id: string
  name: string
  model: string
  // The model the user picked for it in the room; wakes run on it (lib/models.ts).
  modelPick?: string
  // How hard it thinks (Claude, Codex, CodeBuddy/WorkBuddy); unset, the default.
  effortPick?: string
  // The most context it may hold, in tokens, and at what percent of that it
  // compacts by itself (lib/context.ts); unset, the model's and client's own.
  windowPick?: number
  compactPct?: number
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
  // ...or whenever it is woken, until turned off (「默认开启全部权限」).
  autoFull?: boolean
  // This project's checker: woken to check a task before the user signs it
  // off (「请验收时先复验」). One seat per project at most.
  checker?: boolean
  // This project's summary seat: writes the one-line gist of long replies
  // the rules found none in (「谁来补摘要句」). One seat per project at most.
  gister?: boolean
  // Its session is open in a terminal the room holds (lib/terminal.ts).
  terminal?: boolean
  // Messages queued in its wake lane, and whether its lane is paused.
  queuedCount?: number
  queuePaused?: boolean
  queuedItems?: { id: string; line: string }[]
  // Its last wake failed on the network and goes again by itself: when, and
  // which try of how many (lib/netfail.ts).
  retry?: { at: number; n: number; of: number }
  // Whether this seat has a saved persona or long-term memory card.
  hasProfile?: boolean
  // Earlier client sessions this seat used (without exposing raw session uuids),
  // newest first, so the user can switch it back after a quota reset.
  previousBindings?: PublicSeatBinding[]
  // When the room's latest wake of it ended. A seat that says it is working
  // and then goes quiet is only "not sure" if it said so after this
  // (lib/status.ts seatState): a woken session can't work once its run is over.
  ranUntil?: number
  // It said it was working at this time and has not said anything since, long
  // enough that the room no longer takes its word for it.
  unsure?: number
  // Quiet, with work still on it (lib/owes.ts): to-dos it owns that wait on
  // nobody else, and calls to it that never got through. The page shows it
  // once the seat has been quiet a while.
  owes?: SeatOwes
  createdAt: number
  lastSeenAt: number
}

// What became of one call to one seat (a mention, a reply to it, a handoff).
// The room writes it where each thing happens (lib/summon.ts); the page shows
// it and never guesses it from other signs.
//   queued    waiting in the seat's lane (behind its run, or the lane is paused)
//   held      the seat keeps a wait loop (bench_wait) and takes it from there
//   started   a wake with this message in it began
//   picked    its client showed a first sign of life, or the message was
//             handed over in the middle of a run, or to a seat waiting for it
//   answered  the wake ended and the seat spoke in the room during it
//   silent    the wake ended fine, and the seat said nothing in the room
//   retrying  the wake failed on the network; the room tries it again by
//             itself (`note` says which try and why; lib/netfail.ts)
//   failed    it could not be woken, or the wake ended in an error (`note`)
//   stopped   the user stopped that wake
//   cut       the room restarted, or lost track of it, in the middle
//   dropped   taken out of the lane before it ran
export type CallState =
  | "queued"
  | "held"
  | "started"
  | "picked"
  | "answered"
  | "silent"
  | "retrying"
  | "failed"
  | "stopped"
  | "cut"
  | "dropped"

export type Call = {
  // The seat that was called.
  id: string
  name: string
  state: CallState
  at: number
  runId?: string
  note?: string
}

export type SeatOwes = {
  // Since when it has been quiet.
  since: number
  tasks: { id: string; title: string; step?: string }[]
  calls: { messageId: string; from: string; state: CallState; at: number }[]
  // How many times the room has already woken this seat to carry on with this
  // batch of owed work, and when it last did (lib/continue.ts).
  woken?: { count: number; at: number }
}

export type SeatProfile = {
  persona: string
  memory: string
  updatedAt: number
}

export type SeatBinding = {
  agentName: string
  session: string
  model: string
  modelPick?: string
  effortPick?: string
  workdir?: string
  switchedAt: number
  reason?: string
}

export type PublicSeatBinding = Omit<SeatBinding, "session"> & {
  index: number
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

export type MessageGist = { text: string; by: string; at: number }

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
  // When the room itself wakes a seat to carry on (lib/continue.ts), `text` is
  // the short one-line note shown in the thread while `wakeText` is the fuller
  // instruction handed to that seat.
  wakeText?: string
  mentions: string[]
  replyTo?: string
  taskId?: string
  handoff?: Handoff
  // Posted during a wake: the steps that led to it.
  runId?: string
  // The wake's own answer, posted by the room as the run ends (stdout); a
  // bench_say in the middle of the run has the runId but not this. The page
  // keeps the 「正在做」 bubble until it sees one.
  runEnd?: boolean
  // The one line it shows folded in the room (t_83c6fcc9). Only on an
  // agent's chat messages: taken from its first line by fixed rules when it
  // is posted (lib/text.ts gistOf, by "author"), or written later by the
  // project's summary seat (by its name). Display only: agents get the full
  // text, search and to-dos don't use it, and @ in it calls nobody. Without
  // one the page works it out with the same gistOf.
  gist?: MessageGist
  attachments?: Attachment[]
  ask?: Ask
  // The user took it back: text and attachments are gone, the line stays.
  recalled?: { at: number }
  // Seats that were already working when it called them and got it mid-run
  // (lib/summon.ts takeQueued), instead of after their turn.
  reached?: { id: string; name: string; at: number }[]
  // What became of its call to each seat it woke, or tried to.
  calls?: Call[]
  // An agent saying its round of handoffs is over: it mentions nobody, and
  // agents stop waking each other until the user speaks again.
  end?: boolean
  // The user's verdict on a task, said in the room. The owner goes by seat
  // id: the page shows its current name, agents get the id.
  verdict?: {
    taskId: string
    state: "passed" | "rejected" | "reopened"
    ownerId?: string
    // Passed by the front desk on the user's behalf, or reopened after one (lib/deputy.ts).
    deputy?: true
  }
  // A room note after a restart: the wakes it cut off.
  interrupted?: InterruptedRun[]
  // A wake that ended on the account's usage limit, with the card to carry on
  // after it resets.
  limited?: LimitedRun
  // At the front desk: something its AI drafted for the user to send into a
  // project, or a to-do there waiting on them (lib/front-relay.ts). Nothing
  // leaves the desk until the user clicks.
  relay?: RelayDraft
  // The patrol's note at the front desk (lib/patrol.ts): risks it found in
  // the projects, for the desk's AI. Not shown on the page.
  risk?: PatrolRisk
  createdAt: number
}

export type RiskLevel = "high" | "mid" | "low"

export type RiskItem = {
  // Stable for the same thing (a task, a call, a run), so it is told once.
  key: string
  projectId: string
  project: string
  level: RiskLevel
  text: string
  // Where to look: a task, a message, or a seat's run.
  ref?: { kind: "task" | "message" | "run"; id: string }
}

export type PatrolRisk = {
  items: RiskItem[]
  // More found than the note lists.
  more?: number
}

export type SignLane = "batch" | "look" | "you"

export type RelayBatchItem = {
  project: string
  projectName: string
  taskId: string
  title: string
  lane: SignLane
  line: string
  why?: string
  note?: string
  checkNote?: string
  checkName?: string
  state?: "passed" | "skipped"
}

export type RelayDraft = {
  // relay: the user's words carried to a seat; nudge: asking a stopped seat
  // where its work stands; review: a to-do waiting for the user's verdict;
  // batch: a grouped list of waiting reviews across projects.
  kind: "relay" | "nudge" | "review" | "batch"
  project: string
  projectName: string
  seatId?: string
  seatName?: string
  taskId?: string
  taskTitle?: string
  // What goes out (relay, nudge); the user may change it before sending.
  text?: string
  // The desk's one line on why.
  why?: string
  // Items on a batch review card (kind === "batch").
  items?: RelayBatchItem[]
  state: "draft" | "sent" | "dropped" | "passed"
  // The message it became in that project.
  sentId?: string
  settledAt?: number
  // A batch card closed because a newer one took over what still waited on it.
  replacedBy?: string
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
  // A finished task is not edited; a copy of it (action "fork") carries on, and
  // says which it came from.
  forkedFrom?: { id: string; title: string }
  // The user's sign-off: an agent asks for it when the work is done, and only
  // the user passes it or sends it back with a reason.
  review?: TaskReview
  // Another seat's check before the user's sign-off (「请验收时先复验」):
  // started when the owner asks for review, one per request.
  check?: TaskCheck
}

export type TaskCheck = {
  // queued/running: on its way; passed/failed/unverified: its verdict;
  // skipped: not run (no checker that may or can); error: the wake failed.
  state: "queued" | "running" | "passed" | "failed" | "unverified" | "skipped" | "error"
  // The checking seat (id and name at the time), when there is one.
  by?: string
  name?: string
  // Its reasons, and what it couldn't check; or why it was skipped / failed.
  note?: string
  // Category written by the checker: run (跑得出), look (要人看), you (只能本人签).
  kind?: "run" | "look" | "you"
  // What the checker could not verify (omitted when "无").
  gaps?: string
  at: number
  // The wake it ran in, to open its steps.
  runId?: string
  // When it was put in a seat's queue (lib/summon.ts): one waiting there
  // longer than BENCH_CHECK_STALE_MS goes to another seat.
  queuedAt?: number
  // Seats tried and given up on (waited too long, hit a usage limit), how
  // many times it went to another seat, and until when it waits for a reset
  // when every seat was out of quota (waited: it has waited once already).
  avoid?: string[]
  repicks?: number
  waitUntil?: number
  waited?: boolean
  // Checked again after the owner fixed what the last check found (asked for
  // review again while still waiting, t_a58c8546): which time this is
  // (1, 2; RECHECK_MAX in lib/store.ts) and what the check before said.
  round?: number
  prev?: { state: "failed" | "unverified"; name?: string; at: number; note?: string }
}

export type TaskDeputy = {
  seatId: string
  seatName: string
  why: string
  checkBy?: string
  checkName?: string
}

export type TaskReviewIssue = {
  // Check state when the user signed off despite a failed/incomplete/missing check.
  state: TaskCheck["state"] | "none" | "stale"
  checkBy?: string
  checkName?: string
  summary: string
}

export type TaskReview = {
  state: "waiting" | "passed" | "rejected"
  at: number
  // Who asked for it, or what the user said sending it back.
  by: string
  note?: string
  // Passed by the front desk on the user's behalf (lib/deputy.ts).
  deputy?: TaskDeputy
  // Recorded when the user passes a task whose check failed, didn't finish, or didn't run.
  issue?: TaskReviewIssue
  // The user took a deputy pass back. It stays theirs to sign until the owner
  // asks for review again (a new ask writes a new record without this).
  reopened?: true
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
  // Short summaries of the 「流程」 view's pieces of work, by the piece's
  // first message id; written along with the room summary (lib/flow-summary.ts).
  flows?: Record<string, FlowSummary>
}

export type FlowSummary = {
  text: string
  // The piece's short name, and each block's (by node id), shown in the
  // picture instead of the message's opening words.
  title?: string
  nodes?: Record<string, string>
  // The piece's lastAt it was written from; later activity shows as new.
  upToAt: number
  by: string
  at: number
}

// A project: one room of its own, and optionally the folder its work is in.
export type ProjectInfo = {
  id: string
  name: string
  dir?: string
  // The room's single reception project (「前台」), pinned at the top of the rail.
  front?: true
  // Automatically pick a checker seat when a task asks for review.
  check?: "auto"
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
  // The newest 「【本轮结束】」 in it, for the desktop notification.
  lastEnd?: ProjectEnd
  // The front desk only: the latest line its AI pushed to the user (lib/front.ts frontNotify).
  notice?: { id: string; at: number; text: string }
}

export type ProjectEnd = { id: string; at: number; name: string; color: string; text: string }

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
  // In words: what kind of thing it is (运行一条命令, 改文件 x.ts) and, when
  // the client wrote one, its own sentence on what it is for. The raw tool
  // name and `input` sit behind a click.
  plain?: { action: string; why?: string }
  at: number
}

export type RoomSnapshot = {
  project: ProjectInfo
  agents: PublicAgent[]
  messages: Message[]
  tasks: Task[]
  // Total completed tasks in this project (`tasks[]` only includes done tasks
  // finished within the last 48 hours).
  doneTotal?: number
  // Open bench_ask questions older than the snapshot's latest 400 messages, so
  // PinnedAsks can still surface and answer them.
  openAsks?: Message[]
  // Total stored messages in this project (messages[] holds at most the latest 400).
  totalMessages?: number
  seq: number
  rev: number
  summary: RoomSummary | null
  // Talk since the last summary (or since the user skipped one).
  sinceSummary: { count: number; chars: number }
  summaryDue: boolean
  // The room is still finding a seat to write it (lib/summary-auto.ts): the
  // card asking the user who should is held back meanwhile.
  summaryHeld?: boolean
  // The seat writing a summary right now.
  summaryWriter: string | null
  // An agent ended the round; agents wake nobody until the user speaks.
  relayClosed: boolean
  // Permission prompts waiting on the user.
  permits: PermitRequest[]
  // What the user goes by in the room.
  userName: string
  // Wakes that failed on the network are tried again by themselves (lib/netfail.ts).
  netRetry: boolean
  // Carry on by itself after the 5-hour allowance resets (lib/summon.ts autoResumeAt).
  limitResume: boolean
  // 「查过没问题的，自动替我收下」, one switch for the room (lib/deputy.ts autoAcceptChecked).
  autoAccept: boolean
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
  // compact: the user had the room compact its context (lib/summon.ts compactSession).
  // goal: the user typed /goal for it (lib/summon.ts setGoal); `ask` is what came after.
  purpose: "reply" | "summary" | "private" | "compact" | "goal" | "check" | "gist"
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
  // It ended on the account's usage limit (lib/limits.ts). `resumeAt`: the user
  // chose to have the seat woken again then.
  limited?: { resetsAt?: number; resumeAt?: number }
  announced?: boolean
  resumedAt?: number
  steps: RunStep[]
}

// The card under 「撞到额度」: what ran out, when it comes back, and what the
// user chose. open -> scheduled (woken again at `at`) -> resumed, or failed;
// or dismissed.
export type LimitedRun = {
  runId: string
  agentId: string
  agentName: string
  label: string
  kind?: "quota" | "balance"
  resetsAt?: number
  state: "open" | "scheduled" | "resumed" | "rebound" | "failed" | "dismissed"
  // scheduled: when it will be woken; resumed/rebound: when it was.
  at?: number
  note?: string
  // rebound: which client/model picked up this seat's work.
  reboundTo?: string
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
