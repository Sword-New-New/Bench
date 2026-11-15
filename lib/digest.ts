import { chainsOf, firstNamed, namedTasks } from "@/lib/flow"
import { awaitingReview } from "@/lib/review"
import { gistOf } from "@/lib/text"
import type { Message, PermitRequest, PublicAgent, Task, TaskCheck } from "@/lib/types"

// The 「进展」 view (t_5de117f4): the room's talk gathered into one line per
// piece of work, with where it stands first. A pure function of the snapshot
// (no storage, no requests); the page calls it. Every state is a fact the
// room keeps (to-dos and their steps, sign-off, questions, permission
// prompts, call records, who is running); nothing here is guessed by a model.
//
// A piece of work is a to-do, with the messages that belong to it:
//   - the message's own taskId, a verdict on it, a handoff of it (by title);
//   - any message that names its id (t_…); one naming two belongs to both;
//   - the rest of its reply chain (lib/flow.ts: a to-do belongs to the chain
//     whose message first names it). A chain that hosts several to-dos gives
//     an unnamed message to the to-do its author owns, or, with one to-do,
//     to that one.
// Reply chains with no to-do and at least one agent reply are 「talk」.

export type DigestState = "you" | "stuck" | "doing" | "done" | "talk"
export type DigestNeed = "review" | "answer" | "permit"

export type DigestRow = {
  // The to-do's id; for talk, the first message of its reply chain.
  id: string
  kind: "task" | "talk"
  state: DigestState
  title: string
  owner?: { id: string; name: string }
  // One line: the latest outcome of this piece of work.
  line: string
  steps?: { done: number; total: number; current?: string }
  // What it waits on the user for, when it does.
  need?: DigestNeed
  // The open question or permission prompt behind `need`.
  askId?: string
  permitId?: string
  // Last sign of life.
  at: number
  // Waiting on the user since (you), or stopped since (stuck).
  since?: number
  // Its messages, oldest first.
  messageIds: string[]
  attachments: number
  // The second seat's verdict, when it gave one.
  check?: Pick<TaskCheck, "state" | "name" | "note">
}

export type Digest = {
  counts: { you: number; stuck: number; doing: number; done: number }
  you: DigestRow[]
  stuck: DigestRow[]
  doing: DigestRow[]
  done: DigestRow[]
  talk: DigestRow[]
}

export type DigestInput = {
  messages: Message[]
  tasks: Task[]
  agents: PublicAgent[]
  permits?: PermitRequest[]
  // Not needed for the rows yet; the page has it at hand.
  userName?: string
  now: number
}

const LINE_MAX = 80

// One line of plain words: inline markdown (bold, code ticks) dropped.
function clip(text: string, max = LINE_MAX) {
  const flat = text.replace(/\*\*|__|`/g, "").replace(/\s+/g, " ").trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

// A message's one line: its stored gist, the rules' cut, or its opening.
function lineOf(message: Message) {
  return clip(message.gist?.text ?? gistOf(message.text) ?? message.text.replace(/^【本轮结束】/, "").replace(/[#>*`|]/g, ""))
}

// A written note's first sentence (a review note, a reason for 卡住).
function firstSentence(text: string | undefined) {
  const flat = text?.replace(/^【本轮结束】/, "").trim()
  if (!flat) return undefined
  const sentence = flat.match(/^[^\n]+?[。！？!?](?=\s|$|[^。！？!?])/u)?.[0] ?? flat.split("\n")[0]
  return clip(sentence)
}

function sameDay(a: number, b: number) {
  const x = new Date(a)
  const y = new Date(b)
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate()
}

function isAgentReply(message: Message) {
  return message.kind === "chat" && message.authorId !== "human" && message.authorId !== "room" && !message.ask
}

// What a talk chain is about: its first message in a few words; one that
// only calls seats reads 「叫 X」.
function titleOf(root: Message, seats: Map<string, PublicAgent>) {
  if (root.authorId !== "human") return clip(lineOf(root), 40)
  const words = clip(root.text.replace(/@[\p{L}\p{N}_-]+\s*/gu, ""), 40)
  if (words) return words
  const names = root.mentions.map((id) => seats.get(id)?.name ?? id).join("、")
  return names ? `叫 ${names}` : "（没有文字）"
}

export function digestOf({ messages, tasks, agents, permits = [], now }: DigestInput): Digest {
  const talk = messages.filter((message) => message.kind !== "system" && !message.recalled)
  const { rootOf, chains } = chainsOf(talk)
  const born = firstNamed(talk, tasks)
  const taskById = new Map(tasks.map((task) => [task.id, task]))
  const seatById = new Map(agents.map((seat) => [seat.id, seat]))
  const ownerOf = (task: Task) => task.ownerId ?? undefined

  // Which to-dos each chain hosts.
  const hosted = new Map<string, Task[]>()
  for (const task of tasks) {
    const first = born.get(task.id)
    if (!first) continue
    const root = rootOf(first)
    hosted.set(root, [...(hosted.get(root) ?? []), task])
  }

  // Each message's to-dos.
  const byTask = new Map<string, Message[]>()
  const put = (taskId: string, message: Message) => {
    const list = byTask.get(taskId) ?? []
    if (list.at(-1)?.id !== message.id) list.push(message)
    byTask.set(taskId, list)
  }
  const placed = new Set<string>()
  for (const message of talk) {
    const direct = new Set<string>()
    if (message.taskId && taskById.has(message.taskId)) direct.add(message.taskId)
    if (message.verdict && taskById.has(message.verdict.taskId)) direct.add(message.verdict.taskId)
    if (message.handoff) {
      for (const task of tasks) if (task.title === message.handoff.taskTitle) direct.add(task.id)
    }
    for (const id of namedTasks(message.text)) if (taskById.has(id)) direct.add(id)
    if (direct.size === 0) {
      const here = hosted.get(rootOf(message)) ?? []
      const mine = here.filter((task) => ownerOf(task) === message.authorId)
      const pick = mine.length > 0 ? mine : here.length === 1 ? here : []
      for (const task of pick) direct.add(task.id)
    }
    for (const id of direct) put(id, message)
    if (direct.size > 0) placed.add(message.id)
  }

  // Open questions and permission prompts, by the seat waiting on them.
  const openAsk = new Map<string, Message>()
  for (const message of talk) if (message.ask?.state === "open") openAsk.set(message.authorId, message)
  const permitOf = new Map<string, PermitRequest>()
  for (const permit of permits) if (!permitOf.has(permit.agentId)) permitOf.set(permit.agentId, permit)

  const rows: DigestRow[] = []
  for (const task of tasks) {
    const list = byTask.get(task.id) ?? []
    const owner = ownerOf(task)
    const seat = owner ? seatById.get(owner) : undefined
    const steps = task.steps ?? []
    const doneSteps = steps.filter((step) => step.state === "done").length
    const current = steps.find((step) => step.state === "doing") ?? steps.find((step) => step.state === "todo")
    const lastAt = Math.max(task.updatedAt, ...list.map((message) => message.createdAt))
    const latestReply = [...list].reverse().find(isAgentReply)
    const row: DigestRow = {
      id: task.id,
      kind: "task",
      state: "stuck",
      title: task.title,
      owner: owner ? { id: owner, name: seat?.name ?? task.ownerName ?? owner } : undefined,
      line: "",
      steps: steps.length > 0 ? { done: doneSteps, total: steps.length, current: current?.text } : undefined,
      at: lastAt,
      messageIds: list.map((message) => message.id),
      attachments: list.reduce((sum, message) => sum + (message.attachments?.length ?? 0), 0),
      check:
        task.check && ["passed", "failed", "unverified"].includes(task.check.state)
          ? { state: task.check.state, name: task.check.name, note: task.check.note }
          : undefined,
    }
    const fallback = latestReply ? lineOf(latestReply) : undefined

    // The order of the checks is the order of the facts' weight.
    const ask = owner ? openAsk.get(owner) : undefined
    const permit = owner ? permitOf.get(owner) : undefined
    const lastCall = [...list].reverse().map((message) => message.calls?.find((call) => call.id === owner)).find(Boolean)
    if (task.status === "done") {
      row.state = "done"
      row.line = "已验收"
    } else if (awaitingReview(task)) {
      row.state = "you"
      row.need = "review"
      row.since = task.review?.state === "waiting" ? task.review.at : task.updatedAt
      row.line = firstSentence(task.review?.state === "waiting" ? task.review.note : undefined) ?? fallback ?? "等你验收"
    } else if (ask) {
      row.state = "you"
      row.need = "answer"
      row.askId = ask.id
      row.since = ask.createdAt
      row.line = clip(ask.text)
      if (!row.messageIds.includes(ask.id)) row.messageIds = [...row.messageIds, ask.id]
    } else if (permit && seat?.runId) {
      row.state = "you"
      row.need = "permit"
      row.permitId = permit.id
      row.since = permit.at
      row.line = clip(`要权限：${permit.kind === "full" ? "这次唤起的全部权限" : (permit.tool ?? "")}${permit.input ? ` ${permit.input}` : ""}${permit.reason ? `（${permit.reason}）` : ""}`)
    } else if (task.status === "blocked") {
      row.since = task.updatedAt
      const why = [...task.history].reverse().find((event) => event.action === "卡住")?.note
      row.line = `卡住：${firstSentence(why) ?? "没写原因"}`
    } else if (!owner) {
      row.since = task.updatedAt
      row.line = "没人负责"
    } else if (seat?.owes?.tasks.some((item) => item.id === task.id)) {
      row.since = seat.owes.since
      row.line = `停着，还欠这件${current ? `：到「${current.text}」` : ""}`
    } else if (lastCall && (lastCall.state === "failed" || lastCall.state === "cut")) {
      row.since = lastCall.at
      row.line = `${lastCall.state === "failed" ? "没叫成" : "中途断了"}${lastCall.note ? `：${clip(lastCall.note, 40)}` : ""}`
    } else if (seat?.runId || seat?.status === "working") {
      row.state = "doing"
      row.line = seat.doing ? clip(seat.doing) : (fallback ?? "在做")
    } else {
      row.since = lastAt
      row.line = doneSteps === 0 ? "还没开始" : `停着：到「${current?.text ?? "最后一步"}」`
    }
    if (!row.line) row.line = fallback ?? ""
    rows.push(row)
  }

  // Talk: reply chains with no to-do in them and an agent's reply.
  const owning = new Set(tasks.filter((task) => task.status !== "done" && task.ownerId).map((task) => task.ownerId as string))
  const talkRows: DigestRow[] = []
  for (const [rootId, chain] of chains) {
    if (hosted.has(rootId)) continue
    const loose = chain.filter((message) => !placed.has(message.id))
    if (loose.length === 0 || !loose.some(isAgentReply)) continue
    const root = loose[0]
    const latest = [...loose].reverse().find(isAgentReply)!
    const ask = loose.find((message) => message.ask?.state === "open" && !owning.has(message.authorId))
    talkRows.push({
      id: root.id,
      kind: "talk",
      state: ask ? "you" : "talk",
      title: titleOf(root, seatById),
      owner: { id: latest.authorId, name: seatById.get(latest.authorId)?.name ?? latest.authorName },
      line: ask ? clip(ask.text) : lineOf(latest),
      need: ask ? "answer" : undefined,
      askId: ask?.id,
      at: Math.max(...loose.map((message) => message.createdAt)),
      since: ask?.createdAt,
      messageIds: loose.map((message) => message.id),
      attachments: loose.reduce((sum, message) => sum + (message.attachments?.length ?? 0), 0),
    })
  }

  const byWait = (a: DigestRow, b: DigestRow) => (a.since ?? a.at) - (b.since ?? b.at)
  const byLatest = (a: DigestRow, b: DigestRow) => b.at - a.at
  const you = [...rows.filter((row) => row.state === "you"), ...talkRows.filter((row) => row.state === "you")].sort(byWait)
  const stuck = rows.filter((row) => row.state === "stuck").sort(byWait)
  const doing = rows.filter((row) => row.state === "doing").sort(byLatest)
  // 「今天做完」: done today by the local date (the last change to a done to-do is its sign-off).
  const done = rows.filter((row) => row.state === "done" && sameDay(taskById.get(row.id)!.updatedAt, now)).sort(byLatest)
  const loose = talkRows.filter((row) => row.state === "talk").sort(byLatest)
  return {
    counts: { you: you.length, stuck: stuck.length, doing: doing.length, done: done.length },
    you,
    stuck,
    doing,
    done,
    talk: loose,
  }
}
