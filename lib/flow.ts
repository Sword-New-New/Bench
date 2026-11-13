import type { Message, Task } from "@/lib/types"

// One piece of work as a picture: what the user asked for, whom it went to,
// the todos it turned into, and where each stands. Worked out from what the
// room already keeps (who replied to what, who was called, each todo's owner,
// steps and review); nothing is stored for it. The page draws it (the
// 「流程」 view) and `flowText` says the same thing in words, for a seat.
//
// A piece of work is a reply chain: a message that answers nothing, and
// everything under it. A todo belongs to the chain whose message first names
// its id (t_…), since that is how todos are announced.

export type FlowState = "you" | "doing" | "wait" | "stuck" | "done"

export type FlowNode = {
  // The message's id, or the todo's.
  id: string
  // say: the user. call: a seat calling others or handing out todos.
  // task: a todo, one block for its whole life. ask: a question to the user.
  // reply: a seat that only answered.
  kind: "say" | "call" | "task" | "ask" | "reply"
  // The seat's id, or "human".
  lane: string
  at: number
  title: string
  note: string
  // you: waiting for the user (to accept, to answer). wait: waiting for a
  // todo before it. stuck: blocked.
  state: FlowState
  // Where a click on the block goes in the thread.
  messageId?: string
  taskId?: string
}

// call: one led to the other. wait: the second can't start before the first.
export type FlowEdge = { from: string; to: string; kind: "call" | "wait" }

export type Flow = {
  // Its first message.
  id: string
  title: string
  at: number
  lastAt: number
  // Who took part, in the order they first appear.
  lanes: { id: string; name: string }[]
  nodes: FlowNode[]
  edges: FlowEdge[]
  // How many blocks wait for the user.
  waiting: number
}

const TASK_ID = /\bt_[0-9a-f]{8}\b/g

function clip(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

// A message in a few words: its first sentence, without the @s and markup.
function gist(text: string, max = 22) {
  const line = text
    .replace(/【本轮结束】/g, "")
    .replace(/@[\p{L}\p{N}_-]+/gu, "")
    .replace(/[`*#>]/g, "")
    .replace(/\s+/g, " ")
    .replace(/^[\s，、：:,.。]+/, "")
    .trim()
  const first = line.split(/[。！？!?；;\n]/)[0] || line
  return clip(first, max) || "（没有文字）"
}

type Dated = { at: number }
const byTime = (a: Dated, b: Dated) => a.at - b.at

// `after`: todos this one waits for. Not kept yet (the second step of the
// flow work adds it); read here so the picture shows it as soon as it is.
type Waiting = Task & { after?: string[] }

export function flowsOf(messages: Message[], tasks: Task[], seats: { id: string; name: string }[], userName: string): Flow[] {
  const talk = messages.filter((message) => message.kind !== "system" && !message.recalled)
  const byId = new Map(talk.map((message) => [message.id, message]))
  const nameOf = new Map(seats.map((seat) => [seat.id, seat.name]))
  for (const message of talk) if (!nameOf.has(message.authorId)) nameOf.set(message.authorId, message.authorName)
  nameOf.set("human", userName)

  const rootOf = (message: Message) => {
    let at = message
    const seen = new Set<string>()
    while (at.replyTo && !seen.has(at.id)) {
      seen.add(at.id)
      const up = byId.get(at.replyTo)
      if (!up) break
      at = up
    }
    return at.id
  }
  const chains = new Map<string, Message[]>()
  for (const message of talk) {
    const root = rootOf(message)
    const list = chains.get(root)
    if (list) list.push(message)
    else chains.set(root, [message])
  }

  // The message that first names each todo.
  const taskById = new Map(tasks.map((task) => [task.id, task]))
  const born = new Map<string, Message>()
  for (const message of talk) {
    for (const id of message.text.match(TASK_ID) ?? []) {
      if (taskById.has(id) && !born.has(id)) born.set(id, message)
    }
  }

  const flows: Flow[] = []
  for (const [rootId, chain] of chains) {
    const mine = tasks.filter((task) => {
      const first = born.get(task.id)
      return first !== undefined && rootOf(first) === rootId
    })
    const nodes = new Map<string, FlowNode>()
    const edges: FlowEdge[] = []
    const link = (from: string | undefined, to: string, kind: FlowEdge["kind"] = "call") => {
      if (!from || from === to || !nodes.has(from) || !nodes.has(to)) return
      if (!edges.some((edge) => edge.from === from && edge.to === to)) edges.push({ from, to, kind })
    }
    const introduces = (message: Message) => mine.filter((task) => born.get(task.id)?.id === message.id)
    const ownerOf = (task: Task) => task.ownerId ?? task.createdById
    const answers = new Set(chain.flatMap((message) => (message.ask?.answerId ? [message.ask.answerId] : [])))

    // What was said: the user's words, questions put to the user, and a
    // seat's message when it hands out todos or calls in a seat that has no
    // part in this yet. A seat's other messages (reports, answers back and
    // forth) stay behind its todo's block, or the thread would be redrawn
    // block for block.
    const known = new Set(mine.map(ownerOf))
    const folded: { message: Message; seats: string[] }[] = []
    for (const message of chain) {
      const called = message.mentions.filter((id) => id !== message.authorId)
      const names = called.map((id) => nameOf.get(id) ?? id).join("、")
      const words = gist(message.text)
      const base = { id: message.id, lane: message.authorId, at: message.createdAt, title: words === "（没有文字）" && names ? `叫 ${names}` : words, messageId: message.id }
      const fresh = called.filter((id) => !known.has(id))
      known.add(message.authorId)
      if (message.ask) {
        const open = message.ask.state === "open"
        nodes.set(message.id, { ...base, kind: "ask", state: open ? "you" : "done", note: open ? "等你回答" : `你答：${clip(message.ask.answer ?? "", 16)}` })
      } else if (answers.has(message.id)) {
        continue
      } else if (message.authorId === "human" || message.id === rootId) {
        nodes.set(message.id, { ...base, kind: message.authorId === "human" ? "say" : "call", state: "done", note: "" })
      } else {
        const made = introduces(message).length
        if (made === 0 && fresh.length === 0) {
          if (called.length > 0) folded.push({ message, seats: called })
          continue
        }
        const note = made > 0 ? `派了 ${made} 条待办` : `叫了 ${fresh.map((id) => nameOf.get(id) ?? id).join("、")}`
        nodes.set(message.id, { ...base, kind: "call", state: "done", note })
      }
    }

    // The todos, one block each, placed when its owner first touched it.
    for (const task of mine) {
      const first = born.get(task.id)!
      const steps = task.steps ?? []
      const done = steps.filter((step) => step.state === "done").length
      const progress = steps.length > 0 ? `${done}/${steps.length} 步` : ""
      const before = ((task as Waiting).after ?? [])
        .map((id) => taskById.get(id))
        .filter((item): item is Task => item !== undefined && item.status !== "done")
      let state: FlowState = "doing"
      let note = progress || "在做"
      if (task.status === "done") {
        state = "done"
        note = task.review?.state === "passed" ? "已验收" : "做完"
      } else if (task.review?.state === "waiting") {
        state = "you"
        note = [progress, "等你验收"].filter(Boolean).join(" · ")
      } else if (task.status === "blocked") {
        state = "stuck"
        note = clip(task.history.at(-1)?.note || "卡住了", 18)
      } else if (before.length > 0) {
        state = "wait"
        note = `等：${clip(before[0].title, 14)}`
      } else if (task.review?.state === "rejected") {
        note = ["被打回", progress].filter(Boolean).join(" · ")
      } else if (steps.length > 0 && steps.every((step) => step.state === "todo")) {
        note = "还没开始"
      }
      const owner = ownerOf(task)
      const said = chain.filter((message) => message.authorId === owner)
      const latest = said.findLast((message) => message.text.includes(task.id)) ?? said.at(-1) ?? first
      const touched = task.ownerName ? task.history.find((event) => event.actor === task.ownerName && event.at > first.createdAt)?.at : undefined
      const spoke = said.find((message) => message.createdAt > first.createdAt)
      const starts = [touched, spoke ? spoke.createdAt - 1 : undefined].filter((at): at is number => at !== undefined)
      nodes.set(task.id, {
        id: task.id,
        kind: "task",
        lane: owner,
        at: starts.length > 0 ? Math.max(first.createdAt + 1, Math.min(...starts)) : first.createdAt + 1,
        title: clip(task.title, 20),
        note,
        state,
        messageId: latest.id,
        taskId: task.id,
      })
    }

    // A seat that spoke but has no block yet: its last answer.
    const lanesSoFar = new Set([...nodes.values()].map((node) => node.lane))
    const last = new Map<string, Message>()
    for (const message of chain) if (message.authorId !== "human") last.set(message.authorId, message)
    for (const [seat, message] of last) {
      if (lanesSoFar.has(seat)) continue
      nodes.set(message.id, { id: message.id, kind: "reply", lane: seat, at: message.createdAt, title: gist(message.text), note: "", state: "done", messageId: message.id })
    }

    // What led to what. A todo hangs from the message that named it. A seat's
    // question or call hangs from the todo it was on, else from what it answered.
    const above = (message: Message) => {
      let at = message
      const seen = new Set<string>()
      while (at.replyTo && !seen.has(at.id)) {
        seen.add(at.id)
        const up = byId.get(at.replyTo)
        if (!up) break
        if (nodes.has(up.id)) return up.id
        at = up
      }
      return rootId
    }
    for (const node of [...nodes.values()]) {
      if (node.kind === "task") {
        link(born.get(node.id)!.id, node.id)
        continue
      }
      if (node.id === rootId) continue
      const message = byId.get(node.id)!
      const own = [...nodes.values()]
        .filter((item) => item.kind === "task" && item.lane === node.lane && item.at < node.at)
        .sort(byTime)
        .at(-1)
      link(node.kind !== "say" && own ? own.id : above(message), node.id)
    }
    // Whom a message called: that seat's next block, or its todo here; a seat
    // that hasn't answered yet gets a block saying so.
    for (const node of [...nodes.values()]) {
      if (node.kind !== "call" && node.kind !== "say") continue
      const message = byId.get(node.id)!
      const handed = introduces(message).map(ownerOf)
      for (const seat of message.mentions) {
        if (seat === message.authorId || handed.includes(seat)) continue
        const theirs = [...nodes.values()].filter((item) => item.lane === seat).sort(byTime)
        const next = theirs.find((item) => item.at > node.at)
        if (next) {
          link(node.id, next.id)
          continue
        }
        if (theirs.length > 0) continue
        const id = `${message.id}:${seat}`
        nodes.set(id, { id, kind: "reply", lane: seat, at: node.at + 1, title: "被叫到", note: "还没回应", state: "doing", messageId: message.id })
        link(node.id, id)
      }
    }
    // A seat on a todo calling the owner of a later todo: one leads to the other.
    for (const { message, seats } of folded) {
      const from = [...nodes.values()]
        .filter((item) => item.kind === "task" && item.lane === message.authorId && item.at <= message.createdAt)
        .sort(byTime)
        .at(-1)
      if (!from) continue
      for (const seat of seats) {
        const to = [...nodes.values()].filter((item) => item.kind === "task" && item.lane === seat && item.at > from.at).sort(byTime)[0]
        if (to) link(from.id, to.id)
      }
    }
    for (const task of mine) {
      for (const id of (task as Waiting).after ?? []) link(id, task.id, "wait")
    }

    const sorted = [...nodes.values()].sort(byTime)
    const lanes: Flow["lanes"] = []
    for (const node of sorted) {
      if (!lanes.some((lane) => lane.id === node.lane)) lanes.push({ id: node.lane, name: nameOf.get(node.lane) ?? node.lane })
    }
    // One person talking to one seat is a conversation, not a flow.
    if (lanes.length < 2 || (lanes.length < 3 && mine.length === 0)) continue
    const root = byId.get(rootId)!
    flows.push({
      id: rootId,
      title: gist(root.text, 28),
      at: root.createdAt,
      lastAt: Math.max(chain.at(-1)!.createdAt, ...mine.map((task) => task.updatedAt)),
      lanes,
      nodes: sorted,
      edges,
      waiting: sorted.filter((node) => node.state === "you").length,
    })
  }
  return flows.sort((a, b) => b.lastAt - a.lastAt)
}

// The same picture in words, for a seat that is woken into it: who holds
// what and where each stands. `you` is the seat reading it.
export function flowText(flow: Flow, you?: string) {
  const name = new Map(flow.lanes.map((lane) => [lane.id, lane.name]))
  const human = name.get("human") ?? "用户"
  const who = (lane: string) => (lane === you ? "你" : (name.get(lane) ?? lane))
  const lines: string[] = []
  for (const node of flow.nodes) {
    if (node.state === "done") continue
    const what = node.kind === "task" ? `${node.taskId} ${node.title}` : node.kind === "ask" ? `问 ${human}：${node.title}` : node.title
    const how = node.note.replace(/等你/g, `等 ${human} `).replace(/^你答/, `${human} 答`)
    lines.push(`  ${who(node.lane)}：${what}${how ? `（${how}）` : ""}`)
  }
  const first = flow.nodes.find((node) => node.id === flow.id)
  const when = new Date(flow.at).toTimeString().slice(0, 5)
  const head = `这件事（${first ? who(first.lane) : human} ${when}「${flow.title}」）现在的样子：`
  if (lines.length === 0) return `${head}\n  都做完了。`
  const mineLeft = you ? flow.nodes.some((node) => node.lane === you && node.state !== "done") : true
  return [head, ...lines, ...(you && !mineLeft ? ["  你没有排着的事。"] : [])].join("\n")
}
