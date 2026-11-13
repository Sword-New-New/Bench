import { flowText, type Flow, type FlowNode } from "@/lib/flow"
import type { FlowSummary, RoomSummary } from "@/lib/types"

// Short wording for the 「流程」 view, written along with the room summary:
// per piece of work a short name, a sentence or two on where it stands, and a
// short name for each block in its picture (blocks otherwise show the opening
// words of the message, which run long). Incremental: the writer is shown
// only the pieces that moved since theirs was written (at most MAX_ASK,
// newest first), with what was said last time, and asked to name only the
// blocks that have no name yet. It answers in a 「## 流程」 section after the
// summary proper, which the room splits off and keeps per piece. The room
// summary itself, and what seats are handed of it, never carry this section.

const HEAD = "## 流程"
// Named pieces that moved, asked about in one summary.
const MAX_ASK = 8
// Blocks asked to name, per piece and round.
const MAX_BLOCKS = 16
// Kept per room; the oldest written go first.
const MAX_KEPT = 80
const MAX_TEXT = 300
const MAX_TITLE = 14
const MAX_NAME = 12
// A block title this short is left as it is.
const SHORT = 10

export type WrittenFlow = { text: string; title?: string; nodes: Record<string, string> }

// Blocks still showing the message's own words. Blocks made up by the room
// (「被叫到」, ids with a colon) are short already.
function unnamed(flow: Flow, before: FlowSummary | undefined) {
  return flow.nodes.filter((node) => !node.id.includes(":") && node.title.length > SHORT && !before?.nodes?.[node.id])
}

// Pieces whose blocks were never named (new ones, and those written before
// blocks had names) all go in at once, so the first summary after this
// shipped tidies up everything already in the room; after that only new
// pieces do. Named pieces that moved go in up to MAX_ASK, newest first.
export function flowsToSummarize(flows: Flow[], previous: RoomSummary | null | undefined) {
  const fresh: Flow[] = []
  const moved: Flow[] = []
  for (const flow of flows) {
    const before = previous?.flows?.[flow.id]
    if (!before?.nodes) fresh.push(flow)
    else if (before.upToAt < flow.lastAt) moved.push(flow)
  }
  return [...fresh.slice(0, MAX_KEPT), ...moved.slice(0, MAX_ASK)].sort((a, b) => b.lastAt - a.lastAt)
}

// The writer's brief for those pieces; empty when nothing moved.
// `sourceOf`: a block's full words (the message, or the todo's title).
export function flowSummaryPrompt(flows: Flow[], previous: RoomSummary | null | undefined, sourceOf: (node: FlowNode) => string) {
  if (flows.length === 0) return ""
  const kind: Record<FlowNode["kind"], string> = { say: "用户说", call: "派活", task: "待办", ask: "提问", reply: "回复" }
  const parts = flows.map((flow) => {
    const before = previous?.flows?.[flow.id]
    const blocks = unnamed(flow, before).slice(0, MAX_BLOCKS)
    return [
      `### ${flow.id}（「${flow.title}」）`,
      before ? `上次写的：${before.title ? `【${before.title}】` : ""}${before.text}` : "上次写的：还没有",
      flowText(flow),
      ...(blocks.length > 0
        ? ["要起短名的块：", ...blocks.map((node) => `- ${node.id}（${kind[node.kind]}）：${sourceOf(node).replace(/\s+/g, " ").slice(0, 160)}`)]
        : ["（块都有短名了，不用再写）"]),
    ].join("\n")
  })
  return [
    `【流程卡片】下面 ${flows.length} 件事从上次以来有了新动静，它们在页面上画成流程图。在摘要正文后面另起一行「${HEAD}」，每件一段，格式：`,
    [
      "### 编号（原样抄）",
      `标题：这件事的短名，${MAX_TITLE} 字以内`,
      "一两句、不超过 80 字：要做成什么、现在到哪、在等谁。",
      `- 块编号：这一块的短名，4～${MAX_NAME} 字`,
    ].join("\n"),
    `块的短名是图上方框里的字，要一眼看懂这一步做什么，比如「修搜索框错位」「问要不要重启」，别抄原句开头。只给列出来的块起名，只写列出的这几件。`,
    ...parts,
  ].join("\n\n")
}

const clipTo = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text)

// The summary text as handed in, split into the summary proper and the
// pieces' wording (by root message id).
export function splitFlowSummaries(text: string) {
  const at = text.search(new RegExp(`^${HEAD}\\s*$`, "m"))
  if (at < 0) return { main: text.trim(), flows: {} as Record<string, WrittenFlow> }
  const flows: Record<string, WrittenFlow> = {}
  const section = text.slice(at + HEAD.length)
  for (const block of section.split(/^###\s+/m).slice(1)) {
    const [head, ...rest] = block.split("\n")
    const id = head.match(/^(m_[0-9a-z]+)/i)?.[1]
    if (!id) continue
    let title: string | undefined
    const nodes: Record<string, string> = {}
    const lines: string[] = []
    for (const line of rest) {
      const named = line.match(/^\s*[-*•]\s*`?([mt]_[0-9a-z]+)`?\s*[：:]\s*(.+?)\s*$/i)
      if (named) {
        nodes[named[1]] = clipTo(named[2].replace(/^[「"]|[」"]$/g, ""), MAX_NAME)
        continue
      }
      const titled = line.match(/^\s*标题\s*[：:]\s*(.+?)\s*$/)
      if (titled) {
        title = clipTo(titled[1].replace(/^[「"]|[」"]$/g, ""), MAX_TITLE)
        continue
      }
      lines.push(line)
    }
    const body = lines.join("\n").trim()
    if (body || title || Object.keys(nodes).length > 0) flows[id] = { text: clipTo(body, MAX_TEXT), title, nodes }
  }
  return { main: text.slice(0, at).trim(), flows }
}

// The kept wording with this round's merged in. `asked`: each piece shown to
// the writer and how far it reached then; its summary only counts up to
// there, so what happens while it writes still shows as new. Block names
// add to the ones kept; anything left out keeps its old wording.
export function mergeFlowSummaries(
  kept: Record<string, FlowSummary> | undefined,
  written: Record<string, WrittenFlow>,
  asked: Record<string, number> | undefined,
  by: string,
) {
  const now = Date.now()
  const next: Record<string, FlowSummary> = { ...kept }
  for (const [id, piece] of Object.entries(written)) {
    if (asked && !(id in asked)) continue
    const before = next[id]
    next[id] = {
      text: piece.text || before?.text || "",
      ...((piece.title ?? before?.title) ? { title: piece.title ?? before?.title } : {}),
      nodes: { ...before?.nodes, ...piece.nodes },
      upToAt: asked?.[id] ?? now,
      by,
      at: now,
    }
  }
  const ids = Object.keys(next)
  if (ids.length <= MAX_KEPT) return next
  return Object.fromEntries(ids.sort((a, b) => next[b].at - next[a].at).slice(0, MAX_KEPT).map((id) => [id, next[id]]))
}
