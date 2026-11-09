import { boot } from "@/lib/boot"
import { ApiError, asRecord, asString, handle, json, readBody } from "@/lib/http"
import { debugClearSummary, debugForgetSeen, inRequest, postSystem, snapshot, userName } from "@/lib/store"

// Things that rarely happen on their own, triggered from the debug menu so the
// UI for them can be checked. Off outside `next dev`.
const NOTES: Record<string, () => string> = {
  relay: () => `agent 之间已经自动接力 3 轮，先停下，等 ${userName()} 发话再继续`,
  failed: () => "唤起 调试席位 没成功：退出码 1（这是调试菜单插的假消息）",
  nosession: () => "调试席位 被点到了，但还没报 agent 和 uuid，叫不醒",
}

export async function POST(request: Request) {
  try {
    if (process.env.NODE_ENV === "production" || process.env.NEXT_PUBLIC_BENCH_DEBUG !== "1")
      throw new ApiError(404, "调试接口没开：在 .env.local 里写 NEXT_PUBLIC_BENCH_DEBUG=1，并用 next dev 跑")
    await boot()
    const body = asRecord(await readBody(request))
    if (body.as !== "human") throw new ApiError(403, "调试接口只给人用")
    return json(inRequest(body, () => debug(body)))
  } catch (error) {
    return handle(error)
  }
}

function debug(body: Record<string, unknown>) {
  const action = asString(body.action)
  if (action === "note") {
    const text = NOTES[asString(body.kind) ?? ""]?.()
    if (!text) throw new ApiError(400, "没有这种系统消息")
    postSystem(text)
    return snapshot()
  }
  if (action === "forget") return debugForgetSeen(asString(body.agentId) ?? "")
  if (action === "clearSummary") {
    // Wipes data: only with the word, so a script can't do it by accident.
    if (body.confirm !== "清空摘要") throw new ApiError(400, "清空摘要要带 confirm: \"清空摘要\"")
    debugClearSummary()
    return snapshot()
  }
  throw new ApiError(400, "action 只能是 note、forget 或 clearSummary")
}
