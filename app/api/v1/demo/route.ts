import { boot } from "@/lib/boot"
import { dismissDemos, seatDemos } from "@/lib/demo"
import { ApiError, asRecord, asString, handle, json, readBody } from "@/lib/http"


export async function POST(request: Request) {
  try {
    await boot()
    const action = asString(asRecord(await readBody(request)).action)
    if (action === "seat") return json(seatDemos())
    if (action === "dismiss") return json(dismissDemos())
    throw new ApiError(400, "action 只能是 seat 或 dismiss")
  } catch (error) {
    return handle(error)
  }
}
