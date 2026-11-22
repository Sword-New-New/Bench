"use client"

import { useEffect, useState } from "react"
import { FolderGit2, FolderOpen, FolderSearch, Folders, FolderTree, Loader2 } from "lucide-react"
import { toast } from "sonner"

import { AdvancedSection } from "@/components/room/advanced"
import { api } from "@/components/room/api"
import { usePathPicker } from "@/components/room/folder-picker"
import { ModelField, NO_LIMITS, type Limits } from "@/components/room/model-field"
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
import { asksOnPage, KINDS } from "@/lib/kinds"
import type { PublicAgent } from "@/lib/types"

type Workspace = { label: string; path: string; git: boolean }
type Mode = "same" | "worktree" | "temp" | "path"

// Opened for a particular job (the front desk, components/room/front.tsx):
// the name, 分工 and workspace it starts with, and the kinds to choose from
// right in the dialog (no kind picked beforehand).
export type SpawnPreset = { name: string; role: string; mode: Mode; kinds: string[]; title: string; note: string }

const MODES: { id: Mode; label: string; hint: string; icon: typeof Folders }[] = [
  { id: "same", label: "同目录", hint: "共用项目目录", icon: Folders },
  { id: "worktree", label: "新分支", hint: "签出独立 worktree 与分支", icon: FolderGit2 },
  { id: "temp", label: "临时目录", hint: "新建隔离空目录", icon: FolderTree },
  { id: "path", label: "指定目录", hint: "手动选择目录", icon: FolderOpen },
]

// Long folders read better with the home folder as ~ and the middle cut.
function short(dir: string) {
  const home = dir.replace(/^\/home\/[^/]+/, "~")
  return home.length > 48 ? `${home.slice(0, 20)}…${home.slice(-26)}` : home
}

const AUTO_FULL_KEY = "bench-spawn-auto-full"

// 「开新会话」: by default asks only the seat name (plus kind chips for a preset)
// and shows a one-line summary of the working folder; role, model, effort,
// context limits, workspace choice, first task and auto-full stay in 「高级」.
export function SpawnDialog({
  kind,
  from,
  agents,
  onClose,
  preset,
  onKind,
}: {
  kind: string | null
  from: PublicAgent | null
  agents: PublicAgent[]
  onClose: () => void
  preset?: SpawnPreset | null
  // With a preset: another kind picked in the dialog.
  onKind?: (kind: string) => void
}) {
  const info = KINDS.find((item) => item.id === kind)
  const [spaces, setSpaces] = useState<Workspace[] | null>(null)
  const [name, setName] = useState("")
  const [role, setRole] = useState("")
  const [task, setTask] = useState("")
  const [model, setModel] = useState("")
  const [effort, setEffort] = useState("")
  const [limits, setLimits] = useState<Limits>(NO_LIMITS)
  const [mode, setMode] = useState<Mode>("same")
  const [base, setBase] = useState<Workspace | null>(null)
  const [typed, setTyped] = useState("")
  const picker = usePathPicker(kind !== null)
  const [sending, setSending] = useState(false)
  const [advOpen, setAdvOpen] = useState(false)
  // 「默认给全权」: the last choice, kept in this browser; off at first.
  const [autoFull, setAutoFull] = useState(() => {
    try {
      return localStorage.getItem(AUTO_FULL_KEY) === "on"
    } catch {
      return false
    }
  })
  // Only Claude Code's and Codex's permission prompts come to the page (lib/kinds.ts).
  const permitsOnPage = asksOnPage(kind)

  // Fresh fields each time it opens.
  const [shown, setShown] = useState<string | null>(null)
  const key = kind ? `${kind}:${from?.id ?? ""}:${preset ? "preset" : ""}` : null
  // Switching kinds inside a preset dialog keeps what was typed.
  const sameOpening = Boolean(preset && shown && key && shown.split(":").slice(1).join(":") === key.split(":").slice(1).join(":"))
  if (key !== shown) {
    setShown(key)
    setModel("")
    setEffort("")
    setLimits(NO_LIMITS)
    if (sameOpening) {
      // Only the model goes: it belongs to the kind.
    } else if (preset) {
      setAdvOpen(false)
      setSpaces(null)
      setTask("")
      setTyped("")
      setRole(preset.role)
      setMode(preset.mode)
      setName(preset.name)
    } else {
      setAdvOpen(false)
      setSpaces(null)
      setRole("")
      setTask("")
      setMode("same")
      setTyped("")
    }
    if (info && !preset) {
      const taken = new Set(agents.map((agent) => agent.name))
      let candidate = info.label
      if (taken.has(candidate)) {
        let n = 2
        while (taken.has(`${info.label}${n}`)) n += 1
        candidate = `${info.label}${n}`
      }
      setName(candidate)
    }
  }

  useEffect(() => {
    if (!kind) return
    let stop = false
    api<{ workspaces: Workspace[] }>("/api/v1/sessions")
      .then((data) => {
        if (stop) return
        setSpaces(data.workspaces)
        const mine = from ? data.workspaces.find((item) => item.label.split("、").includes(from.name)) : undefined
        const home = data.workspaces.find((item) => item.label.split("、")[0] === "项目目录")
        const pick = mine ?? home ?? null
        setBase(pick)
        // A project with no folder set defaults to a scratch folder instead of
        // stopping on an empty path input with a disabled 「创建」 button.
        if (!pick && !preset) setMode("temp")
      })
      .catch(() => {
        if (stop) return
        setSpaces([])
        if (!preset) setMode("temp")
      })
    return () => {
      stop = true
    }
  }, [kind, from, preset])

  const folder = mode === "path" ? typed.trim() : (base?.path ?? "")
  const blocked = mode === "worktree" && base !== null && !base.git
  const noFolder = spaces !== null && base === null
  const ready = Boolean(name.trim() && (mode === "temp" || folder) && !blocked && !sending)

  const folderSummary =
    spaces === null && mode !== "temp" && mode !== "path"
      ? "正在确认工作目录…"
      : mode === "temp"
        ? `将在新建的临时文件夹里工作${noFolder ? "（当前项目未设目录）" : ""}，用后需手动清理。`
        : mode === "worktree" && base
          ? `将在 ${short(base.path)} 旁新建独立分支目录里工作。`
          : mode === "path"
            ? typed.trim()
              ? `将在 ${short(typed.trim())} 里工作。`
              : "未填指定目录：请在「高级」里选择或填写。"
            : base
              ? `将在 ${short(base.path)} 里工作${from ? `（与 ${from.name} 同目录）` : ""}。`
              : "将在新建的临时文件夹里工作，用后需手动清理。"

  // The desktop's own folder picker, opened by the room (with in-page fallback).
  const browse = async () => {
    const picked = await picker.browse({ start: typed.trim() || base?.path || "" })
    if (picked?.[0]) setTyped(picked[0])
  }

  const create = async () => {
    if (!ready || !kind) return
    setSending(true)
    try {
      const result = await api<{ agent: PublicAgent; dir: string; branch?: string }>("/api/v1/sessions", {
        method: "POST",
        body: JSON.stringify({
          as: "human",
          kind,
          name: name.trim(),
          role: role.trim(),
          task: task.trim(),
          model: model || null,
          effort: effort || null,
          window: limits.window ? Number(limits.window) : null,
          compactPct: limits.pct,
          workspace: { mode, path: folder },
          autoFull: permitsOnPage && autoFull,
        }),
      })
      const shownName = result.agent.name.length > 10 ? `${result.agent.name.slice(0, 9)}…` : result.agent.name
      toast.success(`${shownName} 已入座`)
      onClose()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "新建会话失败")
    } finally {
      setSending(false)
    }
  }

  return (
    <Dialog open={kind !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span>{preset ? preset.title : "开新会话"}</span>
            {!preset && info ? <span className="text-xs font-normal text-muted-foreground">{info.label}</span> : null}
          </DialogTitle>
          <DialogDescription>
            {preset
              ? preset.note
              : kind && kind !== "claude" && kind !== "cursor"
                ? "后台建好会话并入座（约十余秒），之后直接 @ 它。"
                : "后台建好会话直接入座，首次点名时启动。"}
          </DialogDescription>
        </DialogHeader>
        <form
          className="min-w-0 space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            void create()
          }}
        >
          {preset ? (
            <div className="space-y-1.5">
              <Label>选客户端</Label>
              <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="选客户端">
                {preset.kinds.map((id) => {
                  const item = KINDS.find((entry) => entry.id === id)
                  if (!item) return null
                  const on = id === kind
                  return (
                    <button
                      key={id}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors ${
                        on ? "border-primary bg-primary/8 text-foreground" : "text-muted-foreground hover:bg-muted"
                      }`}
                      onClick={() => onKind?.(id)}
                    >
                      <span className="size-2 rounded-full" style={{ background: item.color }} aria-hidden="true" />
                      {item.label}
                    </button>
                  )
                })}
              </div>
            </div>
          ) : null}

          <div className="space-y-1.5">
            <Label htmlFor="spawn-name">名字</Label>
            <Input id="spawn-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={24} />
            <p className={`text-xs leading-5 ${blocked ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground"}`}>
              {blocked ? "所选目录不在 Git 仓库中，请在「高级」里改选工作区。" : folderSummary}
            </p>
          </div>

          <AdvancedSection open={advOpen} onToggle={() => setAdvOpen((v) => !v)}>
            <div className="space-y-1.5">
              <Label htmlFor="spawn-role">分工</Label>
              <Input id="spawn-role" value={role} onChange={(event) => setRole(event.target.value)} placeholder="如：写测试" maxLength={24} />
            </div>

            <ModelField
              kind={kind}
              value={model}
              onChange={setModel}
              effort={effort}
              onEffort={setEffort}
              limits={limits}
              onLimits={setLimits}
              id="spawn-model"
              advancedMode="inline"
            />

            <div className="space-y-1.5">
              <Label>工作区</Label>
              <div className="grid grid-cols-4 gap-1.5" role="radiogroup" aria-label="工作区">
                {MODES.map((item) => {
                  const Icon = item.icon
                  const on = mode === item.id
                  const off = (item.id === "same" || item.id === "worktree") && noFolder
                  return (
                    <button
                      key={item.id}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      disabled={off}
                      title={off ? "项目未设目录" : item.hint}
                      className={`flex flex-col items-center gap-1 rounded-xl border px-2 py-2 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                        on ? "border-primary bg-primary/8 text-foreground" : "text-muted-foreground enabled:hover:bg-muted"
                      }`}
                      onClick={() => setMode(item.id)}
                    >
                      <Icon className="size-4" />
                      {item.label}
                    </button>
                  )
                })}
              </div>
              {mode === "path" ? (
                <div className="flex gap-2">
                  <Input
                    value={typed}
                    onChange={(event) => setTyped(event.target.value)}
                    placeholder="/home/you/project"
                    aria-label="工作目录"
                    className="min-w-0 flex-1 font-mono text-xs"
                  />
                  <Button type="button" variant="outline" className="shrink-0" disabled={picker.browsing} onClick={browse}>
                    {picker.browsing ? <Loader2 className="animate-spin" /> : <FolderSearch />}
                    {picker.browsing ? "选择中…" : "浏览"}
                  </Button>
                </div>
              ) : mode === "temp" ? null : spaces === null ? (
                <p className="flex items-center gap-1.5 py-1 text-xs text-muted-foreground">
                  <Loader2 className="size-3 animate-spin" />
                  查找目录中…
                </p>
              ) : base ? (
                <p className="truncate rounded-lg bg-muted px-2.5 py-1.5 font-mono text-xs" title={base.path}>
                  {short(base.path)}
                  {from && mode === "same" ? <span className="font-sans text-muted-foreground">（与 {from.name} 同目录）</span> : null}
                </p>
              ) : null}
              <p className={`text-[0.6875rem] leading-4 ${blocked ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground"}`}>
                {noFolder && mode !== "temp" && mode !== "path"
                  ? "项目未设目录，请选临时目录或指定目录。"
                  : blocked
                    ? "该目录不在 Git 仓库中，无法开新分支。"
                    : mode === "worktree"
                      ? "在仓库旁新建目录与 bench/… 分支，做完需手动合并并另装依赖。"
                      : mode === "same"
                        ? "多人同改一份代码易互相覆盖，同一阶段只留一人改。"
                        : mode === "temp"
                          ? "在 ~/.local/share/bench/scratch 新建空目录，不碰项目代码，结束后需手动清理。"
                          : "填已有目录，或点「浏览」选择。"}
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="spawn-task">首条交代（选填）</Label>
              <Textarea
                id="spawn-task"
                value={task}
                onChange={(event) => setTask(event.target.value)}
                placeholder="填了会以你的名义 @ 它；不填则先入座待命"
                className="min-h-20 text-sm"
              />
            </div>

            {permitsOnPage ? (
              <label className="flex cursor-pointer items-start gap-2.5 rounded-xl bg-foreground/[0.04] px-3 py-2.5 ring-1 ring-foreground/[0.06]">
                <input
                  type="checkbox"
                  checked={autoFull}
                  onChange={(event) => {
                    setAutoFull(event.target.checked)
                    try {
                      localStorage.setItem(AUTO_FULL_KEY, event.target.checked ? "on" : "off")
                    } catch {}
                  }}
                  className="mt-0.5 size-4 shrink-0 accent-primary"
                />
                <span className="space-y-0.5">
                  <span className="block text-sm font-medium">默认给全权</span>
                  <span className="block text-xs leading-5 text-muted-foreground">
                    每次叫醒直接跑命令、改文件，不再逐条确认（随时可在菜单关闭，sudo 仍需手输）。
                  </span>
                </span>
              </label>
            ) : null}
          </AdvancedSection>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              取消
            </Button>
            <Button type="submit" disabled={!ready}>
              {sending ? <Loader2 className="animate-spin" /> : null}
              {sending ? "创建中…" : "创建"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
      {picker.dialog}
    </Dialog>
  )
}
