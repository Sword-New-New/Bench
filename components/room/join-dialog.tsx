"use client"

import { useEffect, useState, useSyncExternalStore } from "react"
import { Check, Copy } from "lucide-react"
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
import { KINDS } from "@/lib/kinds"
import { joinPrompt } from "@/lib/prompt"

const MCP_KINDS = ["claude", "dsh", "codex", "cursor", "antigravity"]

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
      <code className="min-w-0 flex-1 truncate font-mono text-xs" title={text}>
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

export function JoinDialog({
  open,
  busy,
  onOpenChange,
  onReset,
}: {
  open: boolean
  busy: boolean
  onOpenChange: (open: boolean) => void
  onReset: () => void
}) {
  const origin = useSyncExternalStore(subscribeOrigin, readOrigin, serverOrigin)
  const [root, setRoot] = useState("~/Downloads/bench")
  const [confirmReset, setConfirmReset] = useState(false)
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (!open) setConfirmReset(false)
  }

  useEffect(() => {
    if (!open) return
    api<{ root?: string }>("/api/v1/prompt")
      .then((data) => {
        if (data.root) setRoot(data.root)
      })
      .catch(() => {})
  }, [open])

  const prompt = joinPrompt(origin)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>把 AI 接进房间</DialogTitle>
          <DialogDescription>
            每家在终端里运行一次对应的命令（以后不用再做），然后在那个 AI 的新会话里说一句「接入并坐，名字叫 …，分工是 …」。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2.5">
          {KINDS.filter((kind) => MCP_KINDS.includes(kind.id)).map((kind) => (
            <div key={kind.id} className="flex items-center gap-3">
              <Avatar name={kind.label} color={kind.color} kind={kind} size="sm" />
              <div className="w-28 shrink-0">
                <p className="text-sm font-medium leading-tight">{kind.label}</p>
                <p className="truncate text-[11px] text-muted-foreground">{kind.harness}</p>
              </div>
              <div className="min-w-0 flex-1">
                <CopyLine text={`${root}/scripts/register-mcp.sh ${kind.id}`} />
              </div>
            </div>
          ))}
        </div>
        <p className="text-xs leading-5 text-muted-foreground">
          接进来以后，AI 会有 bench_join、bench_inbox、bench_say 等工具。Claude 和 GPT 的会话 id 自动识别；DeepSeek、Grok、Gemini 入座时要自己报一次。会话开着就显示在线，关了就离线，别人 @ 它时房间会去唤起。
        </p>
        <details className="rounded-xl border px-3 py-2">
          <summary className="cursor-pointer text-sm">
            不支持 MCP 的 agent：复制这段说明贴给它
          </summary>
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
        </details>
        <div className="flex items-center justify-between gap-2 border-t pt-3">
          <span className="text-xs text-muted-foreground">房间地址 {origin}</span>
          {confirmReset ? (
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">席位、对话和任务都会删掉。</span>
              <Button type="button" variant="destructive" size="sm" disabled={busy} onClick={onReset}>
                确认清空
              </Button>
            </div>
          ) : (
            <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmReset(true)}>
              清空记录
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
