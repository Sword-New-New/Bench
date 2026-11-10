export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export function shortText(text: string): string {
  const line = text
    .replace(/@[\p{L}\p{N}_-]+/gu, "")
    .replace(/\s+/g, " ")
    .trim()
  const cut = line.split(/[。！？\n]/)[0] ?? line
  if (!cut) return "这件事"
  return cut.length > 28 ? `${cut.slice(0, 28)}…` : cut
}

const ATTACHMENT_LABEL = { file: "文件", dir: "文件夹", image: "图片", video: "视频", audio: "音频" } as const

// A message as an agent reads it: its attachments follow as paths it can
// open with its own tools.
export function withAttachments(text: string, attachments?: { kind: keyof typeof ATTACHMENT_LABEL; path: string }[]) {
  if (!attachments?.length) return text
  const lines = attachments.map((item) => `附件（${ATTACHMENT_LABEL[item.kind]}）：${item.path}`)
  return [text, ...lines].filter(Boolean).join("\n")
}

// `@name` as a whole word, every occurrence.
export function mentionPattern(name: string) {
  return new RegExp(`@${escapeRegExp(name)}(?![\\p{L}\\p{N}_-])`, "gu")
}

// `@name` put into a text where the caret is (start to end is what is selected
// there, and is replaced), set off by a space on each side unless one is
// already there. The caret ends up past the space after it, so what is typed
// next doesn't run into the name and undo the mention.
export function insertMention(text: string, name: string, start: number, end = start) {
  const before = text.slice(0, start)
  const after = text.slice(end)
  const lead = before && !/\s$/.test(before) ? " " : ""
  const spaced = /^[ \t]/.test(after)
  const piece = `${lead}@${name}${spaced ? "" : " "}`
  return { text: before + piece + after, caret: before.length + piece.length + (spaced ? 1 : 0) }
}

export function mentionedAgentIds(
  text: string,
  agents: { id: string; name: string }[],
): string[] {
  const ids = new Set<string>()
  const has = (name: string) =>
    new RegExp(`@${escapeRegExp(name)}(?![\\p{L}\\p{N}_-])`, "u").test(text)

  if (has("所有人") || has("everyone")) {
    for (const agent of agents) ids.add(agent.id)
  }

  const sorted = [...agents].sort((a, b) => b.name.length - a.name.length)
  for (const agent of sorted) {
    if (has(agent.name)) ids.add(agent.id)
  }
  return [...ids]
}

export function namedAgentIds(
  text: string,
  agents: { id: string; name: string }[],
): string[] {
  const ids = new Set(mentionedAgentIds(text, agents))
  const sorted = [...agents].sort((a, b) => b.name.length - a.name.length)
  for (const agent of sorted) {
    const named = new RegExp(
      `(?<![\\p{L}\\p{N}_-])${escapeRegExp(agent.name)}(?![\\p{L}\\p{N}_-])`,
      "u",
    )
    if (named.test(text)) ids.add(agent.id)
  }
  return [...ids]
}

export function unknownMentions(text: string, names: string[]): string[] {
  const known = new Set(names)
  const found = new Set<string>()
  for (const match of text.matchAll(/@([\p{L}\p{N}_-]+)/gu)) {
    const name = match[1]
    if (!name || name === "所有人" || name === "everyone" || known.has(name)) {
      continue
    }
    found.add(name)
  }
  return [...found]
}

export function splitMentions(
  text: string,
  names: string[],
): { text: string; mention: boolean }[] {
  const tokens = [...names, "所有人", "everyone"]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
  if (tokens.length === 0) return [{ text, mention: false }]

  const pattern = new RegExp(
    `@(?:${tokens.map(escapeRegExp).join("|")})(?![\\p{L}\\p{N}_-])`,
    "gu",
  )
  const parts: { text: string; mention: boolean }[] = []
  let last = 0
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0
    if (index > last) parts.push({ text: text.slice(last, index), mention: false })
    parts.push({ text: match[0], mention: true })
    last = index + match[0].length
  }
  if (last < text.length) parts.push({ text: text.slice(last), mention: false })
  if (parts.length === 0) return [{ text, mention: false }]
  return parts
}

// Shell code blocks in messages (components/room/markdown.tsx CodeBox).
const SHELLS = new Set(["", "bash", "sh", "shell", "zsh", "console", "terminal", "shellsession", "powershell", "ps1", "cmd", "bat"])

export function isShell(lang: string) {
  return SHELLS.has(lang)
}

// What the copy button puts on the clipboard. For a shell block written as a
// session (`$ command` lines with their output between), only the commands,
// without the `$ `; anything else as it is.
export function copyText(part: { text: string; lang: string }) {
  if (!isShell(part.lang)) return part.text
  const lines = part.text.split("\n")
  const prompted = lines.filter((line) => /^\s*[$>]\s/.test(line))
  if (prompted.length === 0) return part.text
  return prompted.map((line) => line.replace(/^\s*[$>]\s/, "")).join("\n")
}
