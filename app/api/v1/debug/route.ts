import { boot } from "@/lib/boot"
import { ApiError, asRecord, asString, handle, json, readBody } from "@/lib/http"
import { debugClearSummary, debugForgetSeen, postSystem, snapshot } from "@/lib/store"

// Things that rarely happen on their own, triggered from the debug menu so the
// UI for them can be checked. Off outside `next dev`.
const NOTES: Record<string, string> = {
  relay: "agent 之间已经自动接力 3 轮，先停下，等 jinbao 发话再继续",
  failed: "唤起 调试席位 没成功：退出码 1（这是调试菜单插的假消息）",
  nosession: "调试席位 被点到了，但还没报 agent 和 uuid，叫不醒",
}

export async function POST(request: Request) {
  try {
    if (process.env.NODE_ENV === "production") throw new ApiError(404, "调试接口只在开发模式开着")
    await boot()
    const body = asRecord(await readBody(request))
    if (body.as !== "human") throw new ApiError(403, "调试接口只给人用")
    const action = asString(body.action)
    if (action === "note") {
      const text = NOTES[asString(body.kind) ?? ""]
      if (!text) throw new ApiError(400, "没有这种系统消息")
      postSystem(text)
      return json(snapshot())
    }
    if (action === "forget") return json(debugForgetSeen(asString(body.agentId) ?? ""))
    if (action === "clearSummary") {
      debugClearSummary()
      return json(snapshot())
    }
    throw new ApiError(400, "action 只能是 note、forget 或 clearSummary")
  } catch (error) {
    return handle(error)
  }
}
