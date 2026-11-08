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
            toast.error("没复制成功，选中文本再复制一次")
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
              toast.success("接入说明已复制")
            } catch {
              toast.error("没复制成功，选中文本再复制一次")
            }
          }}
        >
          复制说明
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
              {result.ok ? "已注册，重开它的会话后生效" : last || "没成功"}
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

export function JoinDialog({
  open,
  project,
  preset,
  agents,
  spawnable,
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
  const prompt = joinPrompt(origin, projectName)
  const ask = `接入并坐的「${projectName}」项目，名字叫 …，分工是 …`
  const words = query.trim().toLowerCase()
  const shown = KINDS.filter((kind) =>
    words ? [kind.id, kind.label, kind.harness].some((text) => text.toLowerCase().includes(words)) : true,
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
      toast.error(error instanceof Error ? error.message : "没运行成功")
    } finally {
      setRunning(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] grid-cols-[minmax(0,1fr)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>把 AI 接进「{projectName}」</DialogTitle>
          <DialogDescription>
            选好要接的 AI，在终端里运行一次给出的命令，再在它的会话里说一句话入座。注册是每个 AI 一次，所有项目共用；进哪个项目看那句话。
          </DialogDescription>
        </DialogHeader>
        <section className="space-y-2">
          <div className="flex items-center gap-2">
            <h3 className="shrink-0 text-sm font-medium">1. 接哪几个？</h3>
            <div className="relative ml-auto w-44">
              <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                placeholder="搜名字或软件"
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
          {shown.length === 0 ? (
            <div className="rounded-xl border px-3 py-2.5">
              <p className="text-xs leading-5 text-muted-foreground">
                列表里没有「{query.trim()}」。它也能接：把下面这段说明复制给它，它会用房间的接口自己入座、收发消息，只是别人 @ 它时房间叫不醒它。
              </p>
              <PromptBox prompt={prompt} />
            </div>
          ) : null}
        </section>
        <section className="space-y-2">
          <h3 className="text-sm font-medium">2. 运行一次注册命令</h3>
          {chosen.length > 0 ? (
            <>
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <CopyLine text={`${root}/scripts/register-mcp.sh ${chosen.map((kind) => kind.id).join(" ")}`} />
                </div>
                <Button type="button" size="sm" className="shrink-0" disabled={running} onClick={runHere}>
                  {running ? <Loader2 className="animate-spin" /> : <Play />}
                  {running ? "正在运行" : "替我运行"}
                </Button>
              </div>
              {results ? <Results results={results} /> : null}
              <p className="text-xs leading-5 text-muted-foreground">以后不用再做，换项目也不用重跑。</p>
            </>
          ) : (
            <p className="rounded-lg border border-dashed px-3 py-2.5 text-xs text-muted-foreground">先在上面选要接的 AI，可以多选。</p>
          )}
        </section>
        <section className="space-y-2">
          <h3 className="text-sm font-medium">3. 在它的会话里说</h3>
          <CopyLine text={ask} />
          <p className="text-xs leading-5 text-muted-foreground">
            {project?.dir
              ? `它的工作目录在 ${project.dir} 里面的话，不说项目名也会进这个项目。`
              : "给项目设一个目录后，在那个目录里干活的 AI 不说项目名也会自动进来。"}
            它原来坐在别的项目里的话，会离开那边。
          </p>
        </section>
        {spawnable.length > 0 ? (
          <section className="space-y-2">
            <h3 className="text-sm font-medium">或者让房间直接开一个新会话</h3>
            <div className="flex flex-wrap gap-1.5">
              {spawnable.map((id) => {
                const kind = kindById(id)
                return (
                  <Button key={id} type="button" variant="outline" size="sm" className="rounded-full" onClick={() => onSpawn(id)}>
                    <Plus />
                    新的 {kind?.label ?? id} 会话
                  </Button>
                )
              })}
            </div>
            <p className="text-xs leading-5 text-muted-foreground">
              房间在后台建好会话并入座{project?.dir ? `，默认开在项目目录 ${project.dir}` : ""}，不用你去打开它。
            </p>
          </section>
        ) : null}
        <p className="text-xs leading-5 text-muted-foreground">
          接进来以后，AI 会有 bench_join、bench_inbox、bench_say 等工具。会话 id 由 AI 自己取，不用你提供：能自动识别的直接用，识别不到时 bench_join 会告诉它用哪条命令查。会话开着就显示在线，关了就离线，别人 @ 它时房间会去唤起。
        </p>
        <details className="rounded-xl border px-3 py-2">
          <summary className="cursor-pointer text-sm">
            列表里没有的 agent：复制这段说明贴给它
          </summary>
          <PromptBox prompt={prompt} />
        </details>
        <div className="flex items-center justify-between gap-2 border-t pt-3">
          <span className="text-xs text-muted-foreground">房间地址 {origin}</span>
          {confirmReset ? (
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">这个项目的席位、对话和任务都会删掉。</span>
              <Button type="button" variant="destructive" size="sm" disabled={busy} onClick={onReset}>
                确认清空
              </Button>
            </div>
          ) : (
            <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmReset(true)}>
              清空这个项目的记录
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
