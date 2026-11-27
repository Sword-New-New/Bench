import { escapeRegExp } from "@/lib/text"
import type { Workflow } from "@/lib/types"

// The slash commands the room's input takes (components/room/composer.tsx).
// Seat commands go straight to the session actions. Workflow commands become
// a room message with explicit roles and wake targets; /model and /effort
// remain the seat menu's 「换模型」.

export type SlashCommand = {
  name: string
  mode: "seat" | "workflow"
  workflowId?: string
  // What goes after the name, shown in the menu.
  hint: string
  about: string
  // Needs something after the name.
  needsText: boolean
}

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: "goal",
    mode: "seat",
    hint: "<要达成什么> | clear",
    about: "给它定个目标，它一直做到达成为止（Claude Code、Codex）",
    needsText: true,
  },
  { name: "compact", mode: "seat", hint: "", about: "压缩它的上下文（Claude Code、Codex）", needsText: false },
  { name: "stop", mode: "seat", hint: "", about: "停下它手上在做的，排着的也取消", needsText: false },
  { name: "plan", mode: "workflow", hint: "需求", about: "多位搭档共同出计划，确认后再实施", needsText: true },
  { name: "explore", mode: "workflow", hint: "主题", about: "多位 AI 从不同角度并行探索并汇总方案对比", needsText: true },
]

export function slashCommands(workflows: Workflow[] = []): SlashCommand[] {
  const saved = workflows.filter((item) => item.command).map((item): SlashCommand => ({
    name: item.command!, mode: "workflow", workflowId: item.id, hint: item.kind === "explore" ? "主题" : "需求", needsText: true,
    about: item.kind === "plan"
      ? `${item.name}：${item.planners?.join(" + ")}`
      : item.kind === "explore"
        ? `${item.name}：${item.explorers?.join(" + ")}`
        : `${item.name}：${item.lead} → ${item.workers?.join("、")} → ${item.summarizer}`,
  }))
  return [...SLASH_COMMANDS.filter((item) => !saved.some((s) => s.name === item.name)), ...saved]
}

// "/goal 测试全过 @Opus" or "@Opus /goal 测试全过" (the @ may be anywhere in
// the line) → the command, whom it is for, and the rest of the line.
// Anything else, including a path like "/home/…", is a message.
export function parseSlash(text: string, names: string[], workflows: Workflow[] = []) {
  let rest = text
  const found: { name: string; at: number }[] = []
  for (const name of names) {
    const at = new RegExp(`@${escapeRegExp(name)}(?![\\p{L}\\p{N}_-])`, "gu")
    const match = at.exec(rest)
    if (match) {
      found.push({ name, at: text.indexOf(`@${name}`) })
      at.lastIndex = 0
      rest = rest.replace(at, " ")
    }
  }
  rest = rest.trim()
  const match = rest.match(/^\/([a-z][a-z0-9-]*)(?=\s|$)/)
  const command = match ? slashCommands(workflows).find((item) => item.name === match[1]) : undefined
  if (!match || !command) return null
  const body = rest.slice(match[0].length).trim()
  return { command, targets: found.sort((a, b) => a.at - b.at).map((item) => item.name), text: command.mode === "seat" ? body.replace(/\s+/g, " ") : body }
}
