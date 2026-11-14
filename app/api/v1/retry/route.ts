import { boot } from "@/lib/boot"
import { ApiError, asRecord, handle, json, readBody } from "@/lib/http"
import { netRetry, setNetRetry } from "@/lib/store"

// 「网络错误自动重试」: wakes that failed on the network are tried again by
// themselves (lib/netfail.ts). One setting for every project; on by default.
export async function GET() {
  try {
    await boot()
    return json({ on: netRetry() })
  } catch (error) {
    return handle(error)
  }
}

export async function POST(request: Request) {
  try {
    await boot()
    const body = asRecord(await readBody(request))
    if (body.as !== "human") throw new ApiError(403, "只有用户自己能改")
    return json(setNetRetry(body.on))
  } catch (error) {
    return handle(error)
  }
}
