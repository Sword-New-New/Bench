import { boot } from "@/lib/boot"
import { ApiError, asRecord, asString, handle, json, readBody } from "@/lib/http"
import { selfcheck } from "@/lib/selfcheck"
import { inRequest, requireAgent } from "@/lib/store"

// A seat asks whether a call to it would really wake it (lib/selfcheck.ts).
export async function POST(request: Request) {
  try {
    await boot()
    const body = asRecord(await readBody(request))
    const agentId = asString(body.agentId)
    const token = asString(body.token)
    if (!agentId || !token) throw new ApiError(401, "自检要带 agentId 和 token")
    return json(
      inRequest(body, () => {
        requireAgent(agentId, token)
        return selfcheck(agentId)
      }),
    )
  } catch (error) {
    return handle(error)
  }
}
