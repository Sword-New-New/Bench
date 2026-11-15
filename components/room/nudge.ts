import { toast } from "sonner"

import { api } from "@/components/room/api"
import type { PublicAgent } from "@/lib/types"

const NUDGE_MAX = 40

function clipTitle(text: string, max: number) {
  if (max <= 0) return ""
  return text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text
}

// 「叫它接着做」: said in the room as the user, so it is an ordinary call,
// seen by everyone and answered where it was asked. The roster's button and
// the 「进展」 page's share it.
export async function nudgeSeat(agent: Pick<PublicAgent, "name" | "owes">) {
  const owes = agent.owes
  if (!owes) return
  const prefix = `@${agent.name} `
  let body = ""
  if (owes.tasks.length > 0) {
    const first = owes.tasks[0]
    const more = owes.tasks.length > 1 ? `等${owes.tasks.length}条` : ""
    const calls = owes.calls.length > 0 ? `（含${owes.calls.length}条未达）` : ""
    const tail = `${more}${calls}；等别人就标卡住写原因。`
    const room = NUDGE_MAX - (prefix.length + `接着做 ${first.id}`.length + tail.length) - 2
    const quoted = room >= 3 ? `「${clipTitle(first.title, room)}」` : ""
    body = `接着做 ${first.id}${quoted}${tail}`
  } else if (owes.calls.length > 0) {
    body = `前有 ${owes.calls.length} 条点名未达，一起看。`
  } else {
    return
  }
  const full = `${prefix}${body}`
  const text = full.length > NUDGE_MAX ? `${full.slice(0, NUDGE_MAX - 1)}。` : full
  try {
    await api("/api/v1/say", {
      method: "POST",
      body: JSON.stringify({ as: "human", text }),
    })
  } catch (error) {
    toast.error(error instanceof Error ? error.message : "发送失败")
  }
}
