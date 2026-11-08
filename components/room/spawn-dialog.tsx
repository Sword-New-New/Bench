"use client"

import { useEffect, useState } from "react"
import { FolderGit2, FolderOpen, Folders, Loader2 } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/components/room/api"
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { KINDS } from "@/lib/kinds"
import type { PublicAgent } from "@/lib/types"

type Workspace = { label: string; path: string; git: boolean }
type Mode = "same" | "worktree" | "path"

const MODES: { id: Mode; label: string; hint: string; icon: typeof Folders }[] = [
  { id: "same", label: "同一个目录", hint: "和那个席位改同一份代码", icon: Folders },
  { id: "worktree", label: "新 worktree", hint: "从同一个仓库再签出一份，用自己的分支", icon: FolderGit2 },
  { id: "path", label: "自己填", hint: "放在你指定的目录里", icon: FolderOpen },
]

// Long folders read better with the home folder as ~ and the middle cut.
function short(dir: string) {
  const home = dir.replace(/^\/home\/[^/]+/, "~")
  return home.length > 48 ? `${home.slice(0, 20)}…${home.slice(-26)}` : home
}

// 「开新会话」: pick a name, a folder and maybe a first task; the room creates
// the session and seats it. `from` is the seat whose folder is picked first.
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
  const [mode, setMode] = useState<Mode>("same")
  const [base, setBase] = useState("")
  const [typed, setTyped] = useState("")
  const [sending, setSending] = useState(false)

  // Fresh fields each time it opens.
  const [shown, setShown] = useState<string | null>(null)
  const key = kind ? `${kind}:${from?.id ?? ""}` : null
  if (key !== shown) {
    setShown(key)
    setSpaces(null)
    setRole("")
    setTask("")
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
        setBase((mine ?? data.workspaces[0])?.path ?? "")
      })
      .catch(() => !stop && setSpaces([]))
    return () => {
      stop = true
    }
  }, [kind, from])

  const picked = spaces?.find((item) => item.path === base)
  const folder = mode === "path" ? typed.trim() : base
  const blocked = mode === "worktree" && picked !== undefined && !picked.git
  const ready = Boolean(name.trim() && folder && !blocked && !sending)

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
          workspace: { mode, path: folder },
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

  const items = (spaces ?? []).map((item) => ({ value: item.path, label: `${item.label} · ${short(item.path)}` }))

  return (
    <Dialog open={kind !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>开一个新的 {info?.label} 会话</DialogTitle>
          <DialogDescription>房间在后台建好会话，直接入座。第一次被点名时它才真正开始，之后和别的席位一样 @ 它就行。</DialogDescription>
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

          <div className="space-y-1.5">
            <Label>工作区</Label>
            <div className="grid grid-cols-3 gap-1.5" role="radiogroup" aria-label="工作区">
              {MODES.map((item) => {
                const Icon = item.icon
                const on = mode === item.id
                return (
                  <button
                    key={item.id}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    title={item.hint}
                    className={`flex flex-col items-center gap-1 rounded-xl border px-2 py-2 text-xs transition-colors ${
                      on ? "border-primary bg-primary/8 text-foreground" : "text-muted-foreground hover:bg-muted"
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
              <Input
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
                placeholder="/home/you/project"
                aria-label="工作目录"
                className="font-mono text-xs"
              />
            ) : spaces === null ? (
              <p className="flex items-center gap-1.5 py-1 text-xs text-muted-foreground">
                <Loader2 className="size-3 animate-spin" />
                正在找各席位的目录…
              </p>
            ) : (
              <Select items={items} value={base} onValueChange={(value) => setBase(value ?? "")}>
                <SelectTrigger className="w-full min-w-0 text-xs" aria-label={mode === "worktree" ? "从哪个仓库开" : "和谁同一个目录"}>
                  <SelectValue placeholder="选一个目录" className="truncate" />
                </SelectTrigger>
                <SelectContent>
                  {items.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <p className={`text-[11px] leading-4 ${blocked ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground"}`}>
              {blocked
                ? "这个目录不在 git 仓库里，没法开 worktree。"
                : mode === "worktree"
                  ? "会在仓库旁边新建一个目录和 bench/… 分支，做完要你自己合回去；依赖要在那边另装。"
                  : mode === "same"
                    ? "两个会话同时改同一份代码会互相覆盖，同一阶段最好只留一个人改。"
                    : "目录要已经存在。"}
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

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              取消
            </Button>
            <Button type="submit" disabled={!ready}>
              {sending ? <Loader2 className="animate-spin" /> : null}
              开出来
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
