"use client"

import { useEffect, useState, useSyncExternalStore } from "react"
import { AlertTriangle, ArrowLeft, ArrowRightLeft, BookOpen, Check, ChevronDown, ClipboardCheck, ConciergeBell, Cpu, Ellipsis, ExternalLink, ListTree, LogOut, RotateCcw, ShieldAlert, Shrink, Square } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/components/room/api"
import { Avatar, seatLook, useTick } from "@/components/room/bits"
import { CONTEXT_WARN, ContextLine, contextFacts, useContexts } from "@/components/room/context"
import { unreadIn, useSeenAt } from "@/components/room/project-rail"
import { openProjectAt } from "@/components/room/refs"
import { openSeatProfileFor } from "@/components/room/seat-profile-dialog"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { clock, plainCheckText } from "@/lib/status"
import type { Project, ProjectInfo, PublicAgent } from "@/lib/types"

// The front desk (前台): one seat that looks across every project for the
// user. Its room is a project marked `front` (lib/store.ts), pinned at the top
// of the project rail (project-rail.tsx FrontCard). It doesn't stand between
// the user and the rooms: every room goes on as before, and any of them is a
// click away. First stage: it only looks (bench_overview / bench_peek), it
// can't hand out work, sign off or answer permits.

// What a seat opened as the front desk does, as its 分工.
export const FRONT_ROLE = "前台：替你看各项目"
export const FRONT_SEAT = "前台"

// The seat on duty at the desk: the one opened for it (its 分工 starts with
// 前台), else the first there.
export function deskSeat<T extends { demo?: boolean; role?: string }>(agents: T[]) {
  const seats = agents.filter((agent) => !agent.demo)
  return seats.find((agent) => agent.role?.startsWith(FRONT_SEAT)) ?? seats[0]
}

// The last project open before the desk, for 「回到」; kept in this browser so
// a reload at the desk still knows.
const BACK_KEY = "bench-front-back"
const backListeners = new Set<() => void>()

export function rememberBack(id: string) {
  try {
    if (localStorage.getItem(BACK_KEY) === id) return
    localStorage.setItem(BACK_KEY, id)
  } catch {
    return
  }
  for (const listener of backListeners) listener()
}

function readBack() {
  try {
    return localStorage.getItem(BACK_KEY)
  } catch {
    return null
  }
}

export function useBack() {
  return useSyncExternalStore(
    (listener) => {
      backListeners.add(listener)
      return () => backListeners.delete(listener)
    },
    readBack,
    () => null,
  )
}

// The header's way in and back out: 「前台」 from any project, 「回到〈刚才的
// 项目〉」 from the desk. A red count when something there waits on the user,
// a dot when something was said there since the user last looked. Before
// there is a desk it offers to open one.
export function FrontButton({
  front,
  current,
  back,
  onEnter,
  onBack,
  onEnable,
}: {
  front: Project | undefined
  current: ProjectInfo | null
  // Where 「回到」 goes: the project open before the desk.
  back: Project | undefined
  onEnter: () => void
  onBack: () => void
  onEnable: () => void
}) {
  const seenAt = useSeenAt()
  const inFront = Boolean(current?.front)
  const pill = "flex h-7 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium transition-colors"

  if (inFront) {
    if (!back) return null
    return (
      <button
        type="button"
        onClick={onBack}
        title={`回到「${back.name}」`}
        aria-label={`回到「${back.name}」`}
        className={`${pill} max-w-48 text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground`}
      >
        <ArrowLeft className="size-3.5 shrink-0" />
        <span className="shrink-0">回到</span>
        <span className="hidden min-w-0 truncate sm:inline">{back.name}</span>
      </button>
    )
  }

  if (!front) {
    return (
      <button
        type="button"
        onClick={onEnable}
        title="开启前台：挑一个 AI 值班，你只跟它说话，它替你看所有项目做到哪了、什么在等你"
        aria-label="开启前台"
        className={`${pill} text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground`}
      >
        <ConciergeBell className="size-3.5" />
        <span className="hidden sm:inline">前台</span>
      </button>
    )
  }

  const unread = unreadIn(front, seenAt, current?.id ?? null)
  const notes = [front.waiting ? `${front.waiting} 件等你` : "", unread ? "有新消息" : ""].filter(Boolean)
  return (
    <button
      type="button"
      onClick={onEnter}
      data-tour="front"
      title={["去前台：问它各项目做到哪了、什么在等你", ...notes].join(" · ")}
      aria-label={["前台", ...notes].join("，")}
      className={`${pill} relative text-foreground/80 ring-1 ring-primary/25 hover:bg-primary/[0.08] hover:text-foreground`}
    >
      <ConciergeBell className="size-3.5 text-primary" />
      <span className="hidden sm:inline">前台</span>
      {front.waiting ? (
        <span className="grid h-4 min-w-4 place-items-center rounded-full bg-destructive px-1 text-[0.625rem] leading-none font-semibold text-white">
          {front.waiting > 99 ? "99+" : front.waiting}
        </span>
      ) : unread ? (
        <span className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-primary ring-2 ring-background" aria-hidden="true" />
      ) : null}
    </button>
  )
}

// The desk is a chat with its one AI (AverageJoe 2026-11-16, t_31cd7f9e),
// not a group: no seat column or to-dos beside it. This bar over the chat is
// who is on duty and what can be done with it: stop a reply, see how it got
// there, and, since the desk has no seat column, what a seat's menu holds
// elsewhere: how full its context is, compact it, another model, another
// client in the same seat, or let it go to seat another (only one sits here;
// lib/store.ts checkFrontSeat). With nobody at the desk the bar is where one
// is picked: the welcome below only shows before anything was said.
export function FrontBar({
  seat,
  showDeputyBar = true,
  refreshKey,
  onStop,
  onOpenRun,
  onLeave,
  onStaff,
  onCompact,
  onModel,
}: {
  seat: PublicAgent | undefined
  showDeputyBar?: boolean
  refreshKey?: string
  onStop: (agent: PublicAgent) => void
  onOpenRun: (runId: string) => void
  onLeave: (agent: PublicAgent) => void
  onStaff: () => void
  onCompact: (agent: PublicAgent) => void
  onModel: (agent: PublicAgent) => void
}) {
  const now = useTick(10_000)
  // Read again when another AI sits down, or a reply starts or ends.
  const contexts = useContexts(`${seat?.id ?? ""}:${seat?.runId ?? ""}`)
  const box = "mx-auto flex w-full max-w-3xl items-center gap-3 px-4 py-2 md:px-6"
  if (!seat) {
    return (
      <>
        <div className={box} data-desk="empty">
          <ConciergeBell className="size-4 text-primary" />
          <span className="text-sm text-muted-foreground">还没有人值班</span>
          <Button type="button" size="sm" className="ml-auto rounded-full" onClick={onStaff}>
            挑一个 AI
          </Button>
        </div>
        {showDeputyBar ? <DeputyTodayBar refreshKey={`empty:${refreshKey ?? ""}`} /> : null}
      </>
    )
  }
  const look = seatLook(seat)
  const working = Boolean(seat.runId)
  const context = contexts[seat.id]
  const facts = context ? contextFacts(context, now) : null
  // Same rule as the seat menu's 「压缩上下文」 (roster.tsx).
  const compactable = Boolean(context && seat.callable && !seat.runId && !seat.standby)
  const icon = "flex h-7 items-center gap-1 rounded-full px-2.5 text-xs text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
  return (
    <>
      <div className={box}>
        <Avatar name={seat.name} color={look.color} label={look.label} kind={look.kind} status={seat.status} />
        <div className="min-w-0 flex-1">
          <p className="flex items-baseline gap-2 text-sm">
            <span className="font-semibold">{seat.name}</span>
            <span className="truncate text-xs text-muted-foreground">{look.kind?.label ?? seat.model}</span>
          </p>
          <p className="truncate text-xs text-muted-foreground">{working ? seat.doing || "在回你" : "在值班 · 直接说就行"}</p>
        </div>
        {working && seat.runId ? (
          <>
            <button type="button" className={icon} onClick={() => seat.runId && onOpenRun(seat.runId)}>
              <ListTree className="size-3.5" />
              <span className="hidden sm:inline">过程</span>
            </button>
            <button type="button" className={icon} onClick={() => onStop(seat)}>
              <Square className="size-3" />
              <span className="hidden sm:inline">停下</span>
            </button>
          </>
        ) : null}
        <ContextLine context={context} now={now} className="hidden shrink-0 sm:flex" />
        {facts && facts.near >= CONTEXT_WARN && compactable ? (
          <button
            type="button"
            className="shrink-0 rounded-full bg-amber-500/15 px-2 text-[0.6875rem] leading-5 font-medium text-amber-700 hover:bg-amber-500/25 dark:text-amber-400"
            title={facts.title}
            onClick={() => onCompact(seat)}
          >
            压缩
          </button>
        ) : null}
        <AutoAcceptToggle className={icon} />
        <PatrolToggle className={icon} />
        <DropdownMenu>
          <DropdownMenuTrigger className={`${icon} px-1.5`} aria-label={`${seat.name} 的菜单`}>
            <Ellipsis className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-auto min-w-40">
            {compactable ? (
              <DropdownMenuItem title={facts?.title} onClick={() => onCompact(seat)}>
                <Shrink />
                压缩上下文
              </DropdownMenuItem>
            ) : null}
            {seat.callable ? (
              <DropdownMenuItem onClick={() => onModel(seat)}>
                <Cpu />
                换模型…
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem title="它的分工和长期记忆" onClick={() => openSeatProfileFor(seat.id, { tab: "profile" })}>
              <BookOpen />
              编辑档案…
            </DropdownMenuItem>
            <DropdownMenuItem title="席位和聊天都留着，换一家来接" onClick={() => openSeatProfileFor(seat.id, { tab: "rebind" })}>
              <ArrowRightLeft />
              换客户端…
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" title="它离开，再挑一个新的" onClick={() => onLeave(seat)}>
              <LogOut />
              换人…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {showDeputyBar ? <DeputyTodayBar refreshKey={`${seat.id}:${seat.runId ?? ""}:${refreshKey ?? ""}`} /> : null}
    </>
  )
}

export type DeputyPassItem = {
  project: string
  projectName: string
  taskId: string
  title: string
  at: number
  why: string
  checkName?: string
  ownerName?: string
  checkState?: string
}

const DEPUTY_CHANGED_EVENT = "bench-deputy-changed"
const MONTH_DAY_CLOCK = new Intl.DateTimeFormat("zh-CN", {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
})

export function notifyDeputyChanged() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(DEPUTY_CHANGED_EVENT))
  }
}

function passDateClock(ts: number): string {
  const date = new Date(ts)
  const now = new Date()
  if (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  ) {
    return `今天 ${clock(ts)}`
  }
  return MONTH_DAY_CLOCK.format(date).replace(/\//g, "-")
}

export function useDeputyToday(refreshKey: string) {
  const [passes, setPasses] = useState<DeputyPassItem[]>([])
  const [issues, setIssues] = useState<DeputyPassItem[]>([])
  const [busyId, setBusyId] = useState<string | null>(null)
  const [bump, setBump] = useState(0)

  useEffect(() => {
    const onChanged = () => setBump((n) => n + 1)
    window.addEventListener(DEPUTY_CHANGED_EVENT, onChanged)
    return () => window.removeEventListener(DEPUTY_CHANGED_EVENT, onChanged)
  }, [])

  useEffect(() => {
    let live = true
    const start = new Date()
    start.setHours(0, 0, 0, 0)
    api<{ passes?: DeputyPassItem[]; issues?: DeputyPassItem[] }>(`/api/v1/deputy?since=${start.getTime()}`)
      .then((res) => {
        if (!live) return
        setPasses(Array.isArray(res.passes) ? res.passes : [])
        setIssues(Array.isArray(res.issues) ? res.issues : [])
      })
      .catch(() => {
        if (live) {
          setPasses([])
          setIssues([])
        }
      })
    return () => {
      live = false
    }
  }, [refreshKey, bump])

  const reopen = async (item: DeputyPassItem) => {
    if (busyId) return
    const key = `${item.project}:${item.taskId}`
    setBusyId(key)
    try {
      await api("/api/v1/deputy", {
        method: "POST",
        body: JSON.stringify({
          as: "human",
          action: "reopen",
          project: item.project,
          taskId: item.taskId,
        }),
      })
      const same = (p: DeputyPassItem) => !(p.project === item.project && p.taskId === item.taskId)
      setPasses((prev) => prev.filter(same))
      setIssues((prev) => prev.filter(same))
      notifyDeputyChanged()
      toast.success("已重开，回到等你验收")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "重开失败")
    } finally {
      setBusyId(null)
    }
  }

  return { passes, issues, busyId, reopen }
}

export function DeputyPassList({
  passes,
  busyId,
  onReopen,
  showDate = false,
}: {
  passes: DeputyPassItem[]
  busyId: string | null
  onReopen: (item: DeputyPassItem) => void
  showDate?: boolean
}) {
  return (
    <ul className="divide-y divide-foreground/[0.06]">
      {passes.map((item) => {
        const key = `${item.project}:${item.taskId}`
        return (
          <li key={key} data-deputy-pass={item.taskId} className="flex items-start gap-2 py-1.5 first:pt-0.5 last:pb-0.5">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
                <span className="rounded bg-foreground/[0.06] px-1.5 py-0.5 text-[0.625rem] leading-4 text-muted-foreground">
                  {item.projectName}
                </span>
                <span className="font-medium text-foreground" title={item.taskId}>
                  {item.title}
                </span>
                {item.ownerName ? (
                  <span className="text-[0.6875rem] text-muted-foreground">· 负责人：{item.ownerName}</span>
                ) : null}
                <span className="text-[0.6875rem] text-muted-foreground">
                  · {showDate ? passDateClock(item.at) : clock(item.at)}
                </span>
              </div>
              <p className="mt-0.5 text-[0.6875rem] leading-4 text-muted-foreground">
                {plainCheckText(item.why)}
                {item.checkName ? ` · 检查人：${item.checkName}` : ""}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <Button
                type="button"
                size="xs"
                variant="outline"
                onClick={() => openProjectAt(item.project, item.taskId)}
              >
                <ExternalLink className="size-3" />
                去看
              </Button>
              <Button
                type="button"
                size="xs"
                variant="outline"
                disabled={busyId === key}
                title={item.checkState ? "撤销通过，回到等你验收" : "撤销代签，回到等你验收"}
                onClick={() => onReopen(item)}
              >
                <RotateCcw className="size-3" />
                重开
              </Button>
            </div>
          </li>
        )
      })}
    </ul>
  )
}

// Shown at the top of the front-desk chat when the desk has signed off any
// tasks today (`passes`) or the user signed off recent tasks with check issues
// (`issues`, past 14 days). Hidden when both are 0.
function DeputyTodayBar({ refreshKey }: { refreshKey: string }) {
  const { passes, issues, busyId, reopen } = useDeputyToday(refreshKey)
  const [openTab, setOpenTab] = useState<"passes" | "issues" | null>(null)

  if (passes.length === 0 && issues.length === 0) return null

  const activeTab =
    openTab === "passes" && passes.length > 0
      ? "passes"
      : openTab === "issues" && issues.length > 0
        ? "issues"
        : null

  return (
    <div data-deputy-today className="mx-auto w-full max-w-3xl px-4 pb-1.5 md:px-6">
      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-1.5">
          {passes.length > 0 ? (
            <button
              type="button"
              data-deputy-tab="passes"
              aria-expanded={activeTab === "passes"}
              onClick={() => setOpenTab((v) => (v === "passes" ? null : "passes"))}
              className="inline-flex items-center gap-1.5 rounded-xl border border-emerald-500/25 bg-emerald-500/[0.06] px-3 py-1.5 text-xs font-medium text-emerald-800 hover:opacity-85 dark:text-emerald-200"
            >
              <Check className="size-3.5 shrink-0" />
              今天代你通过 {passes.length} 件
              <ChevronDown className={`size-3.5 shrink-0 transition-transform ${activeTab === "passes" ? "rotate-180" : ""}`} />
            </button>
          ) : null}

          {issues.length > 0 ? (
            <button
              type="button"
              data-deputy-tab="issues"
              aria-expanded={activeTab === "issues"}
              onClick={() => setOpenTab((v) => (v === "issues" ? null : "issues"))}
              className="inline-flex items-center gap-1.5 rounded-xl border border-amber-500/30 bg-amber-500/[0.08] px-3 py-1.5 text-xs font-medium text-amber-800 hover:opacity-85 dark:text-amber-300"
            >
              <AlertTriangle className="size-3.5 shrink-0" />
              带着问题收下的 {issues.length} 件
              <ChevronDown className={`size-3.5 shrink-0 transition-transform ${activeTab === "issues" ? "rotate-180" : ""}`} />
            </button>
          ) : null}
        </div>

        {activeTab === "passes" ? (
          <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/[0.06] px-3 py-2 text-xs">
            <DeputyPassList passes={passes} busyId={busyId} onReopen={(item) => void reopen(item)} />
          </div>
        ) : activeTab === "issues" ? (
          <div data-deputy-issue-list className="rounded-xl border border-amber-500/30 bg-amber-500/[0.08] px-3 py-2 text-xs">
            <p className="mb-1.5 text-[0.6875rem] text-amber-800/80 dark:text-amber-200/80">
              最近 14 天检查没过、没查成或没检查时通过的待办，有问题可重开：
            </p>
            <DeputyPassList passes={issues} busyId={busyId} showDate onReopen={(item) => void reopen(item)} />
          </div>
        ) : null}
      </div>
    </div>
  )
}

// 「查过没问题的，自动替我收下」 (lib/deputy.ts): the one switch for the whole
// room. On: every ordinary project's request for review is checked by
// another AI, and the room passes the ones that pass (「前台代签」, reopenable).
// What was already waiting when it went on stays for the user.
function AutoAcceptToggle({ className }: { className: string }) {
  const [on, setOn] = useState<boolean | null>(null)
  useEffect(() => {
    let live = true
    api<{ auto?: boolean }>("/api/v1/deputy?since=" + Date.now())
      .then((data) => live && setOn(Boolean(data.auto)))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [])
  if (on === null) return null
  return (
    <button
      type="button"
      className={`${className} ${on ? "text-emerald-700 dark:text-emerald-300" : ""}`}
      title={on ? "查过没问题的，正在自动替你收下。点了关掉" : "查过没问题的，自动替我收下"}
      onClick={() => {
        const next = !on
        setOn(next)
        api<{ queued?: number }>("/api/v1/deputy", { method: "POST", body: JSON.stringify({ as: "human", action: "auto", on: next }) })
          .then((data) =>
            toast.success(
              !next
                ? "不再自动收下"
                : data.queued
                  ? `以后查过没问题的会自动收下。之前等着的 ${data.queued} 件正在检查，查完出一张清单给你整批点`
                  : "查过没问题的会自动替你收下，之前等着的还留给你",
            ),
          )
          .catch((error: Error) => {
            setOn(!next)
            toast.error(error.message)
          })
      }}
    >
      <ClipboardCheck className="size-3.5" />
      <span className="hidden sm:inline">{on ? "自动收下开着" : "自动收下"}</span>
    </button>
  )
}

// 「主动提醒」: the patrol (lib/patrol.ts) looks over the projects every few
// minutes and tells the desk's AI, which brings up what matters. To the user
// it is the desk keeping an eye out; off until turned on.
function PatrolToggle({ className }: { className: string }) {
  const [on, setOn] = useState<boolean | null>(null)
  useEffect(() => {
    let live = true
    api<{ on: boolean }>("/api/v1/patrol")
      .then((data) => live && setOn(data.on))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [])
  if (on === null) return null
  return (
    <button
      type="button"
      className={`${className} ${on ? "text-amber-700 dark:text-amber-300" : ""}`}
      title={on ? "前台在盯着各项目，有要紧的会主动告诉你。点了关掉" : "让前台盯着各项目，有要紧的主动告诉你"}
      onClick={() => {
        const next = !on
        setOn(next)
        api("/api/v1/patrol", { method: "POST", body: JSON.stringify({ as: "human", action: next ? "on" : "off" }) })
          .then(() => toast.success(next ? "前台会主动提醒你了" : "前台不再主动提醒"))
          .catch((error: Error) => {
            setOn(!next)
            toast.error(error.message)
          })
      }}
    >
      <ShieldAlert className="size-3.5" />
      <span className="hidden sm:inline">{on ? "提醒开着" : "主动提醒"}</span>
    </button>
  )
}

// The front room's empty state: what to ask it now, and what it can't do yet.
export function FrontWelcome({
  seat,
  onExample,
  onStaff,
}: {
  seat: string | null
  onExample: (text: string) => void
  onStaff?: () => void
}) {
  const examples = ["各项目现在做到哪了？", "有什么在等我处理？", "哪些席位停着还欠着活？"]
  return (
    <div className="frost mb-6 rounded-2xl px-5 py-6">
      <h2 className="flex items-center gap-2 text-base font-semibold">
        <ConciergeBell className="size-4 text-primary" />
        前台
      </h2>
      <p className="mt-1.5 text-sm leading-6 text-muted-foreground">
        {seat ? `${seat} 在这里值班，` : "先接一个 AI 进来值班，"}
        替你看所有项目：各项目做到哪了、谁停着、有什么在等你。
      </p>
      <p className="mt-1 text-xs leading-5 text-muted-foreground/80">
        能替你起草转达、整理验收清单；开着右上角「自动收下」时，查过没问题的会直接收下。别的房间照常，卡片上有「去看」直达。
      </p>
      {seat ? (
        <div className="mt-4 flex flex-wrap gap-2">
          {examples.map((example) => (
            <button
              key={example}
              type="button"
              className="pill chip rounded-full px-3 py-1.5 text-left text-xs"
              onClick={() => onExample(example)}
            >
              {example}
            </button>
          ))}
        </div>
      ) : onStaff ? (
        <Button type="button" size="sm" className="mt-4 rounded-full" onClick={onStaff}>
          <ConciergeBell />
          挑一个 AI 来值班
        </Button>
      ) : null}
    </div>
  )
}
