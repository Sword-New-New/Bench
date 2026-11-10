"use client"

import { useEffect, useState } from "react"
import { ExternalLink, RotateCw } from "lucide-react"

import { SpeedBoard } from "@/components/room/speed-board"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"

// Built-in Token Speed & Usage Board dialog (no external service required).
export const SPEED_OPEN = "bench-speed-open"

export function SpeedPanel() {
  const [open, setOpen] = useState(false)
  const [refreshSignal, setRefreshSignal] = useState(0)

  useEffect(() => {
    const show = () => setOpen(true)
    window.addEventListener(SPEED_OPEN, show)
    return () => window.removeEventListener(SPEED_OPEN, show)
  }, [])

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="flex h-[calc(100dvh-3rem)] flex-col gap-2 sm:max-w-[min(1280px,calc(100vw-3rem))]">
        <DialogHeader className="flex-row items-center gap-2 pr-8">
          <div className="min-w-0 flex-1">
            <DialogTitle>Token 测速台</DialogTitle>
            <DialogDescription className="truncate">
              各家每次请求的输出速度、首 token 与缓存用量，直接从本机会话记录增量读取。
            </DialogDescription>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="刷新"
            title="立即重新扫描"
            onClick={() => setRefreshSignal((n) => n + 1)}
          >
            <RotateCw />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="在新标签页打开"
            title="在新标签页打开"
            nativeButton={false}
            render={<a href="/speed" target="_blank" rel="noreferrer" />}
          >
            <ExternalLink />
          </Button>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border bg-background/60">
          {open ? <SpeedBoard embedded refreshSignal={refreshSignal} /> : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}
