"use client"

import { useEffect, useState } from "react"

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
import type { PublicAgent } from "@/lib/types"

type Row = { name: string; command: string }

export function AdaptersDialog({
  open,
  agents,
  focusName,
  busy,
  onOpenChange,
  onSave,
}: {
  open: boolean
  agents: PublicAgent[]
  focusName: string | null
  busy: boolean
  onOpenChange: (open: boolean) => void
  onSave: (agents: Row[]) => Promise<void>
}) {
  const [rows, setRows] = useState<Row[]>([])
  const [ready, setReady] = useState(false)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setReady(false)
    void api<{ agents: Row[] }>("/api/v1/adapters")
      .then((data) => {
        if (cancelled) return
        const saved = Array.isArray(data.agents) ? data.agents : []
        let next = [...saved]
        if (focusName && !next.some((row) => row.name === focusName)) {
          next = [{ name: focusName, command: "" }, ...next]
        }
        if (next.length === 0) next = [{ name: "", command: "" }]
        setRows(next)
        setReady(true)
      })
      .catch(() => {
        if (cancelled) return
        setRows([{ name: focusName ?? "", command: "" }])
        setReady(true)
      })
    return () => {
      cancelled = true
    }
  }, [open, focusName])

  function update(index: number, patch: Partial<Row>) {
    setRows((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)))
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>配置唤起</DialogTitle>
          <DialogDescription>
            每种 agent 写一次，以后不用改。名字是他入座时报的 agent，比如 codex、dsh。{"{uuid}"} 换成他报的 uuid，{"{text}"} 换成点到他的那句话。
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[50vh] space-y-3 overflow-y-auto pr-1">
          {rows.map((row, index) => {
            const using = agents
              .filter((agent) => !agent.demo && agent.agentName === row.name)
              .map((agent) => agent.name)
            return (
              <div key={index} className="space-y-1.5 rounded-lg border p-2">
                <div className="flex items-center gap-2">
                  <Input
                    aria-label="agent 名"
                    value={row.name}
                    placeholder="cursor"
                    onChange={(event) => update(index, { name: event.target.value })}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setRows((current) => current.filter((_, i) => i !== index))}
                  >
                    去掉
                  </Button>
                </div>
                <Input
                  aria-label={`${row.name || "这个 agent"}的唤起命令`}
                  value={row.command}
                  placeholder="dsh-agent resume {uuid} {text}"
                  className="font-mono text-xs"
                  autoFocus={Boolean(focusName) && row.name === focusName}
                  onChange={(event) => update(index, { command: event.target.value })}
                />
                {using.length > 0 ? (
                  <p className="text-xs text-muted-foreground">在用：{using.join("、")}</p>
                ) : null}
              </div>
            )
          })}
        </div>
        <DialogFooter className="sm:justify-between">
          <Button
            type="button"
            variant="outline"
            onClick={() => setRows((current) => [...current, { name: "", command: "" }])}
          >
            再加一个
          </Button>
          <Button
            type="button"
            disabled={busy || !ready}
            onClick={() => {
              const agentsToSave = rows
                .map((row) => ({ name: row.name.trim(), command: row.command.trim() }))
                .filter((row) => row.name || row.command)
              void onSave(agentsToSave)
            }}
          >
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
