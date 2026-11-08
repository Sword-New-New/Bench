import type { RunStep } from "@/lib/types"

// Reads the event stream a woken agent prints (one JSON object per line) and
// turns it into steps for the 「过程」 panel plus the final answer. Covers the
// formats of Claude Code (stream-json), cursor-agent (stream-json), Codex
// (exec --json), Antigravity (agy stream-json) and dsh-agent (--json). The
// format is told apart by the shape of each line, so it doesn't matter which
// command printed it. Output that isn't such a stream is taken as the plain
// answer, as before.

type Json = Record<string, unknown>

function obj(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {}
}

function str(value: unknown) {
  return typeof value === "string" ? value : ""
}

function show(value: unknown) {
  if (value === undefined || value === null || value === "") return undefined
  return typeof value === "string" ? value : JSON.stringify(value, null, 2)
}

function pick(args: Json, keys: string[]) {
  const lower = Object.fromEntries(Object.entries(args).map(([key, value]) => [key.toLowerCase(), value]))
  for (const key of keys) {
    const value = lower[key.toLowerCase()]
    if (typeof value === "string" && value) return value
    if (Array.isArray(value) && value.length) return value.join(" ")
  }
  return ""
}

function base(file: string) {
  return file.replace(/\/+$/, "").split("/").pop() || file
}

function short(text: string, max = 48) {
  const line = text.replace(/\s+/g, " ").trim()
  return line.length > max ? `${line.slice(0, max)}…` : line
}

const BENCH: Record<string, string> = {
  bench_say: "在房间里发言",
  bench_inbox: "看房间收件箱",
  bench_join: "入座",
  bench_summary: "交房间摘要",
  bench_wait: "守着房间",
  bench_task_update: "更新任务",
  bench_task_create: "建任务",
}

// A short Chinese line for a tool call: 「读 package.json」, 「运行 npm test」.
export function describe(name: string, args: Json) {
  const tool = name.replace(/ToolCall$/, "").replace(/^mcp__\w+?__/, "")
  const low = tool.toLowerCase()
  const bench = Object.keys(BENCH).find((key) => low.includes(key))
  if (bench) return BENCH[bench]
  const file = pick(args, ["file_path", "filePath", "path", "target_file", "AbsolutePath", "TargetFile", "file"])
  if (/^(read|read_file|view|view_file|cat|readfile)$/.test(low)) return `读 ${base(file) || "文件"}`
  if (/shell|bash|command|exec|terminal|run/.test(low)) {
    return `运行 ${short(pick(args, ["command", "cmd", "CommandLine", "commandLine"])) || "命令"}`
  }
  if (/grep|search_text|rg|codebase_search/.test(low)) return `搜 ${short(pick(args, ["pattern", "query", "Query", "regex"]), 32)}`
  if (/glob|^ls$|list|find/.test(low)) return `列 ${short(pick(args, ["glob_pattern", "pattern", "path", "DirectoryPath", "target_directory"]), 32) || "文件"}`
  if (/edit|replace|patch|apply|multi/.test(low)) return `改 ${base(file) || "文件"}`
  if (/write|create/.test(low)) return `写 ${base(file) || "文件"}`
  if (/web_?search/.test(low)) return `搜网页 ${short(pick(args, ["query", "search_term"]), 32)}`
  if (/fetch|browse|url/.test(low)) return "打开网页"
  if (/todo/.test(low)) return "更新待办"
  if (/delete|remove/.test(low)) return `删 ${base(file) || "文件"}`
  return tool
}

// A tool's result as text: its main text field when it has one.
function resultText(value: unknown) {
  const body = obj(value)
  const main = ["content", "stdout", "output", "text"].map((key) => body[key]).find((item) => typeof item === "string")
  return typeof main === "string" ? main : show(value)
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) return content.map((part) => str(obj(part).text)).filter(Boolean).join("\n")
  return show(content) ?? ""
}

export function createParser() {
  let final: string | undefined
  let lastText = ""
  // What it said after its last tool call: the answer, without the progress
  // notes from before (cursor-agent's result glues all of them together).
  let afterTools: string[] = []
  let events = 0
  let plain = ""
  // Antigravity streams a reply as deltas under one step index.
  const deltas = new Map<number, string>()
  let n = 0
  const id = () => `s${++n}`

  function text(steps: RunStep[], value: string, key?: string) {
    const clean = value.trim()
    if (!clean) return
    lastText = clean
    afterTools.push(clean)
    steps.push({ id: key ?? id(), at: Date.now(), kind: "text", title: short(clean, 80), output: clean, state: "done" })
  }

  // One line of output in, the steps it adds or updates out.
  function feed(line: string): RunStep[] {
    const trimmed = line.trim()
    if (!trimmed) return []
    let event: Json
    try {
      event = obj(JSON.parse(trimmed))
    } catch {
      plain += `${line}\n`
      return []
    }
    events += 1
    const steps: RunStep[] = []
    const type = str(event.type)
    const now = Date.now()

    // Claude Code and cursor-agent.
    if (type === "assistant") {
      for (const block of (obj(event.message).content as unknown[]) ?? []) {
        const part = obj(block)
        if (part.type === "text") text(steps, str(part.text))
        if (part.type === "tool_use") {
          const args = obj(part.input)
          steps.push({ id: str(part.id) || id(), at: now, kind: "tool", title: describe(str(part.name), args), input: show(args), state: "running" })
        }
      }
    } else if (type === "user") {
      for (const block of (obj(event.message).content as unknown[]) ?? []) {
        const part = obj(block)
        if (part.type !== "tool_result") continue
        steps.push({
          id: str(part.tool_use_id),
          at: now,
          kind: "tool",
          title: "",
          output: textOf(part.content),
          state: part.is_error ? "failed" : "done",
        })
      }
    } else if (type === "tool_call") {
      const call = obj(event.tool_call)
      const [name, body] = Object.entries(call).find(([key]) => key.endsWith("ToolCall")) ?? ["工具", {}]
      const detail = obj(body)
      const args = obj(detail.args)
      const result = obj(detail.result)
      const failed = Boolean(result.error || result.rejected || result.failure)
      steps.push({
        id: str(event.call_id) || id(),
        at: now,
        kind: "tool",
        title: describe(name === "mcpToolCall" ? str(args.toolName) || str(args.name) : name, args),
        input: show(args),
        output: event.subtype === "completed" ? resultText(result.success ?? result.error ?? result.rejected ?? result) : undefined,
        state: event.subtype === "completed" ? (failed ? "failed" : "done") : "running",
      })
    } else if (type === "result" || (typeof event.result === "string" && event.session_id)) {
      if (typeof event.result === "string") final = event.result
    }

    // Codex: item.started / item.completed.
    else if (type.startsWith("item.") && event.item) {
      const item = obj(event.item)
      const done = type === "item.completed"
      const key = str(item.id) || id()
      if (item.type === "agent_message" && done) text(steps, str(item.text), key)
      else if (item.type === "command_execution") {
        const code = item.exit_code
        steps.push({
          id: key,
          at: now,
          kind: "tool",
          title: `运行 ${short(str(item.command).replace(/^\/bin\/\w+ -lc '(.*)'$/, "$1"))}`,
          input: str(item.command),
          output: done ? str(item.aggregated_output) : undefined,
          state: done ? (typeof code === "number" && code !== 0 ? "failed" : "done") : "running",
        })
      } else if (item.type === "mcp_tool_call") {
        const args = obj(item.arguments)
        steps.push({
          id: key,
          at: now,
          kind: "tool",
          title: describe(str(item.tool), args),
          input: show(args),
          output: done ? show(item.error ?? item.result) : undefined,
          state: done ? (item.error ? "failed" : "done") : "running",
        })
      } else if (item.type === "file_change" && done) {
        const changes = ((item.changes as unknown[]) ?? []).map((change) => base(str(obj(change).path)))
        steps.push({ id: key, at: now, kind: "tool", title: `改 ${changes.join("、") || "文件"}`, input: show(item.changes), state: "done" })
      } else if (item.type === "web_search") {
        steps.push({ id: key, at: now, kind: "tool", title: `搜网页 ${short(str(item.query), 32)}`, state: done ? "done" : "running" })
      }
    }

    // dsh-agent: item.started / item.completed with item_type.
    else if ((type === "item.started" || type === "item.completed") && event.item_type) {
      if (event.item_type === "tool_call") {
        const args = obj(event.input)
        steps.push({ id: str(event.id) || id(), at: now, kind: "tool", title: describe(str(event.tool), args), input: show(args), state: "running" })
      } else if (event.item_type === "tool_result") {
        steps.push({
          id: str(event.id),
          at: now,
          kind: "tool",
          title: "",
          output: show(event.output),
          state: event.status === "completed" ? "done" : "failed",
        })
      } else if (event.item_type === "text") text(steps, str(event.text))
    } else if (type === "final") {
      final = str(event.text)
    }

    // Antigravity: {"event": "step_update" | "result"}.
    else if (event.event === "step_update") {
      const step = obj(event.step_update)
      const index = Number(step.step_index)
      if (step.step_type === "tool") {
        const info = obj(step.tool_info)
        const args = obj(info.parameters)
        const ended = step.state !== "ACTIVE"
        steps.push({
          id: `agy${index}`,
          at: now,
          kind: "tool",
          title: describe(str(info.name) || str(step.tool_name), args),
          input: show(args),
          output: show(step.output ?? step.result ?? step.error),
          state: !ended ? "running" : step.state === "DONE" ? "done" : "failed",
        })
      } else if (step.step_type === "agent_response") {
        deltas.set(index, (deltas.get(index) ?? "") + str(step.text_delta))
        if (step.state !== "ACTIVE") text(steps, deltas.get(index) ?? "", `agy${index}`)
      }
    } else if (event.event === "result") {
      final = str(obj(event.result).response)
    }

    // A new tool call starts a new stretch: what came before was progress.
    if (steps.some((step) => step.kind === "tool" && step.state === "running")) afterTools = []
    // A tool result comes with an empty title; putStep keeps the one from
    // when the call started.
    return steps
  }

  // The answer to post: what it said after its last tool call, else what the
  // stream called its result, else (no stream at all) the plain output.
  function answer() {
    if (events === 0) return plain.trim()
    return (afterTools.join("\n\n") || final || lastText).trim()
  }

  return { feed, answer }
}

// What the seat line says while a step runs.
// A sentence it says shows as is: the seat line is its own notice board.
export function liveLine(step: RunStep) {
  if (step.kind === "text") return `「${short(step.output ?? step.title, 40)}」`
  if (step.kind === "tool" && step.state === "running") return `正在${step.title}`
  return null
}
