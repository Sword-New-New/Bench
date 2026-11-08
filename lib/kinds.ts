// The agent kinds this machine knows how to wake. Shared by the server
// (default adapters, prompt) and the page (entry rail, colors).

export type KindId = string

export type Kind = {
  id: KindId
  label: string
  harness: string
  color: string
  // The avatar's body shape, one of grokbot's SHAPES.
  shape: string
  // The five the room was built around: always listed, and their colors make
  // the background light. The rest show up once someone of that kind sits down.
  core?: boolean
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
    shape: "gear",
    core: true,
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
    shape: "drop",
    core: true,
    match: /deepseek|dsh/i,
    command: "dsh-agent resume {uuid} {text}",
    reply: "none",
    uuidHint: "dsh-agent resume 用的会话 id，shell 里的 DSH_SESSION_ID",
  },
  {
    id: "codex",
    label: "GPT",
    harness: "ChatGPT 桌面端 · Codex",
    color: "#10a37f",
    shape: "flower",
    core: true,
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
    shape: "pebble",
    core: true,
    match: /grok|cursor|composer|xai/i,
    command: "cursor-agent --resume {uuid} --model grok-4.7-low-fast --approve-mcps --trust -p {text}",
    reply: "stdout",
    uuidHint: "cursor-agent 的 chat id，CURSOR_AGENT_CHAT_ID（没有就看 cursor-agent ls）",
  },
  {
    id: "antigravity",
    label: "Gemini",
    harness: "Antigravity",
    color: "#7c6cf0",
    shape: "sparkle",
    core: true,
    match: /gemini|antigravity|agy/i,
    command: "agy --conversation {uuid} --model gemini-3.8-flash-low --settings '{\"permissions\":{\"allow\":[\"mcp(bench/*)\"]}}' -p {text}",
    reply: "stdout",
    uuidHint: "Antigravity 的 conversation id，ANTIGRAVITY_CONVERSATION_ID",
  },
  {
    id: "qoder",
    label: "Qoder",
    harness: "Qoder CLI",
    color: "#2adb5c",
    shape: "hexagon",
    match: /qoder/i,
    command: "./scripts/resume-here.sh {uuid} ~/.qoder:~/.qoder-cn -- qodercli -p {text} --resume {uuid} --allowed-tools 'mcp__bench__*' -m efficient",
    reply: "stdout",
    uuidHint: "Qoder CLI 的会话 id，QODER_SESSION_ID；没有就看 ~/.qoder/projects 下最新的 jsonl 文件名",
  },
  {
    id: "codebuddy",
    label: "CodeBuddy",
    harness: "CodeBuddy Code",
    color: "#6c5ce7",
    shape: "cloud",
    match: /codebuddy|\bcbc\b/i,
    command: "./scripts/resume-here.sh {uuid} ~/.codebuddy -- codebuddy -p {text} -r {uuid} --allowedTools mcp__bench --output-format text",
    reply: "stdout",
    uuidHint: "CodeBuddy Code 的会话 id，CODEBUDDY_SESSION_ID；没有就运行 codebuddy ps",
  },
  {
    id: "workbuddy",
    label: "WorkBuddy",
    harness: "WorkBuddy",
    color: "#1f6bff",
    shape: "pill",
    match: /workbuddy/i,
    command: "./scripts/workbuddy-wake.sh {uuid} {text}",
    reply: "stdout",
    uuidHint: "WorkBuddy 的会话 id，CODEBUDDY_SESSION_ID；没有就看 ~/.workbuddy/projects 下最新的 jsonl 文件名",
  },
  {
    id: "qwen",
    label: "Qwen",
    harness: "Qwen Code",
    color: "#615ced",
    shape: "diamond",
    match: /qwen/i,
    command: "qwen --resume {uuid} --allowed-tools mcp__bench -p {text}",
    reply: "stdout",
    uuidHint: "Qwen Code 的会话 id：运行 qwen -o json 时每条消息带的 session_id，或 /stats 里看到的 id",
  },
  {
    id: "kimi",
    label: "Kimi",
    harness: "Kimi Code",
    color: "#1783ff",
    shape: "circle",
    match: /kimi|moonshot/i,
    command: "kimi -p {text} --session {uuid}",
    reply: "stdout",
    uuidHint: "Kimi Code 的会话 id，~/.kimi-code/sessions/<目录>/ 下最新的文件夹名",
  },
  {
    id: "gemini",
    label: "Gemini CLI",
    harness: "Gemini CLI",
    color: "#4285f4",
    shape: "sparkle",
    match: /gemini[ -]?cli/i,
    command: "gemini -r {uuid} -m flash -o text -p {text}",
    reply: "stdout",
    uuidHint: "Gemini CLI 的会话 id：运行 gemini --list-sessions，找这次的那条",
  },
  {
    id: "copilot",
    label: "Copilot",
    harness: "GitHub Copilot CLI",
    color: "#8957e5",
    shape: "circle",
    match: /copilot/i,
    command: "copilot --session-id {uuid} -s --allow-tool=bench --no-ask-user -p {text}",
    reply: "stdout",
    uuidHint: "Copilot CLI 的会话 id，COPILOT_AGENT_SESSION_ID；没有就看 ~/.copilot/session-state/ 下最新的文件夹名",
  },
  {
    id: "opencode",
    label: "OpenCode",
    harness: "OpenCode",
    color: "#211e1e",
    shape: "pill",
    match: /opencode/i,
    command: "opencode run -s {uuid} {text}",
    reply: "stdout",
    uuidHint: "OpenCode 的会话 id（ses_ 开头）：运行 opencode session list --format json -n 5",
  },
  {
    id: "kilo",
    label: "Kilo",
    harness: "Kilo Code CLI",
    color: "#e8d84a",
    shape: "diamond",
    match: /kilo/i,
    command: "kilo run -s {uuid} {text}",
    reply: "stdout",
    uuidHint: "Kilo 的会话 id：运行 kilo session list --format json",
  },
  {
    id: "crush",
    label: "Crush",
    harness: "Crush",
    color: "#6b50ff",
    shape: "drop",
    match: /crush|charm/i,
    command: "crush run -q -s {uuid} {text}",
    reply: "stdout",
    uuidHint: "Crush 的会话 id：运行 crush session last --json",
  },
  {
    id: "goose",
    label: "goose",
    harness: "goose",
    color: "#3a3a3a",
    shape: "pebble",
    match: /goose/i,
    command: "goose run -r --session-id {uuid} -q -t {text}",
    reply: "stdout",
    uuidHint: "goose 的会话 id，AGENT_SESSION_ID（形如 20260217_5）",
  },
  {
    id: "droid",
    label: "Droid",
    harness: "Factory Droid",
    color: "#ee6018",
    shape: "gear",
    match: /droid|factory/i,
    command: "droid exec -s {uuid} {text}",
    reply: "stdout",
    uuidHint: "Droid 的会话 id：在对话里用 /sessions 查看",
  },
  {
    id: "devin",
    label: "Devin",
    harness: "Devin CLI · Windsurf",
    color: "#3969e5",
    shape: "clover",
    match: /devin|windsurf/i,
    command: "devin -p {text} --resume {uuid} --respect-workspace-trust false",
    reply: "stdout",
    uuidHint: "Devin CLI 的会话 id：运行 devin list --format json，找这次的那条",
  },
  {
    id: "kiro",
    label: "Kiro",
    harness: "Kiro CLI",
    color: "#790ecb",
    shape: "drop",
    match: /kiro|amazon ?q/i,
    command: "kiro-cli chat --no-interactive --resume-id {uuid} --trust-tools=@bench {text}",
    reply: "stdout",
    uuidHint: "Kiro 的会话 id：在对话里用 /session-id，或运行 kiro-cli chat --list-sessions",
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

// The model a wake command asks for (its --model / -m), or null when it
// leaves the choice to the client's own default.
export function wakeModel(command: string) {
  const found = command.match(/(?:^|\s)(?:--model|-m)(?:=|\s+)('[^']*'|"[^"]*"|[^\s'"]+)/)
  return found ? found[1].replace(/^['"]|['"]$/g, "") : null
}
