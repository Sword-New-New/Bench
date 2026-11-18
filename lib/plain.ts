// 「说人话」: what the user reads has to be plain words. These are the rules the
// room runs on what an agent writes for him (to-do titles and steps, the first
// line of a request for review). All of them are fixed rules, no model is
// called: text that fails goes straight back to the agent that wrote it, with
// one line on how to rewrite it. Better to let an odd one through than to
// stop a normal title (the rules were run over every title the room had when
// they were set; MAINTENANCE.md「说人话」 has the numbers).

export type PlainFault = { kind: string; found: string }

// Product names and common words that look like code but are not.
const KEEP = new Set(
  [
    "GitHub",
    "WorkBuddy",
    "DeepSeek",
    "NovelAI",
    "OpenAI",
    "ChatGPT",
    "iPhone",
    "iPad",
    "macOS",
    "iOS",
    "YouTube",
    "JavaScript",
    "TypeScript",
    "PowerShell",
    "WebSocket",
    "OpenClaw",
    "Antigravity",
    "AverageJoe",
    "ClaudeCode",
  ].map((item) => item.toLowerCase()),
)

// Words that are plainly technical. Short on purpose: only ones a user never
// needs to see in a title. Matched as whole words, any case.
const JARGON = [
  "API",
  "tsc",
  "eslint",
  "lint",
  "HMR",
  "regex",
  "refactor",
  "webhook",
  "endpoint",
  "payload",
  "middleware",
  "hydration",
  "SSE",
  "diff",
  "patch",
  "commit",
  "props",
  "hook",
  "ref",
  "tmux",
  "npm",
  "stdout",
  "stderr",
  "JSON",
  "CSS",
  "DOM",
  "TSX",
]

const JARGON_RE = new RegExp(`(?<![A-Za-z0-9_])(?:${JARGON.join("|")})(?![A-Za-z0-9_])`, "i")

const RULES: { kind: string; re: RegExp }[] = [
  { kind: "代码引号", re: /`[^`]*`/ },
  { kind: "待办编号", re: /(?<![A-Za-z0-9_])[tmpas]_[0-9a-z]{4,}(?![A-Za-z0-9_])/ },
  { kind: "网址", re: /https?:\/\/|localhost:\d+|127\.0\.0\.1|(?<![A-Za-z0-9])\d{1,3}(?:\.\d{1,3}){3}:\d+/i },
  {
    kind: "文件名",
    re: /(?<![A-Za-z0-9_])[\w-]+(?:\.[\w-]+)*\.(?:tsx?|jsx?|mjs|cjs|json|md|css|sh|py|db|ya?ml|html|sql|toml|lock|log|mjs|mp4|png)(?![A-Za-z0-9_])/i,
  },
  {
    kind: "路径",
    re: /(?<![A-Za-z0-9_])(?:\.{0,2}\/)?(?:lib|app|components|scripts|docs|data|src|node_modules|public|api)\/[\w.-]+(?:\/[\w.-]+)*|(?<![A-Za-z0-9_])\/(?:api|home|tmp|usr|etc|var)\/[\w.-]+/,
  },
  { kind: "带下划线的名字", re: /(?<![A-Za-z0-9])[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+(?![A-Za-z0-9])/ },
  // Only the lowerCamel kind (useState, keyFile). Product names written
  // CamelCase (CodeBuddy, WebGL) are left alone, as are hyphenated names
  // (bench-shell, branch names): too many of those are what a project is called.
  { kind: "驼峰名字", re: /(?<![A-Za-z0-9])[a-z]+[A-Z][A-Za-z0-9]*(?![A-Za-z0-9])/ },
  { kind: "成串英文", re: /(?<![A-Za-z])[A-Za-z]{2,}(?:[ ]+[A-Za-z]{2,}){3,}(?![A-Za-z])/ },
]

// First thing in the text that a user would have to read as code, or null.
export function plainFault(text: string): PlainFault | null {
  for (const rule of RULES) {
    const hit = rule.re.exec(text)
    if (!hit) continue
    // Names that only look like code.
    if ((rule.kind === "驼峰名字" || rule.kind === "带下划线的名字") && KEEP.has(hit[0].toLowerCase())) continue
    // Next.js, Node.js: a product name, not a file.
    if (rule.kind === "文件名" && /^(?:next|node|vue|react|three|d3)\.js$/i.test(hit[0])) continue
    return { kind: rule.kind, found: hit[0].length > 24 ? `${hit[0].slice(0, 24)}…` : hit[0] }
  }
  const jargon = JARGON_RE.exec(text)
  if (jargon) return { kind: "行话", found: jargon[0] }
  return null
}

// The line sent back with a refused title or step.
const HOW = "写用户能得到什么、能看到什么变化，别写改了哪个文件、哪个函数。比如「聊天里长回复先只显示一句结论」，不要写「gist.tsx 加 summaryOf」。技术细节放进 detail 或步骤的 note。"

export function plainRefusal(what: "标题" | "步骤" | "验收说明", fault: PlainFault) {
  if (what === "验收说明") {
    return `验收说明的第一句里有「${fault.found}」（${fault.kind}），用户看不懂。第一句写用户怎么看到效果，比如「刷新页面，左栏顶上多了一个开关」；文件名、命令、编号放到后面的句子里。请重写后再请验收。`
  }
  return `待办${what}里有「${fault.found}」（${fault.kind}），用户看不懂。${HOW}请重写后再${what === "标题" ? "建" : "加"}。`
}

// The first line that says something: what a user reads of a review note
// before anything else.
export function firstLine(text: string) {
  for (const line of text.split("\n")) {
    const trimmed = line.trim()
    if (trimmed) return trimmed
  }
  return ""
}

// ---------------------------------------------------------------------------
// What a tool call or a failure says, in words (permission cards, the
// 「正在做」 line, the grey bar for a wake that failed). The raw tool name and
// command stay where a click gets to them.

const CJK = /[㐀-鿿]/

function field(input: unknown, key: string) {
  if (typeof input !== "object" || input === null) return undefined
  const value = (input as Record<string, unknown>)[key]
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function fileOf(input: unknown) {
  const path = field(input, "file_path") ?? field(input, "notebook_path") ?? field(input, "path") ?? field(input, "filePath")
  return path ? path.replace(/\\/g, "/").split("/").filter(Boolean).pop() : undefined
}

// The sentence the client gave the tool call itself (Claude's `description`
// on a command): what it is for, in the author's words.
export function toolWhy(input: unknown) {
  const why = field(input, "description")
  if (!why) return undefined
  const line = why.replace(/\s+/g, " ")
  return line.length > 120 ? `${line.slice(0, 120)}…` : line
}

// What the call does, by the kind of tool: 「运行一条命令」, 「改文件 x.ts」.
// A verb phrase with nothing before it, so a card can say 想… and the seat
// line 正在….
export function toolAction(tool: string, input?: unknown) {
  const name = tool.replace(/ToolCall$/, "")
  const low = name.toLowerCase()
  const file = fileOf(input)
  if (/^mcp__/.test(name)) return "用一个外部工具"
  if (/^(bash|shell|exec_command|terminal)$|^run_|shell|bash|command/.test(low)) return "运行一条命令"
  if (/^(edit|multiedit|replace|apply_patch|patch|notebookedit|filechange|str_replace\w*)$/.test(low)) return file ? `改文件 ${file}` : "改一个文件"
  if (/^(write|create|create_file|write_file)$/.test(low)) return file ? `写文件 ${file}` : "写一个文件"
  if (/^(read|read_file|view|cat|notebookread)$/.test(low)) return file ? `读文件 ${file}` : "读一个文件"
  if (/^(grep|glob|ls|search|find|list\w*)$/.test(low)) return "在文件里找东西"
  if (/^websearch$|web_?search/.test(low)) return "上网搜一下"
  if (/^webfetch$|fetch|browse/.test(low)) {
    const url = field(input, "url")
    const host = url ? /^https?:\/\/([^/]+)/i.exec(url)?.[1] : undefined
    return host ? `打开网页 ${host}` : "打开一个网页"
  }
  if (/^(task|agent)$/.test(low)) return "叫一个帮手去做事"
  if (/todo/.test(low)) return "更新待办清单"
  return "用一个工具"
}

// The seat line while a tool runs: its own Chinese sentence when it wrote one,
// else what kind of thing it is doing. null when the step's own title already
// reads fine (it is not code).
export function liveToolLine(step: { title: string; input?: string }) {
  let input: unknown
  try {
    input = step.input ? JSON.parse(step.input) : undefined
  } catch {
    input = undefined
  }
  const why = toolWhy(input)
  if (why && CJK.test(why)) return `正在${why.replace(/[。.]$/, "")}`
  const title = step.title
  // describe() in lib/events.ts wrote these: the part after the verb is the
  // command or a pattern, which is code.
  if (/^运行 /.test(title)) return "正在运行一条命令"
  if (/^搜 /.test(title)) return "正在在文件里找东西"
  if (/^列 /.test(title)) return "正在看有哪些文件"
  if (/^[\x00-\x7f]+$/.test(title) && /[A-Za-z_]{3,}/.test(title)) return `正在${toolAction(title, input)}`
  return null
}

// A failed wake in a few plain words: why, as best the room can tell.
export function failureReason(agentName: string | undefined, failure: string) {
  const text = failure.trim()
  if (agentName === "antigravity" && /trajectory .*not found/.test(text)) return "找不到它的会话，需要重新入座"
  if (agentName === "antigravity" && /stream was interrupted/i.test(text)) return "半路断了，多半是工具被拒，可以再叫一次"
  if (/Authentication required|\/login|\b401\b|unauthori[sz]ed|invalid api key|not logged in/i.test(text)) return "没有登录，或登录过期了"
  if (agentName === "cursor" && /Model unavailable on Free/i.test(text)) return "免费版用不了这个模型"
  if (/model.*(?:not found|unavailable|unsupported|does not exist)|unknown model|模型.*(?:不可用|不存在)/i.test(text)) return "这个模型用不了"
  if (agentName === "codex" && /This chat uses (\S+), but your current provider is (\S+?)\./.test(text)) return "会话和现在接的服务不一致，要开新会话"
  if (agentName === "dsh" && /cannot compose presets/.test(text)) return "这个会话是网页上开的，后台叫不醒"
  if (/\bENOENT\b|command not found|no such file or directory/i.test(text)) return "找不到它要用的程序或文件"
  if (/\b(?:429|rate.?limit)\b/i.test(text)) return "请求太频繁，被对方限了速"
  if (/timed? ?out|超时/i.test(text)) return "等太久，超时了"
  if (/ECONN|ENOTFOUND|socket hang up|network|fetch failed|\b50[234]\b|connection (?:reset|refused|closed)/i.test(text)) return "网络断了"
  return "出了没预料到的错"
}
