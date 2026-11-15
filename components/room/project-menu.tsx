"use client"

import { useEffect, useState } from "react"
import { Check, ChevronsUpDown, ConciergeBell, FolderOpen, FolderSearch, Loader2, Plus, Settings2 } from "lucide-react"
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { Project, ProjectInfo, PublicAgent, RoomSnapshot } from "@/lib/types"

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
  onEnableFront,
}: {
  projects: Project[]
  current: ProjectInfo | null
  onPick: (id: string) => void
  onCreate: () => void
  onEdit: () => void
  // No front desk yet: an item that opens one.
  onEnableFront?: () => void
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
          {/* On xl the project rail already shows the name; the path and the menu stay. */}
          <span className="block truncate text-[0.9375rem] leading-tight font-semibold xl:hidden">{current?.name ?? "并坐"}</span>
          <span className="hidden truncate text-xs text-muted-foreground sm:block">{placeLine(current)}</span>
        </span>
        <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuGroup>
          <DropdownMenuLabel>项目</DropdownMenuLabel>
          {projects.map((project) => (
            <DropdownMenuItem key={project.id} onClick={() => onPick(project.id)} className="items-start gap-2">
              <span className="mt-0.5 size-4 shrink-0">
                {project.id === current?.id ? <Check className="size-4" /> : project.front ? <ConciergeBell className="size-4 text-primary" /> : null}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{project.name}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {project.front
                    ? project.seats === 0
                      ? "无人值班 · 只读"
                      : "跨项目总览 · 只读"
                    : project.seats === 0
                      ? "暂无席位"
                      : `${project.seats} 个席位 · ${project.online} 在线${project.working ? ` · ${project.working} 在做` : ""}`}
                  {project.dir && !project.front ? ` · ${shortDir(project.dir)}` : ""}
                </span>
              </span>
              {project.working > 0 ? <span className="mt-1.5 size-1.5 shrink-0 animate-pulse rounded-full bg-sky-500" /> : null}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        {onEnableFront ? (
          <DropdownMenuItem onClick={onEnableFront}>
            <ConciergeBell />
            开启前台…
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem onClick={onCreate}>
          <Plus />
          新建项目…
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onEdit} disabled={!current}>
          <Settings2 />
          设置项目…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// The header's line from lg, where the project rail has the menu's jobs: the
// name (only until xl, where the rail's cards show it) over the folder.
export function ProjectPlace({ project }: { project: ProjectInfo | null }) {
  return (
    <span className="hidden min-w-0 lg:block" title={project?.dir}>
      <span className="block truncate text-[0.9375rem] leading-tight font-semibold xl:hidden">{project?.name ?? "并坐"}</span>
      <span className="block truncate text-xs text-muted-foreground">{placeLine(project)}</span>
    </span>
  )
}

// Under the name: the folder; for the front desk, what it is for now.
function placeLine(project: ProjectInfo | null) {
  if (project?.front) return "前台 · 只读总览"
  return project?.dir ? shortDir(project.dir) : "并坐"
}

// New project, or the open one's name, folder and deletion. `editing` null is
// a new project.
const NO_CHECK = "none"

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
  // 「请验收时先复验」: the seats to choose from, who checks now, and the pick.
  const [seats, setSeats] = useState<PublicAgent[] | null>(null)
  const [checker, setChecker] = useState(NO_CHECK)
  // 「谁来补摘要句」: the seat that writes gists of long replies, or nobody.
  const [gister, setGister] = useState(NO_CHECK)

  // Fresh fields each time it opens.
  const [shown, setShown] = useState<string | null>(null)
  const key = open ? (editing?.id ?? "new") : null
  if (key !== shown) {
    setShown(key)
    setName(editing?.name ?? "")
    setDir(editing?.dir ?? "")
    setConfirming(false)
    setSeats(null)
    setChecker(NO_CHECK)
    setGister(NO_CHECK)
  }
  const editingId = open ? editing?.id : undefined
  useEffect(() => {
    if (!editingId) return
    let live = true
    api<RoomSnapshot>(`/api/v1/room?project=${encodeURIComponent(editingId)}`)
      .then((room) => {
        if (!live) return
        setSeats(room.agents)
        setChecker(room.agents.find((agent) => agent.checker)?.id ?? NO_CHECK)
        setGister(room.agents.find((agent) => agent.gister)?.id ?? NO_CHECK)
      })
      .catch(() => live && setSeats([]))
    return () => {
      live = false
    }
  }, [editingId])
  const checkerNow = seats?.find((agent) => agent.checker)?.id ?? NO_CHECK
  const gisterNow = seats?.find((agent) => agent.gister)?.id ?? NO_CHECK

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
      if (editing && seats && checker !== checkerNow) {
        const seat = checker === NO_CHECK ? checkerNow : checker
        await api(`/api/v1/agents/${seat}`, {
          method: "POST",
          body: JSON.stringify({ as: "human", action: "checker", on: checker !== NO_CHECK }),
        })
      }
      if (editing && seats && gister !== gisterNow) {
        const seat = gister === NO_CHECK ? gisterNow : gister
        await api(`/api/v1/agents/${seat}`, {
          method: "POST",
          body: JSON.stringify({ as: "human", action: "gister", on: gister !== NO_CHECK }),
        })
      }
      onSaved(result.project, !editing)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存失败")
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
      toast.error(error instanceof Error ? error.message : "打开目录选择失败")
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
      toast.error(error instanceof Error ? error.message : "删除失败")
    } finally {
      setSending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span>{editing ? "项目设置" : "新建项目"}</span>
            {editing ? <span className="text-xs font-normal text-muted-foreground">{editing.name}</span> : null}
          </DialogTitle>
          <DialogDescription>
            每个项目独立保存席位、对话、待办与房间摘要。
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
              placeholder="如：狼人游戏"
              maxLength={24}
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="project-dir">项目目录（选填）</Label>
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
                {browsing ? "选择中…" : "浏览"}
              </Button>
            </div>
            <p className="text-[0.6875rem] leading-4 text-muted-foreground">
              同目录 AI 入座自动归入此项目，后台新开会话也默认在此。
            </p>
          </div>
          {editing && seats?.length ? (
            <div className="space-y-1.5">
              <Label htmlFor="project-checker">验收前复验</Label>
              <Select
                items={[{ value: NO_CHECK, label: "不复验" }, ...seats.map((agent) => ({ value: agent.id, label: `${agent.name} · ${agent.model}` }))]}
                value={checker}
                onValueChange={(next) => setChecker(next ? String(next) : NO_CHECK)}
              >
                <SelectTrigger id="project-checker" className="w-full min-w-0 text-sm">
                  <SelectValue className="truncate" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_CHECK}>不复验</SelectItem>
                  {seats.map((agent) => (
                    <SelectItem key={agent.id} value={agent.id}>
                      {agent.name} · {agent.model}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[0.6875rem] leading-4 text-muted-foreground">
                请验收时先叫醒它后台验一遍（耗一次叫醒额度，选便宜模型；它自己的待办不复验）。
              </p>
            </div>
          ) : null}
          {editing && seats?.length ? (
            <div className="space-y-1.5">
              <Label htmlFor="project-gister">补摘要句</Label>
              <Select
                items={[{ value: NO_CHECK, label: "不用" }, ...seats.map((agent) => ({ value: agent.id, label: `${agent.name} · ${agent.model}` }))]}
                value={gister}
                onValueChange={(next) => setGister(next ? String(next) : NO_CHECK)}
              >
                <SelectTrigger id="project-gister" className="w-full min-w-0 text-sm">
                  <SelectValue className="truncate" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_CHECK}>不用</SelectItem>
                  {seats.map((agent) => (
                    <SelectItem key={agent.id} value={agent.id}>
                      {agent.name} · {agent.model}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[0.6875rem] leading-4 text-muted-foreground">
                长回复首行非结论时，攒几条叫醒它补一句摘要（耗叫醒额度，选便宜模型）。
              </p>
            </div>
          ) : null}
          <DialogFooter className="items-center">
            {editing && canDelete ? (
              confirming ? (
                <div className="mr-auto flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">席位、对话和待办都会删掉</span>
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
              {editing ? "保存" : "创建"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
