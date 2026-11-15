"use client"

import { useEffect, useState, useSyncExternalStore } from "react"
import { Check, Copy, Loader2, Play, Plus, Search, X } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/components/room/api"
import { Avatar } from "@/components/room/bits"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Textarea } from "@/components/ui/textarea"
import { Input } from "@/components/ui/input"
import { KINDS, kindById, kindOf, type Kind } from "@/lib/kinds"
import { joinPrompt } from "@/lib/prompt"
import type { RegisterResult } from "@/lib/register"
import type { ProjectInfo, PublicAgent } from "@/lib/types"

function subscribeOrigin() {
  return () => {}
}

function readOrigin() {
  return window.location.origin
}

function serverOrigin() {
  return "http://127.0.0.1:4399"
}

function CopyLine({ text }: { text: string }) {
  const [done, setDone] = useState(false)
  return (
    <div className="flex items-center gap-1 rounded-lg border bg-muted/50 py-1 pr-1 pl-2.5">
      <code className="min-w-0 flex-1 overflow-x-auto py-1 font-mono text-xs whitespace-nowrap" title={text}>
        {text}
      </code>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label="复制"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text)
            setDone(true)
            window.setTimeout(() => setDone(false), 1500)
          } catch {
            toast.error("复制失败，请手动复制")
          }
        }}
      >
        {done ? <Check /> : <Copy />}
      </Button>
    </div>
  )
}

// The join instructions to paste into an agent the list doesn't cover.
function PromptBox({ prompt }: { prompt: string }) {
  return (
    <>
      <Textarea readOnly value={prompt} className="mt-2 max-h-64 min-h-40 font-mono text-xs leading-5" />
      <div className="mt-2 flex justify-end">
        <Button
          type="button"
          size="sm"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(prompt)
              toast.success("说明已复制")
            } catch {
              toast.error("复制失败，请手动复制")
            }
          }}
        >
          复制
        </Button>
      </div>
    </>
  )
}

// How each registration went. A failure shows the script's last words, which
// usually say what is missing (the agent's CLI not installed, say).
function Results({ results }: { results: RegisterResult[] }) {
  return (
    <ul className="space-y-1 rounded-lg border px-3 py-2 text-xs">
      {results.map((result) => {
        const kind = kindById(result.kind)
        const last = result.output.split("\n").filter(Boolean).at(-1) ?? ""
        return (
          <li key={result.kind} className="flex items-start gap-2">
            {result.ok ? (
              <Check className="mt-0.5 size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
            ) : (
              <X className="mt-0.5 size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
            )}
            <span className="w-20 shrink-0 font-medium">{kind?.label ?? result.kind}</span>
            <span className="min-w-0 flex-1 text-muted-foreground" title={result.output}>
              {result.ok ? "已注册，重开会话生效" : last || "没成功"}
            </span>
          </li>
        )
      })}
    </ul>
  )
}

// One agent to pick: its character, name and app; ticks when picked, and
// says so when someone of that kind already sits in the room.
function KindTile({
  kind,
  picked,
  seated,
  onToggle,
}: {
  kind: Kind
  picked: boolean
  seated: number
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      aria-pressed={picked}
      className={`relative flex items-center gap-2 rounded-xl border px-2 py-1.5 text-left transition-[background-color,border-color,scale] active:scale-[.97] motion-reduce:transition-none ${
        picked ? "border-primary/50 bg-primary/8" : "border-transparent hover:bg-muted/70"
      }`}
      onClick={onToggle}
    >
      <Avatar name={kind.label} color={kind.color} kind={kind} size="sm" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium leading-tight">{kind.label}</span>
        <span className="block truncate text-[11px] text-muted-foreground">
          {seated > 0 ? `已接入 ${seated} 个` : kind.harness}
        </span>
      </span>
      {picked ? (
        <span className="absolute top-1 right-1 grid size-4 place-items-center rounded-full bg-primary text-primary-foreground">
          <Check className="size-3" />
        </span>
      ) : null}
    </button>
  )
}

function matches(kind: Kind, words: string) {
  return [kind.id, kind.label, kind.harness].some((text) => text.toLowerCase().includes(words))
}

export function JoinDialog({
  open,
  project,
  preset,
  agents,
  spawnable,
  userName,
  busy,
  onOpenChange,
  onSpawn,
  onReset,
}: {
  open: boolean
  // The project they join; everything here is for it.
  project: ProjectInfo | null
  // A kind to have picked already, when you came from its row.
  preset: string | null
  agents: PublicAgent[]
  // Kinds the room can start a session of itself.
  spawnable: string[]
  // What the user goes by; the prompt tells the agent.
  userName: string
  busy: boolean
  onOpenChange: (open: boolean) => void
  onSpawn: (kind: string) => void
  onReset: () => void
}) {
  const origin = useSyncExternalStore(subscribeOrigin, readOrigin, serverOrigin)
  const [root, setRoot] = useState("~/Downloads/bench")
  const [confirmReset, setConfirmReset] = useState(false)
  const [wasOpen, setWasOpen] = useState(open)
  const [picked, setPicked] = useState<string[]>([])
  const [query, setQuery] = useState("")
  const [running, setRunning] = useState(false)
  const [results, setResults] = useState<RegisterResult[] | null>(null)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (!open) setConfirmReset(false)
    if (open) {
      setPicked(preset ? [preset] : [])
      setQuery("")
      setResults(null)
    }
  }

  useEffect(() => {
    if (!open) return
    api<{ root?: string }>("/api/v1/prompt")
      .then((data) => {
        if (data.root) setRoot(data.root)
      })
      .catch(() => {})
  }, [open])

  const projectName = project?.name ?? "默认项目"
  const prompt = joinPrompt(origin, projectName, userName)
  const ask = `接入并坐的「${projectName}」项目，名字叫 …，分工是 …`
  const words = query.trim().toLowerCase()
  // Kinds already seated here are in the roster; this page is for the rest.
  // One you came here from (preset) stays, so its row's 「接入」 still lands.
  const seatedKinds = new Set(agents.filter((agent) => !agent.demo).map((agent) => kindOf(agent)?.id))
  const joined = KINDS.filter((kind) => seatedKinds.has(kind.id) && kind.id !== preset)
  const shown = KINDS.filter(
    (kind) =>
      !joined.includes(kind) &&
      (words ? matches(kind, words) : true),
  )
  // Keep the command in list order, not click order.
  const chosen = KINDS.filter((kind) => picked.includes(kind.id))
  const toggle = (id: string) => {
    setResults(null)
    setPicked((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]))
  }

  async function runHere() {
    setRunning(true)
    setResults(null)
    try {
      const data = await api<{ results: RegisterResult[] }>("/api/v1/register", {
        method: "POST",
        body: JSON.stringify({ as: "human", kinds: chosen.map((kind) => kind.id) }),
      })
      setResults(data.results)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "运行失败")
    } finally {
      setRunning(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] grid-cols-[minmax(0,1fr)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>接入 AI</DialogTitle>
          <DialogDescription>
            给选中的客户端写入一次 bench 配置，再在它会话里发一句即可入座「{projectName}」。
          </DialogDescription>
        </DialogHeader>
        <section className="space-y-2" data-tour="j-pick">
          <div className="flex items-center gap-2">
            <h3 className="shrink-0 text-sm font-medium">1. 选客户端</h3>
            <div className="relative ml-auto w-44">
              <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                placeholder="搜客户端"
                aria-label="搜 agent"
                className="h-7 pl-7 text-xs"
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-1 sm:grid-cols-3">
            {shown.map((kind) => (
              <KindTile
                key={kind.id}
                kind={kind}
                picked={picked.includes(kind.id)}
                seated={agents.filter((agent) => !agent.demo && kindOf(agent)?.id === kind.id).length}
                onToggle={() => toggle(kind.id)}
              />
            ))}
          </div>
          {joined.length ? (
            <p className="text-[11px] leading-4 text-muted-foreground">
              已入座：{joined.map((kind) => kind.label).join("、")}（要加开去左栏点「开新会话」）。
            </p>
          ) : null}
          {shown.length === 0 && words && !joined.some((kind) => matches(kind, words)) ? (
            <div className="rounded-xl border px-3 py-2.5">
              <p className="text-xs leading-5 text-muted-foreground">
                列表里没有「{query.trim()}」：把下面说明贴给它即可入座（点名不会自动叫醒）。
              </p>
              <PromptBox prompt={prompt} />
            </div>
          ) : null}
        </section>
        <section className="space-y-2" data-tour="j-register">
          <h3 className="text-sm font-medium">2. 写入客户端配置（每家一次）</h3>
          {chosen.length > 0 ? (
            <>
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <CopyLine text={`${root}/scripts/register-mcp.sh ${chosen.map((kind) => kind.id).join(" ")}`} />
                </div>
                <Button type="button" size="sm" className="shrink-0" disabled={running} onClick={runHere}>
                  {running ? <Loader2 className="animate-spin" /> : <Play />}
                  {running ? "运行中…" : "运行"}
                </Button>
              </div>
              {results ? <Results results={results} /> : null}
              <p className="text-xs leading-5 text-muted-foreground">会向对应客户端配置注册 bench 工具，所有项目共用。</p>
            </>
          ) : (
            <p className="rounded-lg border border-dashed px-3 py-2.5 text-xs text-muted-foreground">先在上面选客户端（可多选）。</p>
          )}
        </section>
        <section className="space-y-2" data-tour="j-say">
          <h3 className="text-sm font-medium">3. 在它会话里发这句</h3>
          <CopyLine text={ask} />
          <p className="text-xs leading-5 text-muted-foreground">
            {project?.dir
              ? `工作目录在 ${project.dir} 内的会话可省略项目名；`
              : "项目设好目录后，同目录会话可省略项目名；"}
            原在别的项目会自动转来。
          </p>
        </section>
        {spawnable.length > 0 ? (
          <section className="space-y-2">
            <h3 className="text-sm font-medium">或后台直接开新会话</h3>
            <div className="flex flex-wrap gap-1.5">
              {spawnable.map((id) => {
                const kind = kindById(id)
                return (
                  <Button key={id} type="button" variant="outline" size="sm" className="rounded-full" onClick={() => onSpawn(id)}>
                    <Plus />
                    {kind?.label ?? id}
                  </Button>
                )
              })}
            </div>
            <p className="text-xs leading-5 text-muted-foreground">
              后台建好会话直接入座{project?.dir ? `（默认在 ${project.dir}）` : ""}。
            </p>
          </section>
        ) : null}
        <details className="rounded-xl border px-3 py-2">
          <summary className="cursor-pointer text-sm">
            其他客户端：复制说明贴给它
          </summary>
          <PromptBox prompt={prompt} />
        </details>
        <div className="flex items-center justify-between gap-2 border-t pt-3">
          <span className="text-xs text-muted-foreground">房间地址 {origin}</span>
          {confirmReset ? (
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">席位、对话和待办都会删掉</span>
              <Button type="button" variant="destructive" size="sm" disabled={busy} onClick={onReset}>
                确认清空
              </Button>
            </div>
          ) : (
            <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmReset(true)}>
              清空记录
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
