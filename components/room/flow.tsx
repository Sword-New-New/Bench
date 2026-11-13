"use client"

import { useEffect, useRef, useState, type CSSProperties } from "react"
import { AlignCenter, AlignLeft, ChevronDown } from "lucide-react"

import { seatLook } from "@/components/room/bits"
import { Reveal } from "@/components/room/reveal"
import type { Flow, FlowNode } from "@/lib/flow"
import { clock } from "@/lib/status"
import type { FlowSummary, PublicAgent } from "@/lib/types"

// The 「流程」 view of the thread: each piece of work as a picture, one column
// per person or seat, one row per block, lines for what led to what. Read
// only; the picture comes from lib/flow.ts (flowsOf) and nothing here works
// out relations of its own. A click on a block goes back to the thread, to
// the message it came from.

// Where the user's column sits: in the middle (default) or first.
const HUMAN_KEY = "bench-flow-human"
type HumanAt = "center" | "left"

function readHumanAt(): HumanAt {
  try {
    return typeof window !== "undefined" && localStorage.getItem(HUMAN_KEY) === "left" ? "left" : "center"
  } catch {
    return "center"
  }
}

const KIND_LABEL: Record<FlowNode["kind"], string> = { say: "指令", call: "派活", task: "待办", ask: "提问", reply: "回答" }

// The lanes in drawing order. Centered: the user, then the seats in the order
// they joined in, taking turns to its right and left.
function arrange(lanes: Flow["lanes"], humanAt: HumanAt) {
  const human = lanes.find((lane) => lane.id === "human")
  if (!human || humanAt === "left") return human ? [human, ...lanes.filter((lane) => lane !== human)] : lanes
  const left: Flow["lanes"] = []
  const right: Flow["lanes"] = []
  lanes
    .filter((lane) => lane !== human)
    .forEach((lane, index) => (index % 2 === 0 ? right.push(lane) : left.unshift(lane)))
  return [...left, human, ...right]
}

type Look = { name: string; color: string }

function looksOf(agents: PublicAgent[]) {
  const looks = new Map<string, Look>()
  for (const agent of agents) looks.set(agent.id, { name: agent.name, color: seatLook(agent).color })
  return (lane: { id: string; name: string }): Look =>
    lane.id === "human" ? { name: "你", color: "var(--foreground)" } : (looks.get(lane.id) ?? { name: lane.name, color: "var(--muted-foreground)" })
}

export function FlowView({
  flows,
  agents,
  notes,
  onOpen,
}: {
  flows: Flow[]
  agents: PublicAgent[]
  // Each piece's short summary, written with the room summary (lib/flow-summary.ts).
  notes?: Record<string, FlowSummary>
  onOpen: (messageId: string) => void
}) {
  const look = looksOf(agents)
  const [humanAt, setHumanAt] = useState<HumanAt>(readHumanAt)
  // Which cards are open; until one is touched, only the newest.
  const [opened, setOpened] = useState<Set<string> | null>(null)
  const open = opened ?? new Set(flows[0] ? [flows[0].id] : [])
  const toggle = (id: string) => {
    const next = new Set(open)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setOpened(next)
  }
  const flipHuman = () => {
    const next = humanAt === "center" ? "left" : "center"
    setHumanAt(next)
    try {
      localStorage.setItem(HUMAN_KEY, next)
    } catch {}
  }
  const waiting = flows.reduce((sum, flow) => sum + flow.waiting, 0)

  return (
    // inline-size containment: a wide graph scrolls inside its card instead of
    // widening the thread's column (on narrow screens past the screen edge).
    <div className="min-h-0 flex-1 overflow-y-auto [contain:inline-size]">
      <div data-dock="padding-bottom 1rem" className="mx-auto flex max-w-6xl flex-col gap-3 px-4 pt-12 pb-[calc(var(--dock,8rem)+1rem)] md:px-6">
        {flows.length === 0 ? (
          <p className="mx-auto mt-16 max-w-sm text-center text-sm text-muted-foreground">
            还没有能画成流程的事。一句话引出了两个以上的席位，或者派出了待办，就会出现在这里。
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            {flows.length} 件事
            {waiting > 0 ? (
              <>
                {" · "}
                <span className="font-medium text-amber-700 dark:text-amber-300">一共等你 {waiting} 处</span>
              </>
            ) : (
              " · 没有等你的"
            )}
          </p>
        )}
        {flows.map((flow) => (
          <FlowCard
            key={flow.id}
            flow={flow}
            note={notes?.[flow.id]}
            open={open.has(flow.id)}
            onToggle={() => toggle(flow.id)}
            humanAt={humanAt}
            onFlipHuman={flipHuman}
            look={look}
            onOpen={onOpen}
          />
        ))}
      </div>
    </div>
  )
}

function FlowCard({
  flow,
  note,
  open,
  onToggle,
  humanAt,
  onFlipHuman,
  look,
  onOpen,
}: {
  flow: Flow
  note: FlowSummary | undefined
  open: boolean
  onToggle: () => void
  humanAt: HumanAt
  onFlipHuman: () => void
  look: (lane: { id: string; name: string }) => Look
  onOpen: (messageId: string) => void
}) {
  const hasHuman = flow.lanes.some((lane) => lane.id === "human")
  return (
    <section className="frost rounded-2xl ring-1 ring-foreground/10">
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          aria-expanded={open}
          onClick={onToggle}
          title={flow.title}
        >
          <ChevronDown className={`size-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none ${open ? "" : "-rotate-90"}`} />
          <span className="min-w-0 truncate text-sm font-medium">{note?.title ?? flow.title}</span>
          <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">{clock(flow.at)} 起</span>
          {flow.waiting > 0 ? (
            <span className="shrink-0 rounded-full bg-amber-500/15 px-1.5 text-[11px] font-medium text-amber-700 dark:text-amber-300">
              等你 {flow.waiting}
            </span>
          ) : null}
          <span className="ml-auto flex shrink-0 -space-x-1">
            {flow.lanes.slice(0, 8).map((lane) => {
              const { name, color } = look(lane)
              return (
                <span
                  key={lane.id}
                  className="grid size-4 place-items-center rounded-full text-[8px] font-semibold text-background ring-2 ring-background"
                  style={{ background: color }}
                  title={name}
                >
                  {name.slice(0, 1)}
                </span>
              )
            })}
          </span>
        </button>
        {open && hasHuman ? (
          <button
            type="button"
            className="pill flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
            title={humanAt === "center" ? "改成你那一列在最左" : "改成你那一列在中间"}
            onClick={onFlipHuman}
          >
            {humanAt === "center" ? <AlignCenter className="size-3" /> : <AlignLeft className="size-3" />}
            {humanAt === "center" ? "你在中间" : "你在最左"}
          </button>
        ) : null}
      </div>
      {note ? (
        // Two lines while folded, all of it open. Marked when the piece moved
        // after it was written; the next room summary brings it up to date.
        <p
          className={`-mt-1 px-3 pb-2 pl-9 text-xs leading-5 text-muted-foreground ${open ? "" : "line-clamp-2"}`}
          title={`${note.by} 写于 ${clock(note.at)}，随房间摘要一起写`}
        >
          {note.text}
          {flow.lastAt > note.upToAt ? <span className="ml-1.5 whitespace-nowrap text-[11px] text-muted-foreground/70">· 之后又有新动静</span> : null}
        </p>
      ) : null}
      <Reveal open={open}>{open ? <FlowGraph key={humanAt} flow={flow} names={note?.nodes} humanAt={humanAt} look={look} onOpen={onOpen} /> : null}</Reveal>
    </section>
  )
}

type Box = { x: number; y: number; w: number; h: number }

const LANE_MIN = 150
const TIME_COL = 44

function FlowGraph({
  flow,
  names,
  humanAt,
  look,
  onOpen,
}: {
  flow: Flow
  // Short names the summary writer gave the blocks (lib/flow-summary.ts).
  names?: Record<string, string>
  humanAt: HumanAt
  look: (lane: { id: string; name: string }) => Look
  onOpen: (messageId: string) => void
}) {
  const lanes = arrange(flow.lanes, humanAt)
  const column = new Map(lanes.map((lane, index) => [lane.id, index]))
  const grid = useRef<HTMLDivElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const blocks = useRef(new Map<string, HTMLElement>())
  const [boxes, setBoxes] = useState<{ size: { w: number; h: number }; at: Record<string, Box> } | null>(null)

  // Where each block landed, read whenever the grid changes size (it reports
  // its first size by itself); the lines are drawn from these.
  useEffect(() => {
    const node = grid.current
    if (!node) return
    const measure = () => {
      const at: Record<string, Box> = {}
      for (const [id, block] of blocks.current) at[id] = { x: block.offsetLeft, y: block.offsetTop, w: block.offsetWidth, h: block.offsetHeight }
      setBoxes({ size: { w: node.offsetWidth, h: node.offsetHeight }, at })
    }
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [flow])

  // Wider than the card: open with the user's column in the middle when it
  // sits in the middle. Once, when drawn (it is drawn anew when that changes),
  // so new messages don't undo a scroll of your own.
  useEffect(() => {
    if (humanAt !== "center") return
    const frame = requestAnimationFrame(() => {
      const box = scroller.current
      const human = grid.current?.querySelector<HTMLElement>("[data-lane-head=human]")
      if (box && human && box.scrollWidth > box.clientWidth) box.scrollLeft = human.offsetLeft + human.offsetWidth / 2 - box.clientWidth / 2
    })
    return () => cancelAnimationFrame(frame)
  }, [humanAt])

  const style: CSSProperties = {
    gridTemplateColumns: `${TIME_COL}px repeat(${lanes.length}, minmax(${LANE_MIN}px, 1fr))`,
    minWidth: TIME_COL + lanes.length * (LANE_MIN + 12),
  }

  return (
    <div ref={scroller} className="overflow-x-auto px-3 pb-3">
      <div ref={grid} className="relative grid gap-x-3 gap-y-6" style={style}>
        {/* Lines under the blocks. */}
        {boxes ? <Edges flow={flow} boxes={boxes} /> : null}
        <span style={{ gridRow: 1, gridColumn: 1 }} />
        {lanes.map((lane, index) => {
          const { name, color } = look(lane)
          return (
            <span key={lane.id} data-lane-head={lane.id} style={{ gridRow: 1, gridColumn: index + 2 }} className="flex min-w-0 items-center gap-1.5 border-b border-foreground/10 pb-1.5 text-xs text-muted-foreground">
              <span className="size-2 shrink-0 rounded-full" style={{ background: color }} />
              <span className="truncate">{name}</span>
            </span>
          )
        })}
        {flow.nodes.map((node, index) => {
          const minute = clock(node.at)
          // Not again when the block above is in the same minute.
          const showTime = index === 0 || minute !== clock(flow.nodes[index - 1].at)
          const row = index + 2
          return [
            <span key={`${node.id}:t`} className="pt-2 text-[10px] text-muted-foreground tabular-nums" style={{ gridRow: row, gridColumn: 1 }}>
              {showTime ? minute : ""}
            </span>,
            <Block
              key={node.id}
              node={node}
              name={names?.[node.id]}
              style={{ gridRow: row, gridColumn: (column.get(node.lane) ?? 0) + 2 }}
              attach={(element) => {
                if (element) blocks.current.set(node.id, element)
                else blocks.current.delete(node.id)
              }}
              onOpen={onOpen}
            />,
          ]
        })}
      </div>
    </div>
  )
}

const STATE_LOOK: Record<FlowNode["state"], { box: string; note: string }> = {
  you: {
    box: "border-amber-500/80 bg-[color-mix(in_oklab,var(--card)_86%,#f59e0b)]",
    note: "font-medium text-amber-700 dark:text-amber-300",
  },
  doing: { box: "border-foreground/15 bg-card", note: "text-muted-foreground" },
  wait: { box: "border-dashed border-foreground/30 bg-transparent", note: "text-muted-foreground" },
  stuck: { box: "border-red-500/80 bg-card", note: "text-red-600 dark:text-red-400" },
  done: { box: "border-foreground/10 bg-card", note: "text-muted-foreground" },
}

function Block({
  node,
  name,
  style,
  attach,
  onOpen,
}: {
  node: FlowNode
  name?: string
  style: CSSProperties
  attach: (element: HTMLElement | null) => void
  onOpen: (messageId: string) => void
}) {
  const look = STATE_LOOK[node.state]
  const kind = node.kind === "task" && node.taskId ? `${KIND_LABEL.task} ${node.taskId}` : node.state === "stuck" ? "卡住" : KIND_LABEL[node.kind]
  return (
    <button
      ref={attach}
      type="button"
      style={style}
      disabled={!node.messageId}
      className={`relative z-[1] self-start rounded-xl border px-2.5 py-1.5 text-left shadow-sm transition-[box-shadow,transform] hover:ring-2 hover:ring-foreground/15 active:scale-[.98] motion-reduce:transition-none motion-reduce:active:scale-100 ${look.box}`}
      title={node.messageId ? `${node.title}\n点一下回到群聊里的那条消息` : node.title}
      onClick={() => node.messageId && onOpen(node.messageId)}
    >
      <span className={`block ${node.state === "done" ? "opacity-55" : ""}`}>
        <span className="block truncate text-[10px] text-muted-foreground">{kind}</span>
        <span className="line-clamp-2 text-[12.5px] leading-[1.35] font-semibold">{name ?? node.title}</span>
        {node.note ? <span className={`mt-0.5 block truncate text-[11px] ${look.note}`}>{node.note}</span> : null}
      </span>
    </button>
  )
}

// call: solid, wait: dashed; both with an arrow. In one column a straight
// drop. Across columns the line leaves from the side facing the other column
// at the block's middle, runs across its own row (only this block is in it)
// and turns down into the top of the other block, so it never runs behind
// the block it starts from.
function Edges({ flow, boxes }: { flow: Flow; boxes: { size: { w: number; h: number }; at: Record<string, Box> } }) {
  const id = `flow-${flow.id}`
  const paths = flow.edges.flatMap((edge, index) => {
    const a = boxes.at[edge.from]
    const b = boxes.at[edge.to]
    if (!a || !b) return []
    const ax = a.x + a.w / 2
    const bx = b.x + b.w / 2
    const down = b.y >= a.y
    let d: string
    if (Math.abs(ax - bx) < 2) {
      d = down ? `M${ax},${a.y + a.h} L${bx},${b.y - 2}` : `M${ax},${a.y} L${bx},${b.y + b.h + 2}`
    } else {
      const right = bx > ax
      const sx = right ? a.x + a.w : a.x
      const sy = a.y + a.h / 2
      const ey = down ? b.y - 2 : b.y + b.h + 2
      d = `M${sx},${sy} C${bx},${sy} ${bx},${sy} ${bx},${ey}`
    }
    return [
      <path
        key={index}
        d={d}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.25}
        strokeDasharray={edge.kind === "wait" ? "5 4" : undefined}
        markerEnd={`url(#${id}-arrow)`}
      />,
    ]
  })
  return (
    <svg
      className="pointer-events-none absolute inset-0 z-0 text-muted-foreground/55"
      width={boxes.size.w}
      height={boxes.size.h}
      aria-hidden="true"
    >
      <defs>
        <marker id={`${id}-arrow`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,0 L8,4 L0,8 z" fill="currentColor" />
        </marker>
      </defs>
      {paths}
    </svg>
  )
}
