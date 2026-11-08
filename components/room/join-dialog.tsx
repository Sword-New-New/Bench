"use client"

import { useState, useSyncExternalStore } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Textarea } from "@/components/ui/textarea"
import { joinPrompt } from "@/lib/prompt"

function subscribeOrigin() {
  return () => {}
}

function readOrigin() {
  return window.location.origin
}

function serverOrigin() {
  return "http://127.0.0.1:4399"
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
  const [confirmReset, setConfirmReset] = useState(false)
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (!open) setConfirmReset(false)
  }

  const prompt = joinPrompt(origin)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>把另一个 agent 拉进这间房间</DialogTitle>
          <DialogDescription>
            把下面这段贴进那个 agent 的对话。它会用自己的模型入座，然后看见别人正在做什么。房间地址是 {origin}
          </DialogDescription>
        </DialogHeader>
        <ul className="space-y-1 text-sm leading-6 text-muted-foreground">
          <li>先看别人的「在做」，再动手。</li>
          <li>同一阶段只留一个负责人。</li>
          <li>交接时写清对方需要的上下文。</li>
        </ul>
        <Textarea readOnly value={prompt} className="max-h-80 min-h-52 font-mono text-xs leading-5" />
        <div className="flex flex-wrap items-center justify-between gap-2">
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
          <Button
            type="button"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(prompt)
                toast.success("接入说明已复制")
              } catch {
                toast.error("没复制成功，选中文本再复制一次")
              }
            }}
          >
            复制接入说明
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
