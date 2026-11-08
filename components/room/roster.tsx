import { useState } from "react"
import { AtSign, Ellipsis, Loader2, MessageCircle, Plus, Settings2, Square } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Avatar, Lamp } from "@/components/room/bits"
import type { AdapterInfo } from "@/components/room/api"
import { KINDS, kindOf, wakeModel, type Kind } from "@/lib/kinds"
import { ago, STATUS_LABEL } from "@/lib/status"
import type { PublicAgent } from "@/lib/types"

type Props = {
  agents: PublicAgent[]
  adapters: AdapterInfo[] | null
  now: number
  focusId: string | null
  demoSeated: boolean
  busy: boolean
  onMention: (name: string) => void
  onFocus: (id: string | null) => void
  onLeave: (agent: PublicAgent) => void
  onOpenRun: (runId: string) => void
  onStop: (agent: PublicAgent) => void
  // Say something to this seat alone, outside the room.
  onWhisper: (agent: PublicAgent) => void
  onConfigure: (name: string | null) => void
  // kind: open the join dialog with that agent already picked.
  onJoin: (kind?: string) => void
  onSeat: () => void
  onDismiss: () => void
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

const TONE = {
  ok: "text-emerald-700 dark:text-emerald-400",
  warn: "text-amber-700 dark:text-amber-400",
  muted: "text-muted-foreground",
}

export function Roster(props: Props) {
  const { agents, adapters, demoSeated, busy } = props
  const others = agents.filter((agent) => kindOf(agent) === null)
  // The five core kinds always get a row; any other kind once it has a seat.
  const seated = new Set(agents.map((agent) => kindOf(agent)?.id))
  const shown = KINDS.filter((kind) => kind.core || seated.has(kind.id))

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between px-4 pt-4 pb-2">
        <h2 className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">入口</h2>
        <Button type="button" variant="ghost" size="xs" onClick={() => props.onJoin()}>
          <Plus />
          接入
        </Button>
      </div>
      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2 pb-3">
        {shown.map((kind) => {
          const seats = agents.filter((agent) => kindOf(agent)?.id === kind.id)
          return <KindGroup key={kind.id} kind={kind} seats={seats} state={reach(kind, seats, adapters)} {...props} />
        })}

        {others.length > 0 ? (
          <section className="pt-3">
            <h3 className="px-2 pb-1 text-xs font-medium text-muted-foreground">其他席位</h3>
            {others.map((agent) => (
              <SeatRow key={agent.id} agent={agent} {...props} />
            ))}
          </section>
        ) : null}
      </div>
      <div className="flex gap-1 border-t px-2 py-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="flex-1 justify-start"
          disabled={busy}
          onClick={() => props.onConfigure(null)}
        >
          <Settings2 />
          唤起命令
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-muted-foreground"
          disabled={busy}
          onClick={demoSeated ? props.onDismiss : props.onSeat}
        >
          {demoSeated ? "撤下演示" : "演示席位"}
        </Button>
      </div>
    </div>
  )
}

function KindGroup({
  kind,
  seats,
  state,
  ...props
}: Props & { kind: Kind; seats: PublicAgent[]; state: ReturnType<typeof reach> }) {
  const [hover, setHover] = useState(false)
  // What a wake actually runs on, which can differ from what a seat reported.
  const adapter = props.adapters?.find((item) => item.name === kind.id)
  const model = adapter ? adapter.model : wakeModel(kind.command)
  const primary = seats.find((agent) => agent.status !== "offline") ?? seats.find((agent) => agent.callable) ?? seats[0]
  // A seat that can be woken is only resting, so its character stays awake and
  // watches the pointer; it sleeps only when nothing would wake it.
  const best =
    seats.find((agent) => agent.status === "working")?.status ??
    (primary?.status === "offline" && primary.callable ? "idle" : primary?.status)

  return (
    <section className="p-1">
      <button
        type="button"
        className="flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left transition-colors hover:bg-sidebar-accent/70"
        onPointerEnter={() => setHover(true)}
        onPointerLeave={() => setHover(false)}
        onClick={() => (primary ? props.onMention(primary.name) : props.onJoin(kind.id))}
        title={primary ? `@${primary.name}` : `把 ${kind.label} 接进来`}
      >
        <Avatar name={kind.label} color={kind.color} kind={kind} size="lg" status={best} hover={hover} />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline justify-between gap-2">
            <span className="truncate text-sm font-semibold">{kind.label}</span>
            <span className={`shrink-0 text-[11px] ${TONE[state.tone]}`}>{state.text}</span>
          </span>
          <span className="block truncate text-xs text-muted-foreground" title="被 @ 叫醒、写摘要时用的模型，在「唤起命令」里改">
            {kind.harness} · {model ?? "默认模型"}
          </span>
        </span>
      </button>
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
  return (
    <div
      className={`group flex items-start gap-2 rounded-xl px-2 py-1.5 transition-colors ${focused ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/70"}`}
    >
      <span className="pt-1.5">
        <Lamp status={agent.status} />
      </span>
      <div className="min-w-0 flex-1">
      <button type="button" className="block w-full text-left" onClick={() => props.onMention(agent.name)}>
        <span className="flex items-baseline gap-1.5">
          <span className="truncate text-[13px] font-medium">{agent.name}</span>
          {agent.demo ? <span className="shrink-0 text-[10px] text-muted-foreground">演示</span> : null}
          {agent.standby && agent.status !== "offline" ? (
            <span
              className="ml-auto shrink-0 rounded-full bg-emerald-500/12 px-1.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-300"
              title="正挂在 bench_wait 里，点它会立刻收到"
            >
              待命
            </span>
          ) : (
            <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
              {agent.status === "offline" ? ago(agent.lastSeenAt, props.now) : STATUS_LABEL[agent.status]}
            </span>
          )}
        </span>
        {agent.runId ? null : (
          <span className="block truncate text-xs text-muted-foreground">
            {agent.doing || `${agent.model} · ${agent.role}`}
          </span>
        )}
      </button>
      {agent.runId ? (
        <>
          {/* Woken right now: the line follows its current step; click to watch. */}
          <button
            type="button"
            className="flex w-full items-center gap-1 text-left text-xs text-sky-700 hover:underline dark:text-sky-300"
            title="看它这次在做什么"
            onClick={() => agent.runId && props.onOpenRun(agent.runId)}
          >
            <Loader2 className="size-3 shrink-0 animate-spin" />
            <span className="truncate">{agent.doing || "正在回复"}</span>
          </button>
          <span className="mt-1 flex gap-1">
            <button
              type="button"
              className="pill chip flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px]"
              title="单独对它说一句：先停下手上的事回你，回完接着做"
              onClick={() => props.onWhisper(agent)}
            >
              <MessageCircle className="size-3" />
              插话
            </button>
            <button
              type="button"
              className="pill chip flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
              title="停掉这次唤起，排在后面的也一起取消"
              onClick={() => props.onStop(agent)}
            >
              <Square className="size-2.5 fill-current" />
              停止
            </button>
          </span>
        </>
      ) : null}
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger
          className="mt-0.5 rounded-md p-0.5 text-muted-foreground opacity-60 group-hover:opacity-100 hover:bg-muted aria-expanded:opacity-100"
          aria-label={`${agent.name} 的席位菜单`}
        >
          <Ellipsis className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-44">
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
          {agent.runId ? (
            <DropdownMenuItem onClick={() => props.onStop(agent)}>
              <Square />
              停下这次唤起
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem onClick={() => props.onFocus(focused ? null : agent.id)}>
            {focused ? "看全部对话" : "只看和他有关的"}
          </DropdownMenuItem>
          {!agent.demo ? (
            <DropdownMenuItem onClick={() => props.onConfigure(agent.agentName || null)}>
              唤起命令…
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onClick={() => props.onLeave(agent)}>
            请离席
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
