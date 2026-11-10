import type { Metadata } from "next"

import { SpeedBoard } from "@/components/room/speed-board"

export const metadata: Metadata = {
  title: "Token 测速台 · 并坐",
  description: "本机 Claude Code、Codex、Antigravity 与 DeepSeek Harness 的输出速度与 Token 用量看板。",
}

export default function SpeedPage() {
  return (
    <main className="h-dvh overflow-y-auto bg-background text-foreground">
      <SpeedBoard />
    </main>
  )
}
