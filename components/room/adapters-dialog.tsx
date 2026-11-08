"use client"

import { useEffect, useState } from "react"
import { Plus, Trash2 } from "lucide-react"

import { Avatar } from "@/components/room/bits"
import type { AdapterInfo } from "@/components/room/api"
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
import { KINDS, kindById } from "@/lib/kinds"
import type { PublicAgent } from "@/lib/types"

type Row = { name: string; command: string; reply: "stdout" | "none"; installed?: boolean }

export function AdaptersDialog({
  open,
  agents,
  adapters,
  focusName,
  busy,
  onOpenChange,
  onSave,
}: {
  open: boolean
  agents: PublicAgent[]
  adapters: AdapterInfo[] | null
  focusName: string | null
  busy: boolean
  onOpenChange: (open: boolean) => void
  onSave: (agents: Row[]) => Promise<void>
}) {
  const [rows, setRows] = useState<Row[]>([])

  useEffect(() => {
    if (!open) return
    let next: Row[] = [...(adapters ?? [])]
    if (focusName && !next.some((row) => row.name === focusName)) {
      const kind = kindById(focusName)
      next = [{ name: focusName, command: kind?.command ?? "", reply: kind?.reply ?? "none" }, ...next]
    }
    if (next.length === 0) next = KINDS.map((kind) => ({ name: kind.id, command: kind.command, reply: kind.reply }))
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset the form each time it opens
    setRows(next)
  }, [open, focusName, adapters])

  function update(index: number, patch: Partial<Row>) {
    setRows((current) =>
      current.map((row, i) => (i === index ? { ...row, ...patch, installed: patch.command === undefined ? row.installed : undefined } : row)),
    )
  }

  const missing = KINDS.filter((kind) => !rows.some((row) => row.name === kind.id))

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>唤起命令</DialogTitle>
          <DialogDescription>
            每种 agent 一条。被 @ 到时，房间用这条命令唤起他报上来的会话：{"{uuid}"} 换成会话 id，{"{text}"}{" "}
            换成那句话（已加引号）。勾上「输出即回复」，命令打印的内容会作为他的发言贴回房间。
          </DialogDescription>
        </DialogHeader>
        <div className="-mx-1 max-h-[55vh] space-y-2 overflow-y-auto px-1">
          {rows.map((row, index) => {
            const kind = kindById(row.name)
            const using = agents.filter((agent) => !agent.demo && agent.agentName === row.name).map((agent) => agent.name)
            return (
              <div key={index} className="rounded-xl border p-3">
                <div className="flex items-center gap-2">
                  <Avatar name={row.name || "?"} label={kind?.label} color={kind?.color ?? "#9ca3af"} kind={kind} size="sm" />
                  <Input
                    aria-label="agent 名"
                    value={row.name}
                    placeholder="agent 名"
                    className="h-7 w-32 font-mono text-xs"
                    onChange={(event) => update(index, { name: event.target.value })}
                  />
                  <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                    {kind ? `${kind.label} · ${kind.harness}` : ""}
                  </span>
                  {row.installed === false ? (
                    <span className="shrink-0 rounded-full bg-amber-500/12 px-2 py-0.5 text-[10px] text-amber-700 dark:text-amber-300">
                      本机没找到这条命令
                    </span>
                  ) : null}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label="去掉这一条"
                    onClick={() => setRows((current) => current.filter((_, i) => i !== index))}
                  >
                    <Trash2 />
                  </Button>
                </div>
                <Input
                  aria-label={`${row.name || "这个 agent"} 的唤起命令`}
                  value={row.command}
                  placeholder="some-agent resume {uuid} {text}"
                  className="mt-2 font-mono text-xs"
                  autoFocus={Boolean(focusName) && row.name === focusName}
                  onChange={(event) => update(index, { command: event.target.value })}
                />
                <div className="mt-2 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                  <label className="flex shrink-0 items-center gap-1.5 whitespace-nowrap">
                    <input
                      type="checkbox"
                      className="accent-current"
                      checked={row.reply === "stdout"}
                      onChange={(event) => update(index, { reply: event.target.checked ? "stdout" : "none" })}
                    />
                    输出即回复
                  </label>
                  <span className="truncate">{using.length > 0 ? `在用：${using.join("、")}` : ""}</span>
                </div>
              </div>
            )
          })}
        </div>
        <DialogFooter className="gap-2 sm:justify-between">
          <div className="flex flex-wrap gap-1">
            {missing.map((kind) => (
              <Button
                key={kind.id}
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setRows((current) => [...current, { name: kind.id, command: kind.command, reply: kind.reply }])}
              >
                <Plus />
                {kind.label}
              </Button>
            ))}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setRows((current) => [...current, { name: "", command: "", reply: "none" }])}
            >
              <Plus />
              自定义
            </Button>
          </div>
          <Button
            type="button"
            disabled={busy || adapters === null}
            onClick={() => {
              const next = rows
                .map((row) => ({ name: row.name.trim(), command: row.command.trim(), reply: row.reply }))
                .filter((row) => row.name || row.command)
              void onSave(next)
            }}
          >
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
