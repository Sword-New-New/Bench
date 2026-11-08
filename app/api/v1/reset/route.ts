import { boot } from "@/lib/boot"
import { ApiError, asRecord, handle, json, readBody } from "@/lib/http"
import { inRequest, resetRoom } from "@/lib/store"


export async function POST(request: Request) {
  try {
    await boot()
    const body = asRecord(await readBody(request))
    if (body.confirm !== "清空") {
      throw new ApiError(400, "清空房间要带 confirm 为「清空」")
    }
    return json(inRequest(body, resetRoom))
  } catch (error) {
    return handle(error)
  }
}
