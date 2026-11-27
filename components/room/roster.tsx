import { useState, ViewTransition } from "react"
import {
  ArrowRightLeft,
  AtSign,
  BookOpen,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Cpu,
  Ellipsis,
  Hourglass,
  Loader2,
  MessageCircle,
  Pause,
  PencilLine,
  Play,
  Plug,
  Plus,
  RotateCw,
  Shrink,
  SlidersHorizontal,
  Square,
  SquareTerminal,
  X,
} from "lucide-react"
import { toast } from "sonner"

import { api } from "@/components/room/api"
import { nudgeSeat } from "@/components/room/nudge"
import { openSeatProfileFor } from "@/components/room/seat-profile-dialog"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Avatar, Lamp, useTick } from "@/components/room/bits"
import { seatFlight } from "@/components/room/project-rail"
import { goto } from "@/components/room/refs"
import { CONTEXT_WARN, ContextHair, contextFacts, useContexts } from "@/components/room/context"
import { QuotaLines, QuotaRing, useQuotas } from "@/components/room/quota"
import { Reveal } from "@/components/room/reveal"
import { BetaTag, openTerminalFor } from "@/components/room/terminal-dialog"
import { SpeedLine, useSpeeds } from "@/components/room/speed-line"
import type { AdapterInfo } from "@/components/room/api"
import { asksOnPage, KINDS, kindOf, type Kind } from "@/lib/kinds"
import { ago, PARKED_MS, STATUS_LABEL } from "@/lib/status"
import type { SeatContext } from "@/lib/context"
import type { Quota } from "@/lib/quota"
import type { Speed } from "@/lib/speed"
import type { PublicAgent } from "@/lib/types"

// The left column keeps to one line per client and one per seat. Whatever
// else there is sits in three tiers (MAINTENANCE.md): always there (name,
// lamp, allowance ring, context hair), there only when something is up (an
// allowance at 80%, a context near compacting, a seat at work, an open
// terminal), and there only when asked for (a client unfolded, a hover card).

type Props = {
  agents: PublicAgent[]
  adapters: AdapterInfo[] | null
  focusId: string | null
  busy: boolean
  onMention: (name: string) => void
  onFocus: (id: string | null) => void
  onLeave: (agent: PublicAgent) => void
  onRename: (agent: PublicAgent) => void
  onModel: (agent: PublicAgent) => void
  onOpenRun: (runId: string) => void
  onStop: (agent: PublicAgent) => void
  // Have the room compact this seat's context (lib/summon.ts requestCompact).
  onCompact: (agent: PublicAgent) => void
  // How full each seat's context is, by seat id (filled in by Roster).
  contexts?: Record<string, SeatContext>
  // Say something to this seat alone, outside the room.
  onWhisper: (agent: PublicAgent) => void
  // Open 「开新会话」 for a kind, starting from this seat's folder if given.
  onSpawn: (kind: string, from: PublicAgent | null) => void
  // kind: open the join dialog with that agent already picked.
  onJoin: (kind?: string) => void
  // The top line's left end (left-pane.tsx: 「← 项目」 and the project's name).
  head?: React.ReactNode
}

type RosterRowProps = Props & { now: number }

function reach(kind: Kind, seats: PublicAgent[], adapters: AdapterInfo[] | null) {
  const adapter = adapters?.find((item) => item.name === kind.id)
  const online = seats.filter((agent) => agent.status !== "offline").length
  if (adapters && !adapter) return { text: "缺唤起命令", tone: "warn" as const }
  if (adapter && !adapter.installed) return { text: "未安装", tone: "warn" as const }
  if (seats.length === 0) return { text: "未接入", tone: "muted" as const }
  const standby = seats.filter((agent) => agent.standby && agent.status !== "offline").length
  if (standby > 0) return { text: `${standby} 个待命`, tone: "ok" as const }
  if (online > 0) return { text: `${online} 个在线`, tone: "ok" as const }
  if (seats.some((agent) => agent.callable)) return { text: "离线 · 点名可叫醒", tone: "ok" as const }
  return { text: "离线 · 未报会话", tone: "warn" as const }
}

const WARN = "text-amber-700 dark:text-amber-400"

// Which clients are unfolded, kept per browser.
const OPEN_KEY = "bench-roster-open"

function readOpen(): string[] {
  try {
    const value = typeof window === "undefined" ? null : JSON.parse(localStorage.getItem(OPEN_KEY) ?? "[]")
    return Array.isArray(value) ? value.filter((item) => typeof item === "string") : []
  } catch {
    return []
  }
}

export function Roster(props: Props) {
  const { agents, adapters } = props
  const now = useTick(10_000)
  const others = agents.filter((agent) => kindOf(agent) === null)
  const quotas = useQuotas()
  const speeds = useSpeeds()
  // Read again whenever a seat starts or ends a wake.
  const contexts = useContexts(agents.map((agent) => agent.runId ?? "").join(","))
  const [open, setOpen] = useState<string[]>(readOpen)
  const save = (next: string[]) => {
    setOpen(next)
    try {
      localStorage.setItem(OPEN_KEY, JSON.stringify(next))
    } catch {}
  }
  const toggle = (id: string) => save(open.includes(id) ? open.filter((item) => item !== id) : [...open, id])

  const seatsOf = (kind: Kind) => agents.filter((agent) => kindOf(agent)?.id === kind.id)
  const empty = agents.length === 0
  const withSeats = KINDS.filter((kind) => seatsOf(kind).length > 0)
  const allOpen = withSeats.length > 0 && withSeats.every((kind) => open.includes(kind.id))

  const group = (kind: Kind, folding: boolean) => {
    const seats = seatsOf(kind)
    return (
      <KindGroup
        key={kind.id}
        kind={kind}
        seats={seats}
        state={reach(kind, seats, adapters)}
        quota={quotas.find((item) => item.kind === kind.id)}
        speed={speeds.find((item) => item.kind === kind.id)}
        open={folding ? open.includes(kind.id) : true}
        onToggle={folding ? () => toggle(kind.id) : null}
        {...props}
        now={now}
        contexts={contexts}
      />
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="tier-head group/head flex items-center justify-between gap-1 px-4 pt-4 pb-2">
        <div className="min-w-0 flex-1">
          {props.head ?? <h2 className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">入口</h2>}
        </div>
        {/* Out of the row until the pointer or the keyboard is on it: the row
            is the way back, the project's name and 「接入」 (AverageJoe
            2026-11-16: too crowded). Always there where nothing hovers. */}
        {withSeats.length > 0 ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="hidden group-focus-within/head:inline-flex group-hover/head:inline-flex [@media(hover:none)]:inline-flex"
            title={allOpen ? "全部收起" : "全部展开"}
            aria-label={allOpen ? "全部收起" : "全部展开"}
            onClick={() =>
              save(allOpen ? open.filter((id) => !withSeats.some((kind) => kind.id === id)) : [...new Set([...open, ...withSeats.map((kind) => kind.id)])])
            }
          >
            {allOpen ? <ChevronsDownUp /> : <ChevronsUpDown />}
          </Button>
        ) : null}
        <Button type="button" variant="ghost" size="xs" onClick={() => props.onSpawn("", null)}>
          <Plus />
          添加 AI
        </Button>
      </div>
      {/* tier-rows: these fade in one after another when the room opens (globals.css). */}
      <div className="tier-rows min-h-0 flex-1 space-y-1 overflow-y-auto px-2 pb-3">
        {empty ? (
          <div className="flex flex-col items-center justify-center gap-3 px-4 py-12 text-center">
            <p className="text-sm text-muted-foreground">还没有 AI 入座</p>
            <Button type="button" size="sm" onClick={() => props.onSpawn("", null)}>
              <Plus />
              添加 AI
            </Button>
            <button
              type="button"
              className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
              onClick={() => props.onJoin()}
            >
              <Plug className="size-3" />
              接入已有会话
            </button>
          </div>
        ) : (
          withSeats.map((kind) => group(kind, true))
        )}

        {others.length > 0 ? (
          <section className="pt-3">
            <h3 className="px-2 pb-1 text-xs font-medium text-muted-foreground">其他席位</h3>
            {others.map((agent) => (
              <SeatRow key={agent.id} agent={agent} {...props} now={now} contexts={contexts} />
            ))}
          </section>
        ) : null}
      </div>
    </div>
  )
}

function KindGroup({
  kind,
  seats,
  state,
  quota,
  speed,
  open,
  onToggle,
  ...props
}: RosterRowProps & {
  kind: Kind
  seats: PublicAgent[]
  state: ReturnType<typeof reach>
  quota: Quota | undefined
  speed: Speed | undefined
  open: boolean
  // null: always unfolded (the empty room), no arrow.
  onToggle: (() => void) | null
}) {
  const [hover, setHover] = useState(false)
  const primary = seats.find((agent) => agent.status !== "offline") ?? seats.find((agent) => agent.callable) ?? seats[0]
  // A seat that can be woken is only resting, so its character stays awake and
  // watches the pointer; it sleeps only when nothing would wake it.
  const best =
    seats.find((agent) => agent.status === "working")?.status ??
    (primary?.status === "offline" && primary.callable ? "idle" : primary?.status)
  const toggle = onToggle ?? (() => {})

  return (
    <section className="p-1" onPointerEnter={() => setHover(true)} onPointerLeave={() => setHover(false)}>
      <div className="flex items-center gap-1 rounded-xl px-2 py-1.5">
        {/* Avatar and name: @ this client's seat, as before. */}
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-3 rounded-lg text-left"
          onClick={() => (primary ? props.onMention(primary.name) : props.onJoin(kind.id))}
          title={primary ? `@${primary.name}` : `接入 ${kind.label}`}
        >
          <Avatar name={kind.label} color={kind.color} kind={kind} size="lg" status={best} hover={hover} />
          <span className="truncate text-sm font-semibold hover:underline">{kind.label}</span>
          {/* Only when something is wrong (or, in an empty room, that it isn't here yet). */}
          {state.tone !== "ok" ? (
            <span className={`min-w-0 shrink truncate text-[0.6875rem] ${state.tone === "warn" ? WARN : "text-muted-foreground"}`}>
              {state.text}
            </span>
          ) : null}
        </button>
        {onToggle ? (
          <>
            <QuotaRing
              quota={quota}
              now={props.now}
              heading={`${kind.label} · ${kind.harness}`}
              card={<SpeedLine speed={speed} color={kind.color} now={props.now} />}
              expanded={open}
              onClick={toggle}
            />
            <button
              type="button"
              className="grid size-6 shrink-0 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground"
              aria-expanded={open}
              aria-label={open ? `收起 ${kind.label}` : `展开 ${kind.label}`}
              title={open ? "收起" : "看额度、速度或开新会话"}
              onClick={toggle}
            >
              <ChevronRight className={`size-4 transition-transform duration-200 ${open ? "rotate-90" : ""}`} />
            </button>
          </>
        ) : null}
      </div>
      <Reveal open={open}>
        <div className="pr-2 pb-1 pl-14">
          {/* Each session picks its own model, so the entry names only the client;
              the seats below say which model each one runs. */}
          <span className="block truncate text-xs text-muted-foreground">
            {kind.harness}
            {seats.length > 0 ? ` · ${seats.length} 个会话` : ""}
          </span>
          <QuotaLines quota={quota} now={props.now} />
          <SpeedLine speed={speed} color={kind.color} now={props.now} />
          {kind.spawn ? (
            <button
              type="button"
              className="-ml-1.5 mt-1 flex items-center gap-1.5 rounded-lg px-1.5 py-0.5 text-left text-xs text-muted-foreground transition-colors hover:bg-sidebar-accent/70 hover:text-foreground"
              title="后台新建会话并入座"
              onClick={() => props.onSpawn(kind.id, null)}
            >
              <Plus className="size-3.5" />
              开新会话
            </button>
          ) : null}
        </div>
      </Reveal>
      {seats.length > 0 ? (
        <div className="mt-0.5 ml-[1.35rem] border-l pl-2">
          {seats.map((agent) => (
            <SeatRow key={agent.id} agent={agent} {...props} />
          ))}
        </div>
      ) : null}
    </section>
  )
}

function SeatRow({ agent, ...props }: RosterRowProps & { agent: PublicAgent }) {
  const focused = props.focusId === agent.id
  const context = props.contexts?.[agent.id]
  const facts = context ? contextFacts(context, props.now) : null
  // Same rule as the menu's 「压缩上下文」.
  const compactable = Boolean(context && agent.callable && !agent.demo && !agent.runId && !agent.standby)
  const busy = Boolean(agent.runId) || agent.status === "working" || agent.status === "blocked"
  // It said it was working, long ago, and nothing since: the room can't tell.
  const unsure = agent.unsure !== undefined && !agent.runId
  // Quiet for a while with work still on it (lib/owes.ts), or already auto-woken by the room.
  const owes =
    agent.owes && props.now > 0 && (Boolean(agent.owes.woken) || props.now - agent.owes.since >= PARKED_MS)
      ? agent.owes
      : null
  const owed = owes ? owes.tasks.length + owes.calls.length : 0
  // What used to be lines under the name, now on hover.
  const tip = [
    `@${agent.name}`,
    `${agent.model} · ${agent.role}`,
    agent.hasProfile ? "已设档案/记忆" : "",
    agent.status === "offline" ? `最后在线 ${ago(agent.lastSeenAt, props.now)}` : STATUS_LABEL[agent.status],
    busy ? "" : agent.doing,
  ]
    .filter(Boolean)
    .join("\n")

  const toggleAutoFull = async (on: boolean) => {
    try {
      await api(`/api/v1/agents/${agent.id}`, {
        method: "POST",
        body: JSON.stringify({ as: "human", action: "auto_full", on }),
      })
      toast.success(on ? "以后叫醒默认给全权" : "以后要权限会问你")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "修改失败")
    }
  }

  const togglePause = async (pause: boolean) => {
    try {
      await api(`/api/v1/agents/${agent.id}`, {
        method: "POST",
        body: JSON.stringify({ as: "human", action: pause ? "queue_pause" : "queue_resume" }),
      })
      toast.success(pause ? "已暂停叫醒，新消息排队" : "已恢复叫醒")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "操作失败")
    }
  }

  const dropQueued = async (messageId?: string) => {
    try {
      await api(`/api/v1/agents/${agent.id}`, {
        method: "POST",
        body: JSON.stringify({ as: "human", action: "queue_drop", messageId }),
      })
      toast.success(messageId ? "已剔除排队消息" : "已清空排队消息")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "剔除失败")
    }
  }

  const nudge = () => nudgeSeat(agent)

  const queuedCount = agent.queuedCount ?? 0
  const showQueueBar = Boolean(agent.queuePaused || queuedCount > 0)
  return (
    <div className={`group rounded-xl px-2 py-1 transition-colors ${focused ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/70"}`}>
      <div className="flex items-center gap-2">
        {/* Shares its name with this seat on the project rail's bench: switching
            projects flies the seat between the two (components/room/project-rail.tsx). */}
        <ViewTransition name={seatFlight(agent.id)} share="bench-out" default="none">
          <span className="block">
            <Lamp status={agent.status} />
          </span>
        </ViewTransition>
        <button
          type="button"
          className="flex min-w-0 flex-1 items-baseline gap-1.5 text-left"
          title={tip}
          onClick={() => props.onMention(agent.name)}
        >
          <span className="truncate text-[0.8125rem] font-medium">{agent.name}</span>
          {agent.demo ? <span className="shrink-0 text-[0.625rem] text-muted-foreground">演示</span> : null}
          {agent.standby && agent.status !== "offline" ? (
            <span
              className="shrink-0 rounded-full bg-emerald-500/12 px-1.5 text-[0.625rem] font-medium text-emerald-700 dark:text-emerald-300"
              title="守候中，点名立刻收到"
            >
              待命
            </span>
          ) : null}
        </button>
        <ContextHair context={context} now={props.now} />
        <DropdownMenu>
          <DropdownMenuTrigger
            className="shrink-0 rounded-md p-0.5 text-muted-foreground opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 hover:bg-muted focus-visible:opacity-100 aria-expanded:opacity-100 [@media(hover:none)]:opacity-60"
            aria-label={`${agent.name} 的席位菜单`}
          >
            <Ellipsis className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-auto min-w-40">
            <DropdownMenuItem onClick={() => props.onMention(agent.name)}>
              <AtSign />
              点名
            </DropdownMenuItem>
            {agent.callable && !agent.demo ? (
              <DropdownMenuItem onClick={() => props.onWhisper(agent)}>
                <MessageCircle />
                单独说…
              </DropdownMenuItem>
            ) : null}
            {agent.runId ? (
              <DropdownMenuItem onClick={() => props.onStop(agent)}>
                <Square />
                停下这次
              </DropdownMenuItem>
            ) : agent.retry ? (
              <DropdownMenuItem onClick={() => props.onStop(agent)}>
                <Square />
                取消重试
              </DropdownMenuItem>
            ) : null}
            {agent.demo ? null : (
              <DropdownMenuItem onClick={() => props.onRename(agent)}>
                <PencilLine />
                改名…
              </DropdownMenuItem>
            )}
            {agent.callable && !agent.demo ? (
              <DropdownMenuItem onClick={() => props.onModel(agent)}>
                <Cpu />
                换模型…
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem onClick={() => props.onFocus(focused ? null : agent.id)}>
              {focused ? "看全部对话" : "只看它相关"}
            </DropdownMenuItem>
            {agent.demo ? null : (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                    <SlidersHorizontal />
                    高级
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="w-auto min-w-44">
                    {kindOf(agent)?.spawn ? (
                      <DropdownMenuItem title="在它所在目录开新会话" onClick={() => props.onSpawn(kindOf(agent)!.id, agent)}>
                        <Plus />
                        开新会话…
                      </DropdownMenuItem>
                    ) : null}
                    {compactable ? (
                      <DropdownMenuItem onClick={() => props.onCompact(agent)}>
                        <Shrink />
                        压缩上下文
                      </DropdownMenuItem>
                    ) : null}
                    {agent.callable ? (
                      <DropdownMenuItem onClick={() => void togglePause(!agent.queuePaused)}>
                        {agent.queuePaused ? <Play /> : <Pause />}
                        {agent.queuePaused ? "恢复叫醒" : "暂停叫醒"}
                      </DropdownMenuItem>
                    ) : null}
                    {/* Only Claude Code's and Codex's permission prompts come to the page (lib/kinds.ts PERMIT_KINDS). */}
                    {asksOnPage(agent.agentName) ? (
                      <DropdownMenuCheckboxItem
                        checked={Boolean(agent.autoFull)}
                        onCheckedChange={(on) => void toggleAutoFull(on)}
                        title="每次叫醒直接给全权，不再逐条确认"
                      >
                        默认给全权
                      </DropdownMenuCheckboxItem>
                    ) : null}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem title="编辑席位分工与长期记忆" onClick={() => openSeatProfileFor(agent.id, { tab: "profile" })}>
                      <BookOpen />
                      编辑档案…
                    </DropdownMenuItem>
                    <DropdownMenuItem title="切到别的客户端或顶替此席位" onClick={() => openSeatProfileFor(agent.id, { tab: "rebind" })}>
                      <ArrowRightLeft />
                      换客户端…
                    </DropdownMenuItem>
                    {agent.hasSession && (agent.agentName === "claude" || agent.agentName === "codex") ? (
                      <DropdownMenuItem
                        title="在网页终端打开，可直接打字接管"
                        onClick={() => openTerminalFor(agent.id, agent.name)}
                      >
                        <SquareTerminal />
                        <span className="whitespace-nowrap">{agent.terminal ? "看终端" : "打开终端…"}</span>
                        <BetaTag />
                      </DropdownMenuItem>
                    ) : null}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              </>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={() => props.onLeave(agent)}>
              移出
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Near compacting: the numbers, and 「压缩」 when it can be done now. */}
      {facts && facts.near >= CONTEXT_WARN ? (
        <div className={`flex items-center gap-2 pl-4 text-[0.6875rem] leading-5 ${WARN}`}>
          <span className="min-w-0 truncate tabular-nums" title={facts.title}>
            上下文 {facts.amount}
          </span>
          {compactable ? (
            <button
              type="button"
              className="ml-auto shrink-0 rounded-full bg-amber-500/15 px-1.5 text-[0.625rem] font-medium leading-4 hover:bg-amber-500/25"
              onClick={() => props.onCompact(agent)}
            >
              压缩
            </button>
          ) : null}
        </div>
      ) : null}

      {agent.terminal ? (
        <button
          type="button"
          className="flex items-center gap-1 pl-4 text-left text-xs leading-5 text-emerald-700 hover:underline dark:text-emerald-300"
          title="点名会发进终端，点开查看"
          onClick={() => openTerminalFor(agent.id, agent.name)}
        >
          <SquareTerminal className="size-3 shrink-0" />
          终端开着
          <BetaTag />
        </button>
      ) : null}

      {/* Tier 2: controllable wake queue bar — shown only when paused or holding queued mentions. */}
      {/* Tier 2: its wake failed on the network and goes again by itself (lib/netfail.ts). */}
      {agent.retry && !agent.runId ? (
        <div data-retry className="flex items-center gap-1 pl-4 text-[0.6875rem] leading-5 text-amber-700 dark:text-amber-300">
          <RotateCw className="size-3 shrink-0" />
          <span className="truncate" title="网络断了，到点自动重叫">
            网络断了 · {new Date(agent.retry.at).toLocaleTimeString("zh-CN", { hour12: false })} 再叫（{agent.retry.n}/{agent.retry.of}）
          </span>
          <button
            type="button"
            className="ml-auto grid size-5 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            title="取消重试"
            aria-label={`取消重试 ${agent.name}`}
            onClick={() => props.onStop(agent)}
          >
            <X className="size-3" />
          </button>
        </div>
      ) : null}

      {showQueueBar ? (
        <div className="flex items-center gap-1 pl-4 text-[0.6875rem] leading-5 text-amber-700 dark:text-amber-300">
          { queuedCount > 0 ? (
            <DropdownMenu>
              <DropdownMenuTrigger className="truncate text-left hover:underline" title="查看或剔除排队消息">
                {agent.queuePaused ? `已暂停 · 排队 ${queuedCount} 条` : `排队 ${queuedCount} 条`}
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-64">
                {/* A label only works inside a group: Base UI throws without one. */}
                <DropdownMenuGroup>
                  <DropdownMenuLabel>排队消息（点 × 剔除）</DropdownMenuLabel>
                  {(agent.queuedItems ?? []).map((item) => (
                    <DropdownMenuItem
                      key={item.id}
                      className="flex items-center justify-between gap-2 text-xs"
                      onClick={() => void dropQueued(item.id)}
                    >
                      <span className="min-w-0 flex-1 truncate">{item.line}</span>
                      <X className="size-3 shrink-0 text-muted-foreground" />
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onClick={() => void dropQueued("*")}>
                  清空排队
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <span className="truncate">已暂停叫醒</span>
          )}
          <button
            type="button"
            className="ml-auto grid size-5 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            title={agent.queuePaused ? "恢复叫醒" : "暂停叫醒"}
            aria-label={agent.queuePaused ? `恢复 ${agent.name} 叫醒` : `暂停 ${agent.name} 叫醒`}
            onClick={() => void togglePause(!agent.queuePaused)}
          >
            {agent.queuePaused ? <Play className="size-3" /> : <Pause className="size-3" />}
          </button>
        </div>
      ) : null}

      {/* At work or stuck: what it is doing; while woken, click to watch. */}
      {busy ? (
        <div className="flex items-center gap-1 pl-3">
          {agent.runId ? (
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-1 text-left text-xs leading-5 text-sky-700 hover:underline dark:text-sky-300"
              title="查看运行过程"
              onClick={() => agent.runId && props.onOpenRun(agent.runId)}
            >
              <Loader2 className="size-3 shrink-0 animate-spin" />
              <span className="truncate">{agent.doing || "正在回复"}</span>
            </button>
          ) : unsure ? (
            <span
              className="min-w-0 flex-1 truncate pl-1 text-xs leading-5 text-muted-foreground"
              title={`${ago(agent.unsure ?? 0, props.now)}说在做，之后无动静`}
            >
              可能停了 · {ago(agent.unsure ?? 0, props.now)}说在做
            </span>
          ) : (
            <span
              className={`min-w-0 flex-1 truncate pl-1 text-xs leading-5 ${agent.status === "blocked" ? WARN : "text-sky-700 dark:text-sky-300"}`}
              title={agent.doing || STATUS_LABEL[agent.status]}
            >
              {agent.doing || STATUS_LABEL[agent.status]}
            </span>
          )}
          {agent.runId ? (
            <>
              <button
                type="button"
                className="grid size-5 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                title="单独说：先停下回你，回完接着做"
                aria-label={`和 ${agent.name} 单独说`}
                onClick={() => props.onWhisper(agent)}
              >
                <MessageCircle className="size-3" />
              </button>
              <button
                type="button"
                className="grid size-5 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                title="停下这次，排队的也取消"
                aria-label={`停下 ${agent.name}`}
                onClick={() => props.onStop(agent)}
              >
                <Square className="size-2.5 fill-current" />
              </button>
            </>
          ) : null}
        </div>
      ) : null}

      {/* Tier 2: stopped with work still on it. Gone once it works, asks, or the work is done. */}
      {owes ? (
        <div data-owes className={`flex items-center gap-1 pl-4 text-[0.6875rem] leading-5 ${WARN}`}>
          <DropdownMenu>
            <DropdownMenuTrigger
              className="flex min-w-0 items-center gap-1 truncate text-left hover:underline"
              title={owes.woken ? `停着未完的事（房间已叫过 ${owes.woken.count} 次），点开查看` : "停着未完的事，点开查看"}
            >
              <Hourglass className="size-3 shrink-0" />
              <span className="truncate">{owes.woken ? "房间已叫它接着做" : `停着 · 还欠 ${owed} 件`}</span>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-72">
              <DropdownMenuGroup>
                <DropdownMenuLabel>
                  {agent.name} 停了 {ago(owes.since, props.now).replace("前", "")}，还欠 {owed} 件
                  {owes.woken ? ` · 房间已叫过 ${owes.woken.count} 次` : ""}
                </DropdownMenuLabel>
                {owes.tasks.map((task) => (
                  <DropdownMenuItem key={task.id} className="flex-col items-start gap-0 text-xs" onClick={() => goto("task", task.id)}>
                    <span className="w-full truncate">{task.title}</span>
                    <span className="w-full truncate text-[0.6875rem] text-muted-foreground">
                      待办 {task.id}
                      {task.step ? ` · 到「${task.step}」` : ""}
                    </span>
                  </DropdownMenuItem>
                ))}
                {owes.calls.map((call) => (
                  <DropdownMenuItem key={call.messageId} className="flex-col items-start gap-0 text-xs" onClick={() => goto("message", call.messageId)}>
                    <span className="w-full truncate">{call.from} 叫过它，{call.state === "cut" ? "中途断了" : "没叫成"}</span>
                    <span className="w-full truncate text-[0.6875rem] text-muted-foreground">消息 {call.messageId}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          {agent.callable ? (
            <button
              type="button"
              className="ml-auto shrink-0 rounded-full bg-amber-500/15 px-1.5 text-[0.625rem] font-medium leading-4 hover:bg-amber-500/25"
              title="发消息 @ 它接着做"
              onClick={() => void nudge()}
            >
              接着做
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
