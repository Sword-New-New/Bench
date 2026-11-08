"use client"

import { useState } from "react"
import { Check, ChevronsUpDown, FolderOpen, FolderSearch, Loader2, Plus, Settings2 } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/components/room/api"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import type { Project, ProjectInfo } from "@/lib/types"

// Long folders read better with the home folder as ~ and the middle cut.
export function shortDir(dir: string) {
  const home = dir.replace(/^\/home\/[^/]+/, "~")
  return home.length > 40 ? `${home.slice(0, 16)}…${home.slice(-22)}` : home
}

// The open project's name in the header; the menu switches between projects
// and opens the dialogs for a new one or this one's settings.
export function ProjectMenu({
  projects,
  current,
  onPick,
  onCreate,
  onEdit,
}: {
  projects: Project[]
  current: ProjectInfo | null
  onPick: (id: string) => void
  onCreate: () => void
  onEdit: () => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            className="chip -mx-1.5 flex min-w-0 items-center gap-1 rounded-lg px-1.5 py-0.5 text-left hover:bg-muted/60"
            aria-label="切换项目"
          />
        }
      >
        <span className="min-w-0">
          <span className="block truncate text-[15px] leading-tight font-semibold">{current?.name ?? "并坐"}</span>
          <span className="hidden truncate text-xs text-muted-foreground sm:block">
            {current?.dir ? shortDir(current.dir) : "并坐 · 一个项目一间房"}
          </span>
        </span>
        <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuGroup>
          <DropdownMenuLabel>项目</DropdownMenuLabel>
          {projects.map((project) => (
            <DropdownMenuItem key={project.id} onClick={() => onPick(project.id)} className="items-start gap-2">
              <span className="mt-0.5 size-4 shrink-0">{project.id === current?.id ? <Check className="size-4" /> : null}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{project.name}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {project.seats === 0
                    ? "还没有人入座"
                    : `${project.seats} 个席位 · ${project.online} 在线${project.working ? ` · ${project.working} 在做` : ""}`}
                  {project.dir ? ` · ${shortDir(project.dir)}` : ""}
                </span>
              </span>
              {project.working > 0 ? <span className="mt-1.5 size-1.5 shrink-0 animate-pulse rounded-full bg-sky-500" /> : null}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={onCreate}>
          <Plus />
          新建项目…
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onEdit} disabled={!current}>
          <Settings2 />
          这个项目的设置…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// New project, or the open one's name, folder and deletion. `editing` null is
// a new project.
export function ProjectDialog({
  open,
  editing,
  canDelete,
  onClose,
  onSaved,
  onDeleted,
}: {
  open: boolean
  editing: ProjectInfo | null
  canDelete: boolean
  onClose: () => void
  onSaved: (project: ProjectInfo, created: boolean) => void
  onDeleted: (id: string) => void
}) {
  const [name, setName] = useState("")
  const [dir, setDir] = useState("")
  const [sending, setSending] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [browsing, setBrowsing] = useState(false)

  // Fresh fields each time it opens.
  const [shown, setShown] = useState<string | null>(null)
  const key = open ? (editing?.id ?? "new") : null
  if (key !== shown) {
    setShown(key)
    setName(editing?.name ?? "")
    setDir(editing?.dir ?? "")
    setConfirming(false)
  }

  const save = async () => {
    if (!name.trim() || sending) return
    setSending(true)
    try {
      const body = { as: "human", name: name.trim(), dir: dir.trim() }
      const result = editing
        ? await api<{ project: ProjectInfo }>(`/api/v1/projects/${editing.id}`, {
            method: "POST",
            body: JSON.stringify({ ...body, action: "update" }),
          })
        : await api<{ project: ProjectInfo }>("/api/v1/projects", { method: "POST", body: JSON.stringify(body) })
      onSaved(result.project, !editing)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "没存上")
    } finally {
      setSending(false)
    }
  }

  // The desktop's own folder picker, opened by the room.
  const browse = async () => {
    setBrowsing(true)
    try {
      const result = await api<{ dir: string | null }>("/api/v1/folder", {
        method: "POST",
        body: JSON.stringify({ as: "human", start: dir.trim() }),
      })
      if (result.dir) setDir(result.dir)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "没打开选目录的窗口")
    } finally {
      setBrowsing(false)
    }
  }

  const remove = async () => {
    if (!editing) return
    setSending(true)
    try {
      await api(`/api/v1/projects/${editing.id}`, {
        method: "POST",
        body: JSON.stringify({ as: "human", action: "delete", confirm: "删除" }),
      })
      onDeleted(editing.id)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "没删掉")
    } finally {
      setSending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{editing ? `「${editing.name}」的设置` : "新建项目"}</DialogTitle>
          <DialogDescription>
            每个项目是一间单独的房间：席位、对话、任务和摘要都只在这个项目里。一个会话同一时间只坐在一个项目里。
          </DialogDescription>
        </DialogHeader>
        <form
          className="min-w-0 space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="project-name">名字</Label>
            <Input
              id="project-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="比如：狼人游戏"
              maxLength={24}
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="project-dir">项目目录（可不填）</Label>
            <div className="flex gap-2">
              <div className="relative min-w-0 flex-1">
                <FolderOpen className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="project-dir"
                  value={dir}
                  onChange={(event) => setDir(event.target.value)}
                  placeholder="/home/you/project"
                  className="pl-8 font-mono text-xs"
                />
              </div>
              <Button type="button" variant="outline" className="shrink-0" disabled={browsing} onClick={browse}>
                {browsing ? <Loader2 className="animate-spin" /> : <FolderSearch />}
                {browsing ? "在选…" : "浏览…"}
              </Button>
            </div>
            <p className="text-[11px] leading-4 text-muted-foreground">
              在这个目录里干活的 AI 入座时没说项目名，会自动进这个项目；房间开新会话也默认开在这里。
            </p>
          </div>
          <DialogFooter className="items-center">
            {editing && canDelete ? (
              confirming ? (
                <div className="mr-auto flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">对话、任务和席位都会删掉</span>
                  <Button type="button" variant="destructive" size="sm" disabled={sending} onClick={remove}>
                    确认删除
                  </Button>
                </div>
              ) : (
                <Button type="button" variant="ghost" size="sm" className="mr-auto" onClick={() => setConfirming(true)}>
                  删除项目
                </Button>
              )
            ) : null}
            <Button type="button" variant="ghost" onClick={onClose}>
              取消
            </Button>
            <Button type="submit" disabled={!name.trim() || sending}>
              {sending ? <Loader2 className="animate-spin" /> : null}
              {editing ? "保存" : "建好，去接 AI"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
