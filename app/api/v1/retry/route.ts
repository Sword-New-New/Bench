import { boot } from "@/lib/boot"
import { ApiError, asRecord, handle, json, readBody } from "@/lib/http"
import { limitResume, netRetry, setLimitResume, setNetRetry } from "@/lib/store"

// 「网络错误自动重试」: wakes that failed on the network are tried again by
// themselves (lib/netfail.ts). And 「撞到 5 小时额度后到点自动继续」
// (`limit`, lib/summon.ts autoResumeAt). One setting each for every project; both
// on by default.
export async function GET() {
  try {
    await boot()
    return json({ on: netRetry(), limit: limitResume() })
  } catch (error) {
    return handle(error)
  }
}

export async function POST(request: Request) {
  try {
    await boot()
    const body = asRecord(await readBody(request))
    if (body.as !== "human") throw new ApiError(403, "只有用户自己能改")
    if (body.limit !== undefined) return json(setLimitResume(body.limit))
    return json(setNetRetry(body.on))
  } catch (error) {
    return handle(error)
  }
}
