"use client"

import { useEffect, useState } from "react"
import { FolderGit2, FolderOpen, FolderSearch, Folders, FolderTree, Loader2 } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/components/room/api"
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
import { KINDS } from "@/lib/kinds"
import type { PublicAgent } from "@/lib/types"

type Workspace = { label: string; path: string; git: boolean }
type Mode = "same" | "worktree" | "temp" | "path"

const MODES: { id: Mode; label: string; hint: string; icon: typeof Folders }[] = [
  { id: "same", label: "同一个目录", hint: "在项目目录里，和别的席位改同一份代码", icon: Folders },
  { id: "worktree", label: "新 worktree", hint: "从项目目录的仓库再签出一份，用自己的分支", icon: FolderGit2 },
  { id: "temp", label: "临时目录", hint: "不在项目里干活，房间给它新建一个空文件夹", icon: FolderTree },
  { id: "path", label: "自己填", hint: "放在你指定的目录里", icon: FolderOpen },
]

// Long folders read better with the home folder as ~ and the middle cut.
function short(dir: string) {
  const home = dir.replace(/^\/home\/[^/]+/, "~")
  return home.length > 48 ? `${home.slice(0, 20)}…${home.slice(-26)}` : home
}

const AUTO_FULL_KEY = "bench-spawn-auto-full"

// 「开新会话」: pick a name, a folder and maybe a first task; the room creates
// the session and seats it. The folder goes with the project (its folder in
// the project settings); opened from a seat's menu (`from`), with that seat's.
// No list of who works where: the room is per project, not per bot.
export function SpawnDialog({
  kind,
  from,
  agents,
  onClose,
}: {
  kind: string | null
  from: PublicAgent | null
  agents: PublicAgent[]
  onClose: () => void
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
  const [browsing, setBrowsing] = useState(false)
  const [sending, setSending] = useState(false)
  // 「默认开启全部权限」: the last choice, kept in this browser; off at first.
  const [autoFull, setAutoFull] = useState(() => {
    try {
      return localStorage.getItem(AUTO_FULL_KEY) === "on"
    } catch {
      return false
    }
  })
  // Only Claude Code's permission prompts come to the page (lib/permits.ts).
  const asksOnPage = kind === "claude"

  // Fresh fields each time it opens.
  const [shown, setShown] = useState<string | null>(null)
  const key = kind ? `${kind}:${from?.id ?? ""}` : null
  if (key !== shown) {
    setShown(key)
    setSpaces(null)
    setRole("")
    setTask("")
    setModel("")
    setEffort("")
    setLimits(NO_LIMITS)
    setMode("same")
    setTyped("")
    if (info) {
      const taken = new Set(agents.map((agent) => agent.name))
      let n = 2
      while (taken.has(`${info.label}${n}`)) n += 1
      setName(`${info.label}${n}`)
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
        // A project with no folder set: only a folder typed in will do.
        if (!pick) setMode("path")
      })
      .catch(() => !stop && setSpaces([]))
    return () => {
      stop = true
    }
  }, [kind, from])

  const folder = mode === "path" ? typed.trim() : (base?.path ?? "")
  const blocked = mode === "worktree" && base !== null && !base.git
  const noFolder = spaces !== null && base === null
  const ready = Boolean(name.trim() && (mode === "temp" || folder) && !blocked && !sending)

  // The desktop's own folder picker, opened by the room (a page never gets a
  // folder's full path itself).
  const browse = async () => {
    setBrowsing(true)
    try {
      const result = await api<{ dir: string | null }>("/api/v1/folder", {
        method: "POST",
        body: JSON.stringify({ as: "human", start: typed.trim() || base?.path || "" }),
      })
      if (result.dir) setTyped(result.dir)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "没打开选目录的窗口")
    } finally {
      setBrowsing(false)
    }
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
          autoFull: asksOnPage && autoFull,
        }),
      })
      toast.success(`${result.agent.name} 入座了`, {
        description: result.branch ? `在 ${result.dir}（分支 ${result.branch}）` : `在 ${result.dir}`,
      })
      onClose()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "没开出来")
    } finally {
      setSending(false)
    }
  }

  return (
    <Dialog open={kind !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>开一个新的 {info?.label} 会话</DialogTitle>
          <DialogDescription>
            {kind && kind !== "claude" && kind !== "cursor"
              ? `房间在后台用 ${{ dsh: "dsh-agent", antigravity: "agy", codex: "codex" }[kind] ?? "codebuddy"} 建好会话并入座，要等十几秒。之后和别的席位一样 @ 它就行。`
              : "房间在后台建好会话，直接入座。第一次被点名时它才真正开始，之后和别的席位一样 @ 它就行。"}
          </DialogDescription>
        </DialogHeader>
        <form
          className="min-w-0 space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            void create()
          }}
        >
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="spawn-name">名字</Label>
              <Input id="spawn-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={24} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="spawn-role">分工</Label>
              <Input id="spawn-role" value={role} onChange={(event) => setRole(event.target.value)} placeholder="比如：写测试" maxLength={24} />
            </div>
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
                    title={off ? "这个项目没设目录" : item.hint}
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
                <Button type="button" variant="outline" className="shrink-0" disabled={browsing} onClick={browse}>
                  {browsing ? <Loader2 className="animate-spin" /> : <FolderSearch />}
                  {browsing ? "在选…" : "浏览…"}
                </Button>
              </div>
            ) : mode === "temp" ? null : spaces === null ? (
              <p className="flex items-center gap-1.5 py-1 text-xs text-muted-foreground">
                <Loader2 className="size-3 animate-spin" />
                正在找项目目录…
              </p>
            ) : base ? (
              <p className="truncate rounded-lg bg-muted px-2.5 py-1.5 font-mono text-xs" title={base.path}>
                {short(base.path)}
                {from && mode === "same" ? <span className="font-sans text-muted-foreground">（和 {from.name} 同一个）</span> : null}
              </p>
            ) : null}
            <p className={`text-[11px] leading-4 ${blocked ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground"}`}>
              {noFolder && mode !== "temp" && mode !== "path"
                ? "这个项目没设目录：在项目设置里填一个，或者选临时目录、自己填。"
                : blocked
                  ? "这个目录不在 git 仓库里，没法开 worktree。"
                  : mode === "worktree"
                    ? "会在仓库旁边新建一个目录和 bench/… 分支，做完要你自己合回去；依赖要在那边另装。"
                    : mode === "same"
                      ? "两个会话同时改同一份代码会互相覆盖，同一阶段最好只留一个人改。"
                      : mode === "temp"
                        ? "房间在 ~/.local/share/bench/scratch 下给它新建一个空文件夹，碰不到项目里的代码；它照常坐在这个项目里聊天。会话结束后文件夹留着，要你自己清理。"
                        : "目录要已经存在。点「浏览…」在这台电脑上选。"}
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="spawn-task">交给它的第一件事（可不填）</Label>
            <Textarea
              id="spawn-task"
              value={task}
              onChange={(event) => setTask(event.target.value)}
              placeholder="会以你的名义在群里 @ 它；不填就先坐着，等你点名"
              className="min-h-20 text-sm"
            />
          </div>

          {asksOnPage ? (
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
                <span className="block text-sm font-medium">默认开启全部权限</span>
                <span className="block text-xs leading-5 text-muted-foreground">
                  每次被叫醒都直接能跑命令、改文件，不再一条条弹出来等你点允许。之后在它的「…」菜单里随时能关。sudo 密码还是只有你能输。
                </span>
              </span>
            </label>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              取消
            </Button>
            <Button type="submit" disabled={!ready}>
              {sending ? <Loader2 className="animate-spin" /> : null}
              {sending ? "在开…" : "开出来"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
