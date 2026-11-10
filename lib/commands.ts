import { escapeRegExp } from "@/lib/text"

// The slash commands the room's input takes (components/room/composer.tsx).
// They aren't said in the room: each goes to the seats @'d in the same line,
// through the seat actions (app/api/v1/agents/[id]). Only commands both
// Claude Code and Codex have, and only ones the room can run on a session
// without a screen; /model and /effort are the seat menu's 「换模型」.

export type SlashCommand = {
  name: "goal" | "compact" | "stop"
  // What goes after the name, shown in the menu.
  hint: string
  about: string
  // Needs something after the name.
  needsText: boolean
}

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: "goal",
    hint: "<要达成什么> | clear",
    about: "给它定个目标，它一直做到达成为止（Claude Code、Codex）",
    needsText: true,
  },
  { name: "compact", hint: "", about: "压缩它的上下文（Claude Code、Codex）", needsText: false },
  { name: "stop", hint: "", about: "停下它手上在做的，排着的也取消", needsText: false },
]

// "/goal 测试全过 @Opus" or "@Opus /goal 测试全过" (the names under the input
// put the @ in front) → the command, whom it is for, and the rest of the line.
// Anything else, including a path like "/home/…", is a message.
export function parseSlash(text: string, names: string[]) {
  let rest = text
  const targets: string[] = []
  for (const name of names) {
    const at = new RegExp(`@${escapeRegExp(name)}(?![\\p{L}\\p{N}_-])`, "gu")
    if (at.test(rest)) {
      targets.push(name)
      rest = rest.replace(at, " ")
    }
  }
  rest = rest.trim()
  const match = rest.match(/^\/([a-z]+)(?=\s|$)/)
  const command = match ? SLASH_COMMANDS.find((item) => item.name === match[1]) : undefined
  if (!match || !command) return null
  return { command, targets, text: rest.slice(match[0].length).replace(/\s+/g, " ").trim() }
}
