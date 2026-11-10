import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import { summonPath, tomlString } from "@/lib/adapters"
import { cliCommand } from "@/lib/platform"
import { ApiError } from "@/lib/http"
import { KINDS } from "@/lib/kinds"

// The model a seat runs on, when the user picked one in the room (「开新会话」
// or the seat's menu). Unpicked, a wake runs on whatever its command or its
// client's own config says, as before.
//
// How a pick reaches a wake (adapters.ts commandFor, summon.ts launch):
// - Claude Code, Codex and WorkBuddy: BENCH_MODEL in the environment;
//   claude-code.sh adds --model, codex-wake.sh -m, codex-app.mjs puts it on
//   turn/start, workbuddy-wake.sh --model.
// - DeepSeek (dsh-agent): -m, and -r for the route that lists the model.
// - Commands that name a model themselves (Cursor's Grok, Antigravity, Gemini
//   CLI, Qoder): that --model or -m is swapped for the pick.
// - Kinds with a `modelFlag` (CodeBuddy, Copilot): the flag goes in before -p.
//
// The lists: Claude's are the exact ids of the current generation, from the
// ones written here and the ones the installed claude binary knows (so an
// update of Claude Code brings its new ones), then its aliases (fable, opus,
// sonnet, haiku). An alias means the newest that Claude Code version knows,
// which can trail a release: 2.1.319 still took `fable` as 5.1 when 5.2 was
// out and answered under its full id. DeepSeek's come from
// `dsh-agent config`, Codex's from its model catalog (the file config.toml's
// model_catalog_json names, else its models_cache.json; on another provider,
// that provider's /models), Antigravity's from
// `agy models`, Cursor's from `cursor-agent models`, CodeBuddy's and
// WorkBuddy's from `codebuddy --help`. A kind without a list still takes any
// id typed in.

// The PATH wakes get: the room's own may lack ~/.local/bin (cursor-agent, agy).
function withPath() {
  return { ...process.env, PATH: summonPath() }
}

// Runs a CLI and returns what it printed; on Windows through Git Bash, which
// finds npm-installed CLIs (lib/platform.ts).
function runCli(file: string, args: string[], timeout: number) {
  const [program, programArgs] = cliCommand(file, args)
  return execFileSync(program, programArgs, { encoding: "utf8", timeout, env: withPath(), windowsHide: true })
}

export type ModelChoice = { id: string; label: string; note?: string }

// Reasoning effort, for the kinds whose CLI takes one: Claude Code's --effort,
// Codex's per-turn effort (model_reasoning_effort), CodeBuddy's --effort.
// DeepSeek's dsh-agent has none; Cursor and Antigravity put it in the model
// name, so picking the model picks it. Rides in BENCH_EFFORT (summon.ts) for
// the wake scripts, and as a flag for CodeBuddy's command (withEffort).
const EFFORTS: Record<string, string[]> = {
  claude: ["low", "medium", "high", "xhigh", "max"],
  codex: ["minimal", "low", "medium", "high", "xhigh"],
  codebuddy: ["minimal", "low", "medium", "high", "xhigh", "max"],
  workbuddy: ["minimal", "low", "medium", "high", "xhigh", "max"],
}

export function effortLevels(kind: string) {
  return EFFORTS[kind] ?? []
}

export function checkEffort(kind: string, input: unknown): string | null {
  if (input === null || input === undefined || input === "") return null
  if (typeof input !== "string" || !effortLevels(kind).includes(input)) {
    throw new ApiError(400, effortLevels(kind).length ? `思考强度只能是 ${effortLevels(kind).join("、")}` : "这一家不能设思考强度")
  }
  return input
}

export function withEffort(kind: string, command: string, effort?: string | null) {
  if (!effort || kind !== "codebuddy") return command
  const at = command.search(/\s-p\s/)
  const add = ` --effort ${effort}`
  return at < 0 ? command + add : command.slice(0, at) + add + command.slice(at)
}

// Model ids and aliases are plain words; anything else is refused before it
// gets near a shell.
const PICK = /^[\w.:/@-]{1,80}$/

export function checkPick(input: unknown): string | null {
  if (input === null || input === undefined || input === "") return null
  if (typeof input !== "string" || !PICK.test(input.trim())) {
    throw new ApiError(400, "模型名只能有字母、数字和 . : / @ - _，最长 80 个字")
  }
  return input.trim()
}

const CLAUDE_FAMILIES = ["fable", "opus", "sonnet", "haiku"] as const
const CLAUDE_ALIASES: ModelChoice[] = [
  { id: "fable", label: "fable", note: "跟着 Claude Code 版本走，可能比上面的旧" },
  { id: "opus", label: "opus", note: "跟着 Claude Code 版本走" },
  { id: "sonnet", label: "sonnet", note: "跟着 Claude Code 版本走" },
  { id: "haiku", label: "haiku", note: "跟着 Claude Code 版本走" },
]
// Known exact ids; newer ones also turn up from the binary.
const CLAUDE_KNOWN = ["claude-fable-5-2", "claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]
const CLAUDE_ID = /claude-(fable|opus|sonnet|haiku)-(\d+)-(\d+)(?![\w-])/g

// The model ids written into the installed Claude Code (its own table), from
// generation 5 on: older ones are retired or close to it.
function claudeBinaryIds() {
  // Windows: the claude.exe `where` finds (an npm .cmd shim holds no table).
  const bin =
    process.platform === "win32"
      ? execFileSync("where", ["claude"], { encoding: "utf8", timeout: 5000, env: withPath() }).split(/\r?\n/).find((line) => /\.exe$/i.test(line.trim()))?.trim()
      : execFileSync("sh", ["-c", "readlink -f \"$(command -v claude)\""], { encoding: "utf8", timeout: 5000, env: withPath() }).trim()
  if (!bin) return []
  const text = readFileSync(bin, "latin1")
  return [...new Set([...text.matchAll(CLAUDE_ID)].filter((match) => Number(match[2]) >= 5).map((match) => match[0]))]
}

function claudeModels(): ModelChoice[] {
  let found: string[] = []
  try {
    found = claudeBinaryIds()
  } catch {}
  const ids = [...new Set([...CLAUDE_KNOWN, ...found])]
  const parts = (id: string) => id.match(/claude-(\w+)-(\d+)-(\d+)/)!
  ids.sort((a, b) => {
    const [, fa, ma, na] = parts(a)
    const [, fb, mb, nb] = parts(b)
    const family = CLAUDE_FAMILIES.indexOf(fa as never) - CLAUDE_FAMILIES.indexOf(fb as never)
    return family || Number(mb) - Number(ma) || Number(nb) - Number(na)
  })
  const exact = ids.map((id) => {
    const [, family, major, minor] = parts(id)
    const note = { opus: "最强，慢一些", sonnet: "又快又好", haiku: "最快最省" }[family]
    return { id, label: `${family[0].toUpperCase()}${family.slice(1)} ${major}.${minor}`, ...(note ? { note } : {}) }
  })
  return [...exact, ...CLAUDE_ALIASES]
}

type DshRoutes = { route: string; name: string; models: string[] }[]

let dshCache: { at: number; routes: DshRoutes } | null = null

// dsh-agent's routes and the models each one lists, from `dsh-agent config`.
function dshRoutes(): DshRoutes {
  if (dshCache && Date.now() - dshCache.at < 60_000) return dshCache.routes
  let routes: DshRoutes = []
  try {
    const out = runCli("dsh-agent", ["config", "--json"], 5000)
    const config = JSON.parse(out) as { routes?: Record<string, { displayName?: string; models?: unknown }> }
    routes = Object.entries(config.routes ?? {}).map(([route, value]) => ({
      route,
      name: value.displayName || route,
      models: Array.isArray(value.models) ? value.models.filter((item): item is string => typeof item === "string") : [],
    }))
  } catch {}
  dshCache = { at: Date.now(), routes }
  return routes
}

// Lists that take a moment to get (a command, a network fetch) are kept a
// minute.
const cached = new Map<string, { at: number; list: ModelChoice[] }>()
function remember(kind: string, get: () => ModelChoice[]) {
  const hit = cached.get(kind)
  if (hit && Date.now() - hit.at < 60_000) return hit.list
  let list: ModelChoice[] = []
  try {
    list = get()
  } catch {}
  cached.set(kind, { at: Date.now(), list })
  return list
}

type CodexModel = { slug?: unknown; display_name?: unknown; description?: unknown; visibility?: unknown }

// The keys of a provider in Codex's config.toml: its endpoint, and the API key
// from env_key or from running its [auth] command, as Codex does.
function providerKey(config: string, provider: string) {
  const env = tomlString(config, "env_key", `model_providers.${provider}`)
  if (env) return process.env[env] ?? null
  const command = tomlString(config, "command", `model_providers.${provider}.auth`)
  if (!command) return null
  const text = readFileSync(config, "utf8")
  const at = text.search(new RegExp(`^\\[model_providers\\.${provider}\\.auth\\][ \\t]*$`, "m"))
  const raw = text.slice(at).split(/^\[(?!model_providers\.)/m)[0].match(/^args\s*=\s*(\[.*\])\s*$/m)?.[1]
  const args = raw ? (JSON.parse(raw) as unknown[]).filter((item): item is string => typeof item === "string") : []
  return execFileSync(command, args, { encoding: "utf8", timeout: 5000, env: withPath() }).trim() || null
}

// When Codex runs on another provider (top-level model_provider, say a
// DeepSeek API), its picker's catalog is OpenAI's; list what the provider
// serves instead (GET <base_url>/models).
function providerModels(config: string): ModelChoice[] | null {
  const provider = tomlString(config, "model_provider")
  if (!provider || provider === "openai") return null
  const base = tomlString(config, "base_url", `model_providers.${provider}`)
  if (!base) return null
  const name = tomlString(config, "name", `model_providers.${provider}`) ?? provider
  const key = providerKey(config, provider)
  // The key goes in on stdin, not on the command line.
  const out = execFileSync("curl", ["-sf", "-m", "10", "-H", "@-", `${base.replace(/\/$/, "")}/models`], {
    encoding: "utf8",
    input: key ? `Authorization: Bearer ${key}\n` : "",
    timeout: 15_000,
  })
  const data = (JSON.parse(out) as { data?: { id?: unknown }[] }).data ?? []
  return data
    .map((model) => model.id)
    .filter((id): id is string => typeof id === "string" && PICK.test(id))
    .sort((a, b) => Number(b.startsWith("deepseek")) - Number(a.startsWith("deepseek")))
    .map((id) => ({ id, label: id, note: name }))
}

// The models Codex's own picker shows ("list"), from the catalog it loads, or
// the provider's when it runs on another one.
function codexModels(): ModelChoice[] {
  const home = process.env.CODEX_HOME || path.join(os.homedir(), ".codex")
  const other = providerModels(path.join(home, "config.toml"))
  if (other) return other
  const catalog = tomlString(path.join(home, "config.toml"), "model_catalog_json")
  for (const file of [catalog, path.join(home, "models_cache.json")]) {
    if (!file) continue
    try {
      const models = (JSON.parse(readFileSync(file, "utf8")) as { models?: CodexModel[] }).models ?? []
      const shown = models.filter((model) => typeof model.slug === "string" && model.visibility !== "hide")
      if (!shown.length) continue
      return shown.map((model) => ({
        id: model.slug as string,
        label: typeof model.display_name === "string" ? model.display_name : (model.slug as string),
        note: typeof model.description === "string" ? model.description.slice(0, 40) : undefined,
      }))
    } catch {}
  }
  return []
}

// `cursor-agent models` prints "id - name" a line (some names end in
// zero-width spaces; colored when the room runs with FORCE_COLOR set).
function cursorModels(): ModelChoice[] {
  const out = runCli("cursor-agent", ["models"], 20_000)
  return out
    .split("\n")
    .map((line) => line.replace(/\x1b\[[0-9;]*m|[\u200b-\u200d\ufeff]/g, "").match(/^([\w.:/@-]+) - (.+)$/))
    .filter((match): match is RegExpMatchArray => Boolean(match && PICK.test(match[1])))
    .map((match) => ({ id: match[1], label: match[2].replace(/\s*\(default\)$/, "").trim() }))
}

// CodeBuddy's help lists the ids --model takes: "Currently supported: (a, b)".
// (Its `models` command is a prompt, answered by a model.) WorkBuddy runs the
// same CLI, from its own install when there is no codebuddy on the PATH.
function codebuddyModels(): ModelChoice[] {
  const bins = ["codebuddy", "/opt/apps/com.tencent.workbuddy/files/resources/app.asar.unpacked/cli/bin/codebuddy"]
  for (const bin of bins) {
    try {
      const help = runCli(bin, ["--help"], 20_000)
      const list = help.match(/--model <model>[^(]*\(([^)]*)\)/)?.[1]
      if (!list) continue
      return list
        .split(",")
        .map((id) => id.trim())
        .filter((id) => PICK.test(id))
        .map((id) => ({ id, label: id }))
    } catch {}
  }
  return []
}

// `agy models` prints "id<TAB>name" a line, after a "Fetching…" line.
function antigravityModels(): ModelChoice[] {
  const out = runCli("agy", ["models"], 20_000)
  return out
    .split("\n")
    .map((line) => line.split("\t"))
    .filter((parts) => parts.length >= 2 && PICK.test(parts[0].trim()))
    .map(([id, label]) => ({ id: id.trim(), label: label.trim() }))
}

// What the room offers for a kind; the page also lets the user type any id.
export function modelChoices(kind: string): ModelChoice[] {
  if (kind === "claude") return remember(kind, claudeModels)
  if (kind === "codex") return remember(kind, codexModels)
  if (kind === "antigravity") return remember(kind, antigravityModels)
  if (kind === "cursor") return remember(kind, cursorModels)
  if (kind === "codebuddy" || kind === "workbuddy") return remember("codebuddy", codebuddyModels)
  if (kind === "dsh") {
    return dshRoutes().flatMap((route) =>
      route.models.map((model) => ({ id: model, label: model.replace(/^[\w-]+:/, ""), note: route.name })),
    )
  }
  return []
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

// dsh-agent's flags for a pick: -m, and -r for the first route listing it
// (none listing it: the default route is tried).
export function dshFlags(pick: string) {
  const route = dshRoutes().find((item) => item.models.includes(pick))?.route
  return route ? ["-r", route, "-m", pick] : ["-m", pick]
}

// The wake command with the pick in it, for kinds whose command carries the
// model (see the top). Claude Code and Codex read BENCH_MODEL instead.
export function withModel(kind: string, command: string, pick?: string | null) {
  if (!pick) return command
  if (kind === "dsh") {
    return command.replace(/^(\s*dsh-agent\s+(?:resume|exec))\b/, `$1 ${dshFlags(pick).map(shellQuote).join(" ")}`)
  }
  const named = /(\s)(--model|-m)(\s+|=)(?:'[^']*'|"[^"]*"|\S+)/
  if (named.test(command)) return command.replace(named, `$1$2$3${shellQuote(pick)}`)
  const flag = KINDS.find((item) => item.id === kind)?.modelFlag
  if (!flag) return command
  const at = command.search(/\s-p\s/)
  const add = ` ${flag} ${shellQuote(pick)}`
  return at < 0 ? command + add : command.slice(0, at) + add + command.slice(at)
}
