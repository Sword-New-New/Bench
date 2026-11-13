"use client"

import { useEffect, useRef, useState } from "react"
import { ArrowRightLeft, BookOpen, FolderOpen, History, Loader2, RotateCcw } from "lucide-react"
import { toast } from "sonner"

import { api, type AdapterInfo } from "@/components/room/api"
import { Avatar } from "@/components/room/bits"
import { ModelField } from "@/components/room/model-field"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { KINDS, kindOf } from "@/lib/kinds"
import { ago } from "@/lib/status"
import type { PublicAgent, SeatProfile } from "@/lib/types"

const SEAT_PROFILE_EVENT = "bench-seat-profile"

export type SeatProfileOpenDetail = {
  agentId: string
  tab?: "profile" | "rebind"
  fromRunId?: string
}

export function openSeatProfileFor(agentId: string, opts?: { tab?: "profile" | "rebind"; fromRunId?: string }) {
  window.dispatchEvent(
    new CustomEvent<SeatProfileOpenDetail>(SEAT_PROFILE_EVENT, {
      detail: { agentId, tab: opts?.tab ?? "profile", fromRunId: opts?.fromRunId },
    }),
  )
}

function shortPath(dir: string) {
  const home = dir.replace(/^\/home\/[^/]+/, "~")
  return home.length > 52 ? `${home.slice(0, 22)}…${home.slice(-26)}` : home
}

const SPAWNABLE_KINDS = KINDS.filter((item) => item.spawn)

export function SeatProfileDialog({
  agents,
  adapters,
}: {
  agents: PublicAgent[]
  adapters: AdapterInfo[] | null
}) {
  const [target, setTarget] = useState<SeatProfileOpenDetail | null>(null)
  const [tab, setTab] = useState<"profile" | "rebind">("profile")
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)

  // Profile fields
  const [persona, setPersona] = useState("")
  const [memory, setMemory] = useState("")
  const [markdownPath, setMarkdownPath] = useState("")

  // Rebind fields
  const [kind, setKind] = useState<string>("codex")
  const [model, setModel] = useState("")
  const [effort, setEffort] = useState("")
  const [workdir, setWorkdir] = useState("")
  const [editDir, setEditDir] = useState(false)
  const [task, setTask] = useState("")
  const [nowTs, setNowTs] = useState(0)

  const latestProps = useRef({ agents, adapters })
  useEffect(() => {
    latestProps.current = { agents, adapters }
  })

  useEffect(() => {
    let activeReq = 0
    const onOpen = (event: Event) => {
      const detail = (event as CustomEvent<SeatProfileOpenDetail>).detail
      if (!detail?.agentId) return
      const reqId = ++activeReq
      const { agents: curAgents, adapters: curAdapters } = latestProps.current
      const found = curAgents.find((item) => item.id === detail.agentId) ?? null
      const foundKind = found ? kindOf(found)?.id ?? found.agentName : ""
      const installedSet = new Set(
        (curAdapters ?? []).filter((item) => item.installed).map((item) => item.name),
      )
      const candidate =
        SPAWNABLE_KINDS.find((item) => item.id !== foundKind && installedSet.has(item.id)) ??
        SPAWNABLE_KINDS.find((item) => item.id !== foundKind) ??
        SPAWNABLE_KINDS[0]

      setTarget(detail)
      setTab(detail.tab ?? "profile")
      setNowTs(Date.now())
      if (candidate) setKind(candidate.id)
      setModel("")
      setEffort("")
      setTask("")
      setEditDir(false)
      setLoading(true)

      api<{ profile: SeatProfile; markdownPath: string; workdir: string }>(
        `/api/v1/agents/${detail.agentId}?view=profile`,
      )
        .then((data) => {
          if (reqId !== activeReq) return
          setPersona(data.profile?.persona ?? "")
          setMemory(data.profile?.memory ?? "")
          setMarkdownPath(data.markdownPath ?? "")
          setWorkdir(data.workdir ?? "")
        })
        .catch((error) => {
          if (reqId === activeReq) toast.error(error instanceof Error ? error.message : "没读到席位档案")
        })
        .finally(() => {
          if (reqId === activeReq) setLoading(false)
        })
    }
    window.addEventListener(SEAT_PROFILE_EVENT, onOpen)
    return () => {
      activeReq++
      window.removeEventListener(SEAT_PROFILE_EVENT, onOpen)
    }
  }, [])

  const agent = target ? (agents.find((item) => item.id === target.agentId) ?? null) : null
  const currentKind = agent ? kindOf(agent)?.id ?? agent.agentName : ""

  const close = () => {
    if (saving) return
    setTarget(null)
  }

  const saveProfile = async () => {
    if (!agent) return
    setSaving(true)
    try {
      await api(`/api/v1/agents/${agent.id}`, {
        method: "POST",
        body: JSON.stringify({ as: "human", action: "profile", persona, memory }),
      })
      toast.success(`${agent.name} 的席位档案与长期记忆已保存`)
      setTarget(null)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "没存上")
    } finally {
      setSaving(false)
    }
  }

  const doRebind = async () => {
    if (!agent || !kind) return
    setSaving(true)
    try {
      const endpoint = target?.fromRunId ? `/api/v1/runs/${target.fromRunId}` : `/api/v1/agents/${agent.id}`
      const result = await api<{ agent: PublicAgent; resumed?: boolean }>(endpoint, {
        method: "POST",
        body: JSON.stringify({
          as: "human",
          action: "rebind",
          kind,
          model: model || null,
          effort: effort || null,
          workdir: workdir.trim() || undefined,
          task: !target?.fromRunId && task.trim() ? task.trim() : undefined,
        }),
      })
      const label = KINDS.find((item) => item.id === kind)?.label ?? kind
      toast.success(
        result.resumed
          ? `${agent.name} 已切到 ${label}，职责、记忆和没做完的待办交给它了，已叫醒它接着做（不带旧会话的对话）`
          : `${agent.name} 已切到 ${label}，下次 @ 它就会在那边回应`,
      )
      setTarget(null)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "切换客户端没成功")
    } finally {
      setSaving(false)
    }
  }

  const doRestore = async (index: number) => {
    if (!agent) return
    setSaving(true)
    try {
      const res = await api<{ restored: { agentName: string; model: string } }>(`/api/v1/agents/${agent.id}`, {
        method: "POST",
        body: JSON.stringify({ as: "human", action: "restore_binding", index }),
      })
      const label = KINDS.find((item) => item.id === res.restored.agentName)?.label ?? res.restored.agentName
      toast.success(`${agent.name} 已切回原 ${label} 会话`)
      setTarget(null)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "切回原会话没成功")
    } finally {
      setSaving(false)
    }
  }

  const chosenInfo = KINDS.find((item) => item.id === kind)

  return (
    <Dialog open={Boolean(target && agent)} onOpenChange={(open) => !open && close()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span>{agent?.name}</span>
            <span className="text-xs font-normal text-muted-foreground">
              {agent?.agentName ? `${KINDS.find((k) => k.id === agent.agentName)?.label ?? agent.agentName} · ` : ""}
              {agent?.model}
            </span>
          </DialogTitle>
          <DialogDescription>
            席位身份、负责待办和长期记忆记在房间里，不跟着客户端走。换另一家 AI 顶替时，新客户端拿到一张交接单（职责、长期记忆、名下没做完的待办、被打断的消息），拿不到旧会话里的对话。
          </DialogDescription>
        </DialogHeader>

        <div className="flex rounded-xl bg-muted/70 p-1 text-xs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "profile"}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg py-1.5 font-medium transition-colors ${
              tab === "profile" ? "bg-background text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground"
            }`}
            onClick={() => setTab("profile")}
          >
            <BookOpen className="size-3.5" />
            席位档案与长期记忆
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "rebind"}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg py-1.5 font-medium transition-colors ${
              tab === "rebind" ? "bg-background text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground"
            }`}
            onClick={() => setTab("rebind")}
          >
            <ArrowRightLeft className="size-3.5" />
            切换客户端 / 顶替接力
          </button>
        </div>

        {tab === "profile" ? (
          <div className="min-w-0 space-y-3.5">
            {loading ? (
              <p className="flex items-center gap-2 py-6 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" />
                正在读取席位档案…
              </p>
            ) : (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor="seat-persona">职责与规范（每次新会话或换客户端时自动注入）</Label>
                  <Textarea
                    id="seat-persona"
                    value={persona}
                    onChange={(event) => setPersona(event.target.value)}
                    placeholder="比如：负责后端与数据库，改动前先跑单测，保持零外部依赖…"
                    className="min-h-20 text-xs leading-5"
                    maxLength={2000}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="seat-memory">
                    长期记忆与踩坑备忘（AI 可通过 bench_memory 自主追加，你也可直接修订）
                  </Label>
                  <Textarea
                    id="seat-memory"
                    value={memory}
                    onChange={(event) => setMemory(event.target.value)}
                    placeholder="暂无长期记忆。工作中学到的关键约定和踩坑结论会记在这里。"
                    className="min-h-28 font-mono text-xs leading-5"
                    maxLength={4000}
                  />
                </div>
                {markdownPath ? (
                  <p className="truncate text-[11px] text-muted-foreground" title={markdownPath}>
                    写出的 Markdown 副本（只供查看，改它不会改回房间）：<span className="font-mono">{shortPath(markdownPath)}</span>
                  </p>
                ) : null}
              </>
            )}
            <DialogFooter>
              <Button type="button" variant="ghost" disabled={saving} onClick={close}>
                取消
              </Button>
              <Button type="button" disabled={saving || loading} onClick={() => void saveProfile()}>
                {saving ? <Loader2 className="animate-spin" /> : null}
                保存档案
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="min-w-0 space-y-3.5">
            {target?.fromRunId ? (
              <div className="rounded-xl border border-amber-500/30 bg-amber-500/[0.08] px-3 py-2 text-xs leading-5 text-amber-900 dark:text-amber-200">
                新客户端会接过刚才被额度打断的消息、席位名下的待办步骤以及长期记忆，建好会话后立刻接着做。
              </div>
            ) : null}

            <div className="space-y-1.5">
              <Label>换哪一家客户端顶上</Label>
              <div className="grid grid-cols-4 gap-1.5 sm:grid-cols-4" role="radiogroup" aria-label="目标客户端">
                {SPAWNABLE_KINDS.map((item) => {
                  const selected = kind === item.id
                  const isCurrent = currentKind === item.id
                  const adapter = adapters?.find((a) => a.name === item.id)
                  const missing = Boolean(adapter && !adapter.installed)
                  return (
                    <button
                      key={item.id}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      title={
                        missing
                          ? `${item.label}（本机还没装命令行）`
                          : isCurrent
                            ? `${item.label}（当前客户端，选它会新开一个同客户端会话）`
                            : `切到 ${item.label}`
                      }
                      className={`flex flex-col items-center gap-1 rounded-xl border px-2 py-2 text-xs transition-colors ${
                        selected
                          ? "border-primary bg-primary/8 text-foreground"
                          : "text-muted-foreground hover:bg-muted"
                      } ${missing ? "opacity-50" : ""}`}
                      onClick={() => {
                        setKind(item.id)
                        setModel("")
                        setEffort("")
                      }}
                    >
                      <Avatar name={item.label} color={item.color} kind={item} size="sm" />
                      <span className="truncate font-medium">{item.label}</span>
                      {isCurrent ? (
                        <span className="text-[10px] leading-none text-muted-foreground">当前</span>
                      ) : missing ? (
                        <span className="text-[10px] leading-none text-amber-600 dark:text-amber-400">未装</span>
                      ) : null}
                    </button>
                  )
                })}
              </div>
            </div>

            <ModelField
              kind={kind}
              value={model}
              onChange={setModel}
              effort={effort}
              onEffort={setEffort}
              id="rebind-model"
            />

            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <Label className="text-xs">继承工作目录</Label>
                <button
                  type="button"
                  className="text-[11px] text-muted-foreground hover:text-foreground"
                  onClick={() => setEditDir((v) => !v)}
                >
                  {editDir ? "收起" : "修改目录"}
                </button>
              </div>
              {editDir ? (
                <Input
                  value={workdir}
                  onChange={(event) => setWorkdir(event.target.value)}
                  placeholder="/home/you/project"
                  className="font-mono text-xs"
                />
              ) : (
                <p className="flex items-center gap-1.5 truncate rounded-lg bg-muted px-2.5 py-1.5 font-mono text-xs" title={workdir}>
                  <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">{workdir ? shortPath(workdir) : "默认项目目录"}</span>
                </p>
              )}
            </div>

            {!target?.fromRunId ? (
              <div className="space-y-1.5">
                <Label htmlFor="rebind-task">切换后顺带交代一句（可不填）</Label>
                <Input
                  id="rebind-task"
                  value={task}
                  onChange={(event) => setTask(event.target.value)}
                  placeholder="填了会立刻 @ 它开工；不填就先切过去，等你在群里点名"
                  className="text-xs"
                />
              </div>
            ) : null}

            {agent?.previousBindings && agent.previousBindings.length > 0 ? (
              <div className="space-y-1.5 rounded-xl border bg-muted/30 p-2.5">
                <p className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                  <History className="size-3.5" />
                  历史绑定会话（原账号额度恢复后可一键切回）
                </p>
                <div className="space-y-1">
                  {agent.previousBindings.map((b) => {
                    const bKind = KINDS.find((item) => item.id === b.agentName)
                    return (
                      <div key={`${b.agentName}-${b.index}`} className="flex items-center justify-between gap-2 rounded-lg px-1.5 py-1 text-xs hover:bg-muted/70">
                        <span className="min-w-0 truncate">
                          <span className="font-medium">{bKind?.label ?? b.agentName}</span>
                          <span className="text-muted-foreground"> · {b.model} · {ago(b.switchedAt, nowTs)}</span>
                        </span>
                        <Button
                          type="button"
                          size="xs"
                          variant="outline"
                          disabled={saving}
                          onClick={() => void doRestore(b.index)}
                        >
                          <RotateCcw className="size-3" />
                          切回
                        </Button>
                      </div>
                    )
                  })}
                </div>
              </div>
            ) : null}

            <DialogFooter>
              <Button type="button" variant="ghost" disabled={saving} onClick={close}>
                取消
              </Button>
              <Button type="button" disabled={saving || !kind} onClick={() => void doRebind()}>
                {saving ? <Loader2 className="animate-spin" /> : <ArrowRightLeft className="size-3.5" />}
                {saving
                  ? `正在开 ${chosenInfo?.label ?? kind} 会话…`
                  : target?.fromRunId
                    ? `换 ${chosenInfo?.label ?? kind} 立刻接着做`
                    : `切换到 ${chosenInfo?.label ?? kind}`}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
