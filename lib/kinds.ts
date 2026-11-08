// The agent kinds this machine knows how to wake. Shared by the server
// (default adapters, prompt) and the page (entry rail, colors).

export type KindId = "claude" | "dsh" | "codex" | "cursor" | "antigravity"

export type Kind = {
  id: KindId
  label: string
  harness: string
  color: string
  // Guess the kind from a free-form model string when agentName is missing.
  match: RegExp
  command: string
  // "stdout": the command prints the agent's answer, post it back as the agent.
  reply: "stdout" | "none"
  uuidHint: string
}

export const KINDS: Kind[] = [
  {
    id: "claude",
    label: "Claude",
    harness: "Claude Code",
    color: "#d97757",
    match: /claude|opus|sonnet|haiku|fable/i,
    command: "./scripts/claude-code.sh {uuid} {text}",
    reply: "stdout",
    uuidHint: "Claude Code 的 session id，也就是 ~/.claude/projects 下这次会话 jsonl 的文件名",
  },
  {
    id: "dsh",
    label: "DeepSeek",
    harness: "DeepSeek harness",
    color: "#4d6bfe",
    match: /deepseek|dsh/i,
    command: "dsh-agent resume {uuid} {text}",
    reply: "none",
    uuidHint: "dsh-agent resume 用的会话 id",
  },
  {
    id: "codex",
    label: "GPT",
    harness: "ChatGPT 桌面端 · Codex",
    color: "#10a37f",
    match: /gpt|codex|openai|\bo\d\b/i,
    command: "./scripts/codex-wake.sh {uuid} {text}",
    reply: "stdout",
    uuidHint: "Codex 的 thread id，环境变量 CODEX_THREAD_ID",
  },
  {
    id: "cursor",
    label: "Grok",
    harness: "Cursor",
    color: "#6b7280",
    match: /grok|cursor|composer|xai/i,
    command: "cursor-agent --resume {uuid} --model grok-4.7-low-fast --approve-mcps --trust -p {text}",
    reply: "stdout",
    uuidHint: "cursor-agent 的 chat id（cursor-agent ls 可以看到）",
  },
  {
    id: "antigravity",
    label: "Gemini",
    harness: "Antigravity",
    color: "#7c6cf0",
    match: /gemini|antigravity|agy/i,
    command: "agy --conversation {uuid} --model gemini-3.8-flash-low --settings '{\"permissions\":{\"allow\":[\"mcp(bench/*)\"]}}' -p {text}",
    reply: "stdout",
    uuidHint: "Antigravity 的 conversation id",
  },
]

export const KIND_IDS = KINDS.map((kind) => kind.id)

export function kindById(id: string | undefined | null) {
  return KINDS.find((kind) => kind.id === id) ?? null
}

export function kindOf(agent: { agentName?: string; model?: string; demo?: boolean }) {
  if (agent.demo) return null
  return kindById(agent.agentName) ?? KINDS.find((kind) => kind.match.test(agent.model ?? "")) ?? null
}
