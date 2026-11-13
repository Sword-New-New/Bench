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
  Loader2,
  MessageCircle,
  Pause,
  PencilLine,
  Play,
  Plug,
  Plus,
  Shrink,
  Square,
  SquareTerminal,
  X,
} from "lucide-react"
import { toast } from "sonner"

import { api } from "@/components/room/api"
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
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Avatar, Lamp } from "@/components/room/bits"
import { seatFlight } from "@/components/room/project-rail"
import { CONTEXT_WARN, ContextHair, contextFacts, useContexts } from "@/components/room/context"
import { QuotaLines, QuotaRing, useQuotas } from "@/components/room/quota"
import { Reveal } from "@/components/room/reveal"
import { BetaTag, openTerminalFor } from "@/components/room/terminal-dialog"
import { SpeedLine, useSpeeds } from "@/components/room/speed-line"
import type { AdapterInfo } from "@/components/room/api"
import { KINDS, kindOf, type Kind } from "@/lib/kinds"
import { ago, STATUS_LABEL } from "@/lib/status"
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
  now: number
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

function reach(kind: Kind, seats: PublicAgent[], adapters: AdapterInfo[] | null) {
  const adapter = adapters?.find((item) => item.name === kind.id)
  const online = seats.filter((agent) => agent.status !== "offline").length
  if (adapters && !adapter) return { text: "没配唤起命令", tone: "warn" as const }
  if (adapter && !adapter.installed) return { text: "本机没装", tone: "warn" as const }
  if (seats.length === 0) return { text: "还没接入", tone: "muted" as const }
  const standby = seats.filter((agent) => agent.standby && agent.status !== "offline").length
  if (standby > 0) return { text: `${standby} 个待命`, tone: "ok" as const }
  if (online > 0) return { text: `${online} 个在线`, tone: "ok" as const }
  if (seats.some((agent) => agent.callable)) return { text: "离线 · 点名会唤起", tone: "ok" as const }
  return { text: "离线 · 没报会话", tone: "warn" as const }
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
  const others = agents.filter((agent) => kindOf(agent) === null)
  // The five core kinds always get a row; any other kind once it has a seat.
  const seated = new Set(agents.map((agent) => kindOf(agent)?.id))
  const shown = KINDS.filter((kind) => kind.core || seated.has(kind.id))
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
  // An empty room lists every client in full, as the way in; otherwise the
  // ones without a seat fold into a small line each, after the others.
  const empty = agents.length === 0
  const withSeats = shown.filter((kind) => seatsOf(kind).length > 0)
  const without = shown.filter((kind) => seatsOf(kind).length === 0)
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
        contexts={contexts}
      />
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="tier-head flex items-center justify-between gap-1 px-4 pt-4 pb-2">
        <div className="min-w-0 flex-1">
          {props.head ?? <h2 className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">入口</h2>}
        </div>
        {withSeats.length > 0 ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            title={allOpen ? "全部收起" : "全部展开"}
            aria-label={allOpen ? "全部收起" : "全部展开"}
            onClick={() =>
              save(allOpen ? open.filter((id) => !withSeats.some((kind) => kind.id === id)) : [...new Set([...open, ...withSeats.map((kind) => kind.id)])])
            }
          >
            {allOpen ? <ChevronsDownUp /> : <ChevronsUpDown />}
          </Button>
        ) : null}
        <Button type="button" variant="ghost" size="xs" onClick={() => props.onJoin()}>
          <Plus />
          接入
        </Button>
      </div>
      {/* tier-rows: these fade in one after another when the room opens (globals.css). */}
      <div className="tier-rows min-h-0 flex-1 space-y-1 overflow-y-auto px-2 pb-3">
        {empty ? (
          shown.map((kind) => group(kind, false))
        ) : (
          <>
            {withSeats.map((kind) => group(kind, true))}
            {without.length > 0 ? (
              <div className="pt-1">
                {without.map((kind) => (
                  <KindStub
                    key={kind.id}
                    kind={kind}
                    state={reach(kind, [], adapters)}
                    open={open.includes(kind.id)}
                    onToggle={() => toggle(kind.id)}
                    onJoin={props.onJoin}
                    onSpawn={props.onSpawn}
                  />
                ))}
              </div>
            ) : null}
          </>
        )}

        {others.length > 0 ? (
          <section className="pt-3">
            <h3 className="px-2 pb-1 text-xs font-medium text-muted-foreground">其他席位</h3>
            {others.map((agent) => (
              <SeatRow key={agent.id} agent={agent} {...props} contexts={contexts} />
            ))}
          </section>
        ) : null}
      </div>
    </div>
  )
}

// A client nobody here uses yet: one small line. A click unfolds the two ways
// in: the room starts a session of it, or one already open joins.
function KindStub({
  kind,
  state,
  open,
  onToggle,
  onJoin,
  onSpawn,
}: {
  kind: Kind
  state: ReturnType<typeof reach>
  open: boolean
  onToggle: () => void
  onJoin: (kind?: string) => void
  onSpawn: (kind: string, from: PublicAgent | null) => void
}) {
  return (
    <div>
      <button
        type="button"
        className="group/stub flex w-full items-center gap-3 rounded-xl px-3 py-1 text-left transition-colors hover:bg-sidebar-accent/70"
        title={`把 ${kind.label} 接进来`}
        aria-expanded={open}
        onClick={onToggle}
      >
        <span className="grid w-9 shrink-0 place-items-center opacity-60 grayscale-[.4] group-hover/stub:opacity-100 group-hover/stub:grayscale-0">
          <Avatar name={kind.label} color={kind.color} kind={kind} size="sm" />
        </span>
        <span className="truncate text-[13px] text-muted-foreground group-hover/stub:text-foreground">{kind.label}</span>
        <span className={`shrink-0 text-[11px] ${state.tone === "warn" ? WARN : "text-muted-foreground/70"}`}>{state.text}</span>
        <ChevronRight className={`ml-auto size-3.5 shrink-0 text-muted-foreground transition-transform duration-200 ${open ? "rotate-90" : ""}`} />
      </button>
      <Reveal open={open}>
        <div className="flex flex-wrap gap-1 pt-0.5 pr-2 pb-1 pl-14">
          {kind.spawn ? (
            <button
              type="button"
              className="-ml-1.5 flex items-center gap-1.5 rounded-lg px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-sidebar-accent/70 hover:text-foreground"
              title={`让房间在后台开一个新的 ${kind.label} 会话并入座`}
              onClick={() => onSpawn(kind.id, null)}
            >
              <Plus className="size-3.5" />
              开新会话
            </button>
          ) : null}
          <button
            type="button"
            className="-ml-1.5 flex items-center gap-1.5 rounded-lg px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-sidebar-accent/70 hover:text-foreground"
            title={`把已经开着的 ${kind.label} 会话接进来`}
            onClick={() => onJoin(kind.id)}
          >
            <Plug className="size-3.5" />
            接入已有会话…
          </button>
        </div>
      </Reveal>
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
}: Props & {
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
          title={primary ? `@${primary.name}` : `把 ${kind.label} 接进来`}
        >
          <Avatar name={kind.label} color={kind.color} kind={kind} size="lg" status={best} hover={hover} />
          <span className="truncate text-sm font-semibold hover:underline">{kind.label}</span>
          {/* Only when something is wrong (or, in an empty room, that it isn't here yet). */}
          {state.tone !== "ok" ? (
            <span className={`min-w-0 shrink truncate text-[11px] ${state.tone === "warn" ? WARN : "text-muted-foreground"}`}>
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
              title={open ? "收起" : "展开：客户端、额度、速度、开新会话"}
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
              title={`让房间在后台开一个新的 ${kind.label} 会话并入座`}
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

function SeatRow({ agent, ...props }: Props & { agent: PublicAgent }) {
  const focused = props.focusId === agent.id
  const context = props.contexts?.[agent.id]
  const facts = context ? contextFacts(context, props.now) : null
  // Same rule as the menu's 「压缩上下文」.
  const compactable = Boolean(context && agent.callable && !agent.demo && !agent.runId && !agent.standby)
  const busy = Boolean(agent.runId) || agent.status === "working" || agent.status === "blocked"
  // What used to be lines under the name, now on hover.
  const tip = [
    `@${agent.name}`,
    `${agent.model} · ${agent.role}`,
    agent.hasProfile ? "已设席位档案/长期记忆" : "",
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
      toast.success(on ? `${agent.name} 以后被叫醒都有全部权限` : `${agent.name} 以后要权限会再问你`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "没改成")
    }
  }

  const togglePause = async (pause: boolean) => {
    try {
      await api(`/api/v1/agents/${agent.id}`, {
        method: "POST",
        body: JSON.stringify({ as: "human", action: pause ? "queue_pause" : "queue_resume" }),
      })
      toast.success(pause ? `已暂停唤起 ${agent.name}，新消息会先排着` : `已恢复唤起 ${agent.name}`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "操作没成功")
    }
  }

  const dropQueued = async (messageId?: string) => {
    try {
      await api(`/api/v1/agents/${agent.id}`, {
        method: "POST",
        body: JSON.stringify({ as: "human", action: "queue_drop", messageId }),
      })
      toast.success(messageId ? "已从队列剔除这条消息" : `已清空 ${agent.name} 的排队消息`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "没能剔除")
    }
  }

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
          <span className="truncate text-[13px] font-medium">{agent.name}</span>
          {agent.demo ? <span className="shrink-0 text-[10px] text-muted-foreground">演示</span> : null}
          {agent.standby && agent.status !== "offline" ? (
            <span
              className="shrink-0 rounded-full bg-emerald-500/12 px-1.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-300"
              title="正挂在 bench_wait 里，点它会立刻收到"
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
          <DropdownMenuContent align="end" className="w-auto min-w-44">
            <DropdownMenuItem onClick={() => props.onMention(agent.name)}>
              <AtSign />
              点名 {agent.name}
            </DropdownMenuItem>
            {agent.callable && !agent.demo ? (
              <DropdownMenuItem onClick={() => props.onWhisper(agent)}>
                <MessageCircle />
                单独说…
              </DropdownMenuItem>
            ) : null}
            {kindOf(agent)?.spawn && !agent.demo ? (
              <DropdownMenuItem onClick={() => props.onSpawn(kindOf(agent)!.id, agent)}>
                <Plus />
                在同目录开新会话…
              </DropdownMenuItem>
            ) : null}
            {agent.runId ? (
              <DropdownMenuItem onClick={() => props.onStop(agent)}>
                <Square />
                停下这次唤起
              </DropdownMenuItem>
            ) : null}
            {compactable ? (
              <DropdownMenuItem onClick={() => props.onCompact(agent)}>
                <Shrink />
                压缩上下文
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
            {agent.demo ? null : (
              <>
                <DropdownMenuItem onClick={() => openSeatProfileFor(agent.id, { tab: "profile" })}>
                  <BookOpen />
                  席位档案与记忆…
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => openSeatProfileFor(agent.id, { tab: "rebind" })}>
                  <ArrowRightLeft />
                  切换客户端 / 顶替…
                </DropdownMenuItem>
                {agent.callable ? (
                  <DropdownMenuItem onClick={() => void togglePause(!agent.queuePaused)}>
                    {agent.queuePaused ? <Play /> : <Pause />}
                    {agent.queuePaused ? "恢复自动唤起" : "暂停自动唤起"}
                  </DropdownMenuItem>
                ) : null}
                {/* Only Claude Code's permission prompts come to the page (lib/permits.ts). */}
                {agent.agentName === "claude" ? (
                  <DropdownMenuCheckboxItem
                    checked={Boolean(agent.autoFull)}
                    onCheckedChange={(on) => void toggleAutoFull(on)}
                    title="勾上后它每次被叫醒都直接有全部权限，不再一条条问你"
                  >
                    默认开启全部权限
                  </DropdownMenuCheckboxItem>
                ) : null}
              </>
            )}
            <DropdownMenuItem onClick={() => props.onFocus(focused ? null : agent.id)}>
              {focused ? "看全部对话" : "只看和他有关的"}
            </DropdownMenuItem>
            {agent.hasSession && !agent.demo && (agent.agentName === "claude" || agent.agentName === "codex") ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                  <DropdownMenuLabel>高级</DropdownMenuLabel>
                  <DropdownMenuItem
                    title="把它自己的界面开在网页里，你能看着它做、直接打字接管"
                    onClick={() => openTerminalFor(agent.id, agent.name)}
                  >
                    <SquareTerminal />
                    <span className="whitespace-nowrap">{agent.terminal ? "看终端" : "在终端里打开…"}</span>
                    <BetaTag />
                  </DropdownMenuItem>
                </DropdownMenuGroup>
              </>
            ) : null}
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={() => props.onLeave(agent)}>
              请离席
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Near compacting: the numbers, and 「压缩」 when it can be done now. */}
      {facts && facts.near >= CONTEXT_WARN ? (
        <div className={`flex items-center gap-2 pl-4 text-[11px] leading-5 ${WARN}`}>
          <span className="min-w-0 truncate tabular-nums" title={facts.title}>
            上下文 {facts.amount}
          </span>
          {compactable ? (
            <button
              type="button"
              className="ml-auto shrink-0 rounded-full bg-amber-500/15 px-1.5 text-[10px] font-medium leading-4 hover:bg-amber-500/25"
              title="让它压缩自己的上下文"
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
          title="它的会话开在房间的终端里，点名会打进那里。点开看"
          onClick={() => openTerminalFor(agent.id, agent.name)}
        >
          <SquareTerminal className="size-3 shrink-0" />
          终端开着
          <BetaTag />
        </button>
      ) : null}

      {/* Tier 2: controllable wake queue bar — shown only when paused or holding queued mentions. */}
      {showQueueBar ? (
        <div className="flex items-center gap-1 pl-4 text-[11px] leading-5 text-amber-700 dark:text-amber-300">
          { queuedCount > 0 ? (
            <DropdownMenu>
              <DropdownMenuTrigger className="truncate text-left hover:underline" title="点开查看或单条剔除排队中的消息">
                {agent.queuePaused ? `已暂停 · 排队 ${queuedCount} 条` : `排队 ${queuedCount} 条`}
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-64">
                <DropdownMenuLabel>等待唤起的消息（点 × 单独剔除）</DropdownMenuLabel>
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
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onClick={() => void dropQueued("*")}>
                  清空全部排队
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <span className="truncate">已暂停自动唤起</span>
          )}
          <button
            type="button"
            className="ml-auto grid size-5 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            title={agent.queuePaused ? "恢复自动唤起" : "暂停后续唤起"}
            aria-label={agent.queuePaused ? `恢复 ${agent.name} 唤起` : `暂停 ${agent.name} 唤起`}
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
              title="看它这次在做什么"
              onClick={() => agent.runId && props.onOpenRun(agent.runId)}
            >
              <Loader2 className="size-3 shrink-0 animate-spin" />
              <span className="truncate">{agent.doing || "正在回复"}</span>
            </button>
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
                title="插话：单独对它说一句，先停下手上的事回你，回完接着做"
                aria-label={`和 ${agent.name} 插话`}
                onClick={() => props.onWhisper(agent)}
              >
                <MessageCircle className="size-3" />
              </button>
              <button
                type="button"
                className="grid size-5 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                title="停止：停掉这次唤起，排在后面的也一起取消"
                aria-label={`停下 ${agent.name}`}
                onClick={() => props.onStop(agent)}
              >
                <Square className="size-2.5 fill-current" />
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
