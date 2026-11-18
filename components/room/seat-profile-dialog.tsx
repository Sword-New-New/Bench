"use client"

import { useEffect, useRef, useState } from "react"
import { ArrowRightLeft, BookOpen, FolderOpen, History, Loader2, RotateCcw } from "lucide-react"
import { toast } from "sonner"

import { AdvancedSection } from "@/components/room/advanced"
import { api, type AdapterInfo } from "@/components/room/api"
import { Avatar } from "@/components/room/bits"
import { ModelAdvancedFields, ModelField } from "@/components/room/model-field"
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
  const [profileAdvOpen, setProfileAdvOpen] = useState(false)
  const [rebindAdvOpen, setRebindAdvOpen] = useState(false)

  // Profile fields
  const [persona, setPersona] = useState("")
  const [memory, setMemory] = useState("")
  const [markdownPath, setMarkdownPath] = useState("")

  // Rebind fields
  const [kind, setKind] = useState<string>("codex")
  const [model, setModel] = useState("")
  const [customModel, setCustomModel] = useState(false)
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
      setProfileAdvOpen(false)
      setRebindAdvOpen(false)
      setNowTs(Date.now())
      if (candidate) setKind(candidate.id)
      setModel("")
      setCustomModel(false)
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
          if (reqId === activeReq) toast.error(error instanceof Error ? error.message : "读取档案失败")
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
      toast.success("档案已保存")
      setTarget(null)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存失败")
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
      toast.success(result.resumed ? "已切换并接着做" : "已切换客户端")
      setTarget(null)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "切换失败")
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
      toast.success(`已切回 ${label}`)
      setTarget(null)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "切回失败")
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={Boolean(target && agent)} onOpenChange={(open) => !open && close()}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span>席位设置</span>
            <span className="text-xs font-normal text-muted-foreground">
              {agent?.name}
              {agent?.agentName ? ` · ${KINDS.find((k) => k.id === agent.agentName)?.label ?? agent.agentName}` : ""}
              {agent?.model ? ` · ${agent.model}` : ""}
            </span>
          </DialogTitle>
          <DialogDescription>
            分工、待办与长期记忆留在席位上；换客户端只交接这些，不带旧会话聊天记录。
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
            档案与记忆
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
            换客户端
          </button>
        </div>

        {tab === "profile" ? (
          <div className="min-w-0 space-y-3.5">
            {loading ? (
              <p className="flex items-center gap-2 py-6 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" />
                读取中…
              </p>
            ) : (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor="seat-persona">分工（新会话或换客户端时自动注入）</Label>
                  <Textarea
                    id="seat-persona"
                    value={persona}
                    onChange={(event) => setPersona(event.target.value)}
                    placeholder="如：负责后端与数据库，改动前先跑单测，保持零外部依赖…"
                    className="min-h-20 text-xs leading-5"
                    maxLength={2000}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="seat-memory">长期记忆（AI 可记录经验，也可手改）</Label>
                  <Textarea
                    id="seat-memory"
                    value={memory}
                    onChange={(event) => setMemory(event.target.value)}
                    placeholder="工作中学到的约定与踩坑结论会记在这里。"
                    className="min-h-28 font-mono text-xs leading-5"
                    maxLength={4000}
                  />
                </div>
                {markdownPath ? (
                  <AdvancedSection open={profileAdvOpen} onToggle={() => setProfileAdvOpen((v) => !v)}>
                    <p className="truncate text-[0.6875rem] text-muted-foreground" title={markdownPath}>
                      只读副本（直接改它无效）：<span className="font-mono">{shortPath(markdownPath)}</span>
                    </p>
                  </AdvancedSection>
                ) : null}
              </>
            )}
            <DialogFooter>
              <Button type="button" variant="ghost" disabled={saving} onClick={close}>
                取消
              </Button>
              <Button type="button" disabled={saving || loading} onClick={() => void saveProfile()}>
                {saving ? <Loader2 className="animate-spin" /> : null}
                保存
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="min-w-0 space-y-3.5">
            {target?.fromRunId ? (
              <div className="rounded-xl border border-amber-500/30 bg-amber-500/[0.08] px-3 py-2 text-xs leading-5 text-amber-900 dark:text-amber-200">
                新客户端会接过被打断的消息、未完待办与长期记忆，建好会话立刻接着做。
              </div>
            ) : null}

            <div className="space-y-1.5">
              <Label>换哪家客户端</Label>
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
                          ? `${item.label} 未装命令行`
                          : isCurrent
                            ? "当前客户端，选中会重开会话"
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
                        setCustomModel(false)
                        setEffort("")
                      }}
                    >
                      <Avatar name={item.label} color={item.color} kind={item} size="sm" />
                      <span className="truncate font-medium">{item.label}</span>
                      {isCurrent ? (
                        <span className="text-[0.625rem] leading-none text-muted-foreground">当前</span>
                      ) : missing ? (
                        <span className="text-[0.625rem] leading-none text-amber-600 dark:text-amber-400">未装</span>
                      ) : null}
                    </button>
                  )
                })}
              </div>
            </div>

            <ModelField
              kind={kind}
              value={model}
              onChange={(next) => {
                setCustomModel(false)
                setModel(next)
              }}
              id="rebind-model"
              advancedMode="external"
            />

            <AdvancedSection
              open={rebindAdvOpen}
              onToggle={() => setRebindAdvOpen((v) => !v)}
              note={agent?.previousBindings?.length ? `${agent.previousBindings.length} 个历史会话` : undefined}
            >
              <ModelAdvancedFields
                kind={kind}
                value={model}
                onChange={setModel}
                customActive={customModel}
                onCustomChange={(next) => {
                  setCustomModel(Boolean(next))
                  setModel(next)
                }}
                effort={effort}
                onEffort={setEffort}
                id="rebind-model"
              />

              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <Label className="text-xs">工作目录</Label>
                  <button
                    type="button"
                    className="text-[0.6875rem] text-muted-foreground hover:text-foreground"
                    onClick={() => setEditDir((v) => !v)}
                  >
                    {editDir ? "收起" : "修改"}
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
                  <Label htmlFor="rebind-task">顺带交代一句（选填）</Label>
                  <Input
                    id="rebind-task"
                    value={task}
                    onChange={(event) => setTask(event.target.value)}
                    placeholder="填了会立刻 @ 它；不填则等你点名"
                    className="text-xs"
                  />
                </div>
              ) : null}

              {agent?.previousBindings && agent.previousBindings.length > 0 ? (
                <div className="space-y-1.5 rounded-xl border bg-muted/30 p-2.5">
                  <p className="flex items-center gap-1.5 text-[0.6875rem] font-medium text-muted-foreground">
                    <History className="size-3.5" />
                    历史会话（原额度恢复后可切回）
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
            </AdvancedSection>

            <DialogFooter>
              <Button type="button" variant="ghost" disabled={saving} onClick={close}>
                取消
              </Button>
              <Button type="button" disabled={saving || !kind} onClick={() => void doRebind()}>
                {saving ? <Loader2 className="animate-spin" /> : <ArrowRightLeft className="size-3.5" />}
                {saving ? "切换中…" : target?.fromRunId ? "立即接手" : "切换"}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
