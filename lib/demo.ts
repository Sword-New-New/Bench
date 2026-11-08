import { STATUS_LABEL, TASK_STATUS_LABEL, liveStatus } from "@/lib/status"
import {
  actOnTaskAs,
  createTaskAs,
  join,
  onMessage,
  postSystem,
  pulseAgent,
  removeAgent,
  sayAs,
  snapshot,
  touch,
} from "@/lib/store"
import { shortText } from "@/lib/text"
import type { Actor, Message, PublicAgent } from "@/lib/types"

const DEMOS = [
  {
    name: "阿衡",
    model: "grok-4.7",
    role: "协调",
    strengths: ["拆任务", "派工", "汇总"],
    doing: "在看谁有空",
  },
  {
    name: "阿构",
    model: "composer",
    role: "实现",
    strengths: ["界面", "交互", "做成能点的"],
    doing: "空着，等一件具体的活",
  },
  {
    name: "阿证",
    model: "claude",
    role: "审查",
    strengths: ["边界", "回归", "挑没做完的洞"],
    doing: "空着，等一件要复核的活",
  },
] as const

type DemoRuntime = {
  timers: Set<ReturnType<typeof setTimeout>>
  handled: Set<string>
  finishing: Set<string>
  heart?: ReturnType<typeof setInterval>
  bound?: boolean
}

const globalDemo = globalThis as typeof globalThis & {
  __benchDemo?: DemoRuntime
  __benchOnMessage?: (message: Message) => void
}

function runtime() {
  if (!globalDemo.__benchDemo) {
    globalDemo.__benchDemo = {
      timers: new Set(),
      handled: new Set(),
      finishing: new Set(),
    }
  }
  if (!globalDemo.__benchDemo.finishing) globalDemo.__benchDemo.finishing = new Set()
  return globalDemo.__benchDemo
}

function later(fn: () => void, ms: number) {
  const rt = runtime()
  const timer = setTimeout(() => {
    rt.timers.delete(timer)
    try {
      fn()
    } catch (error) {
      console.error(error)
    }
  }, ms)
  rt.timers.add(timer)
}

function byName(name: string) {
  return snapshot().agents.find((agent) => agent.name === name)
}

function actorOf(agent: PublicAgent): Actor {
  return { type: "agent", id: agent.id, name: agent.name }
}

function once(agentId: string, messageId: string) {
  const rt = runtime()
  const key = `${agentId}:${messageId}`
  if (rt.handled.has(key)) return false
  rt.handled.add(key)
  if (rt.handled.size > 2000) {
    const first = rt.handled.values().next().value
    if (first) rt.handled.delete(first)
  }
  return true
}

function startHeart() {
  const rt = runtime()
  if (rt.heart) return
  rt.heart = setInterval(() => {
    for (const agent of snapshot().agents) {
      if (agent.demo) touch(agent.id)
    }
  }, 12_000)
}

export function ensureDemo() {
  const rt = runtime()
  globalDemo.__benchOnMessage = (message) => {
    if (message.kind === "system") return
    later(() => respond(message), 550)
  }
  if (!rt.bound) {
    rt.bound = true
    onMessage((message) => globalDemo.__benchOnMessage?.(message))
  }
  startHeart()
}

export function seatDemos() {
  ensureDemo()
  const created: string[] = []
  const skipped: string[] = []
  for (const spec of DEMOS) {
    const existing = byName(spec.name)
    if (existing) {
      if (!existing.demo) skipped.push(spec.name)
      continue
    }
    join(
      {
        name: spec.name,
        model: spec.model,
        role: spec.role,
        strengths: [...spec.strengths],
        doing: spec.doing,
      },
      { demo: true },
    )
    created.push(spec.name)
  }
  if (created.length > 0) {
    const skipNote =
      skipped.length > 0 ? ` ${skipped.join("、")} 已经是真席位，演示没有占用。` : ""
    postSystem(
      `演示席位入座：${created.join("、")}。他们会接话和交接，但不会改你的代码。${skipNote}`,
    )
  }
  return { created, skipped, ...snapshot() }
}

export function dismissDemos() {
  ensureDemo()
  const rt = runtime()
  for (const timer of rt.timers) clearTimeout(timer)
  rt.timers.clear()
  const names = snapshot()
    .agents.filter((agent) => agent.demo)
    .map((agent) => agent.name)
  for (const agent of snapshot().agents) {
    if (agent.demo) removeAgent(agent.id, true)
  }
  if (names.length > 0) postSystem(`演示席位离席：${names.join("、")}。`)
  return snapshot()
}

function respond(message: Message) {
  coordinate(message)
  build(message)
  review(message)
}

function coordinate(message: Message) {
  const me = byName("阿衡")
  if (!me?.demo || message.authorId !== "human") return
  if (!once(me.id, message.id)) return
  const text = message.text.trim()
  const mentionsMe = message.mentions.includes(me.id)
  const mentionsOther = message.mentions.some((id) => id !== me.id)
  if (mentionsOther && !mentionsMe) return

  const actor = actorOf(me)
  if (isAck(text)) {
    sayAs(actor, { text: "收到。还没完成的任务继续由原来的负责人做。", replyTo: message.id })
    return
  }
  if (isStatus(text)) {
    sayAs(actor, { text: statusReport(), replyTo: message.id })
    return
  }
  if (!wantsBuild(text) && !wantsReview(text)) {
    sayAs(actor, {
      replyTo: message.id,
      text: "要一起做的话，说清这阶段要交出来的东西，以及做完交给谁看。同一阶段我只派一个负责人。",
    })
    return
  }
  routeWork(me, text, message.id)
}

function build(message: Message) {
  const me = byName("阿构")
  if (!me?.demo || message.authorId === me.id) return
  const handed = message.kind === "handoff" && message.handoff?.toId === me.id
  const asked =
    message.kind === "chat" &&
    message.authorId === "human" &&
    message.mentions.includes(me.id) &&
    !coordinatorWillRoute(message)
  if (!handed && !asked) return
  if (!once(me.id, message.id)) return

  const actor = actorOf(me)
  const title = shortText(message.handoff?.taskTitle || message.text)
  let taskId = message.taskId
  if (!taskId) {
    taskId = createTaskAs(actor, {
      title,
      detail: message.text,
      owner: me.id,
      status: "doing",
    }).task.id
  }
  pulseAgent(me.id, "working", `在做：${title}`)
  sayAs(actor, {
    replyTo: message.id,
    text: [
      `我接了「${title}」。`,
      "这阶段只做能看见的部分：结构、空状态，以及窄屏上怎么排。",
      "复核留给下一阶段，我不在这里同时改两稿。",
    ].join("\n"),
  })
  const rt = runtime()
  if (rt.finishing.has(taskId)) return
  rt.finishing.add(taskId)
  later(() => {
    rt.finishing.delete(taskId)
    finishBuild(taskId, title)
  }, 1700)
}

function review(message: Message) {
  const me = byName("阿证")
  if (!me?.demo || message.authorId === me.id) return
  const handed = message.kind === "handoff" && message.handoff?.toId === me.id
  const asked =
    message.kind === "chat" &&
    message.authorId === "human" &&
    message.mentions.includes(me.id) &&
    !coordinatorWillRoute(message)
  if (!handed && !asked) return
  if (!once(me.id, message.id)) return

  const actor = actorOf(me)
  const title = shortText(message.handoff?.taskTitle || message.text)
  let taskId = message.taskId
  if (!taskId) {
    taskId = createTaskAs(actor, {
      title: title.startsWith("复核") ? title : `复核：${title}`,
      detail: message.text,
      owner: me.id,
      status: "doing",
    }).task.id
  }
  pulseAgent(me.id, "working", `在看：${title}`)
  sayAs(actor, {
    replyTo: message.id,
    text: [
      `我按「${title}」看了一遍，不重做实现。`,
      "要补的边界：没有内容时的空状态、请求失败时谁负责说、窄屏上主按钮还在不在拇指范围内。",
      "这阶段我看完了。若要改，再开一条新任务，不要两个人同时改这一条。",
    ].join("\n"),
  })
  const task = snapshot().tasks.find((item) => item.id === taskId)
  if (task && task.status !== "done") {
    actOnTaskAs(actor, { taskId, action: "done", note: "边界看完了" })
  }
  pulseAgent(me.id, "idle", "刚看完，等下一件要复核的活")
  const coordinator = byName("阿衡")
  if (coordinator?.demo) pulseAgent(coordinator.id, "idle", "这一轮交齐了")
}

function finishBuild(taskId: string, title: string) {
  const me = byName("阿构")
  const reviewer = byName("阿证")
  if (!me?.demo) return
  const actor = actorOf(me)
  const task = snapshot().tasks.find((item) => item.id === taskId)
  if (!task || task.status === "done") {
    pulseAgent(me.id, "idle", "空着，等一件具体的活")
    return
  }
  actOnTaskAs(actor, { taskId, action: "done", note: "能看的一版好了" })
  const review = snapshot().tasks.find((item) => item.status === "blocked" && item.title === `复核：${title}`)
  if (review && reviewer?.demo) {
    actOnTaskAs(actor, {
      taskId: review.id,
      action: "handoff",
      to: reviewer.id,
      note: `「${title}」已经有一版能看的。请只看边界：空状态、失败时谁负责说、窄屏上主按钮还在不在。不要重做实现。`,
    })
    pulseAgent(me.id, "idle", "刚交出去，等下一件")
    return
  }
  sayAs(actor, { text: `「${title}」这版可以看了。` })
  pulseAgent(me.id, "idle", "刚做完，等下一件")
}

function routeWork(me: PublicAgent, text: string, replyTo: string) {
  const actor = actorOf(me)
  const builder = byName("阿构")
  const reviewer = byName("阿证")
  const title = shortText(text)
  const build = wantsBuild(text) || !wantsReview(text)
  const review = wantsReview(text)
  pulseAgent(me.id, "working", `在拆：${title}`)

  if (build && review && builder?.demo && reviewer?.demo) {
    const created = createTaskAs(actor, { title, detail: text, status: "open" })
    createTaskAs(actor, { title: `复核：${title}`, detail: text, status: "blocked" })
    sayAs(actor, {
      replyTo,
      text: `这件事拆成两段，不同时改。\n先由 @${builder.name} 做出能看的一版。\n做完再交给 @${reviewer.name} 看边界。同一阶段只有一个负责人。`,
    })
    actOnTaskAs(actor, {
      taskId: created.task.id,
      action: "handoff",
      to: builder.id,
      note: `先做这一版：${title}。做完交给 @${reviewer.name}，你自己先别展开复核。`,
    })
    pulseAgent(me.id, "idle", "在等这一轮交回来")
    return
  }

  if (build && builder?.demo) {
    const created = createTaskAs(actor, { title, detail: text, status: "open" })
    const follow = reviewer?.demo ? `做完在房间里说一声，需要复核再交给 @${reviewer.name}。` : "做完把结果发回房间。"
    sayAs(actor, { replyTo, text: `@${builder.name} 你先做。${follow}` })
    actOnTaskAs(actor, {
      taskId: created.task.id,
      action: "handoff",
      to: builder.id,
      note: `这阶段只做：${title}。`,
    })
    pulseAgent(me.id, "idle", "在等这一轮交回来")
    return
  }

  if (review && reviewer?.demo) {
    const created = createTaskAs(actor, {
      title: `复核：${title}`,
      detail: text,
      status: "open",
    })
    sayAs(actor, { replyTo, text: `@${reviewer.name} 这阶段由你看，不重做实现。` })
    actOnTaskAs(actor, {
      taskId: created.task.id,
      action: "handoff",
      to: reviewer.id,
      note: `只看边界，不要改实现：${title}。`,
    })
    pulseAgent(me.id, "idle", "在等复核结果")
    return
  }

  sayAs(actor, {
    replyTo,
    text: "房间里还没有能接这段的演示席位。用接入说明把真的 agent 拉进来，或先让演示入座。",
  })
  pulseAgent(me.id, "idle", "在等有人入座")
}

function statusReport() {
  const room = snapshot()
  const people = room.agents.map((agent) => {
    const status = liveStatus(agent.status, agent.lastSeenAt)
    return `${agent.name} · ${agent.model} · ${agent.role} · ${STATUS_LABEL[status]}：${agent.doing || "还没写正在做的事"}`
  })
  const open = room.tasks.filter((task) => task.status !== "done")
  const tasks =
    open.length === 0
      ? "没有未完成的任务。"
      : open
          .map((task) => {
            const owner = task.ownerName ? `负责人 ${task.ownerName}` : "还没有负责人"
            return `「${task.title}」${owner}，${TASK_STATUS_LABEL[task.status]}`
          })
          .join("\n")
  return `现在在席的是：\n${people.join("\n") || "还没有人入座。"}\n\n${tasks}`
}

function coordinatorWillRoute(message: Message) {
  const lead = byName("阿衡")
  if (!lead?.demo || message.authorId !== "human" || message.kind !== "chat") return false
  const mentionsLead = message.mentions.includes(lead.id)
  const mentionsOther = message.mentions.some((id) => id !== lead.id)
  if (mentionsOther && !mentionsLead) return false
  return wantsBuild(message.text) || wantsReview(message.text)
}

function isAck(text: string) {
  const bare = text.replace(/@[\p{L}\p{N}_-]+/gu, "").trim()
  return /^(好|好的|嗯|收到|行|可以|ok|OK|谢谢|谢了)$/.test(bare)
}

function isStatus(text: string) {
  return /谁在|谁现在|进度|怎么样|擅长|有空|在席|在做/.test(text) && !wantsBuild(text) && !wantsReview(text)
}

function wantsBuild(text: string) {
  return /做一|做个|做版|做出|做一个|写一|写个|改一|改个|页面|界面|实现|样式|交互|修一|修个|定价|登录/.test(text)
}

function wantsReview(text: string) {
  return /审查|复核|看一遍|看一下|边界|漏洞|风险/.test(text)
}
