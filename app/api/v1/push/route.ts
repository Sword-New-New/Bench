import { boot } from "@/lib/boot"
import { ApiError, asRecord, asString, handle, json, readBody } from "@/lib/http"
import { HUMAN_HEADER, isHumanKey } from "@/lib/human"
import { getPublicPushState, noteClientPresence, sendTestPush, updatePushSettings } from "@/lib/push"
import { projectNameOf } from "@/lib/store"

// Mobile / webhook push settings, test sender, and page foreground heartbeat.
// Every action requires the user's human key; credentials are never returned.
export async function GET(request: Request) {
  try {
    await boot()
    if (!isHumanKey(request.headers.get(HUMAN_HEADER))) {
      throw new ApiError(403, "推送设置只能由用户自己的页面查看")
    }
    return json(getPublicPushState())
  } catch (error) {
    return handle(error)
  }
}

export async function POST(request: Request) {
  try {
    await boot()
    const body = asRecord(await readBody(request))
    if (body.as !== "human") {
      throw new ApiError(403, "推送设置只能由用户自己改")
    }
    const action = asString(body.action)
    if (action === "presence") {
      noteClientPresence(body.front !== false)
      return json({ ok: true })
    }
    if (action === "test") {
      if ("channel" in body || "target" in body || "token" in body || "extra" in body || "titleOnly" in body || "onEnd" in body || "enabled" in body) {
        updatePushSettings(body)
      }
      const projId = asString(body.project)
      const projName = (projId ? projectNameOf(projId) : null) || "并坐"
      return json(await sendTestPush(projName))
    }
    return json(updatePushSettings(body))
  } catch (error) {
    return handle(error)
  }
}
