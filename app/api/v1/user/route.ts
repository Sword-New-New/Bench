import { boot } from "@/lib/boot"
import { ApiError, asRecord, handle, json, readBody } from "@/lib/http"
import { setUserName, userName } from "@/lib/store"

// The user's name in the room, the same in every project.
export async function GET() {
  try {
    await boot()
    return json({ name: userName() })
  } catch (error) {
    return handle(error)
  }
}

export async function POST(request: Request) {
  try {
    await boot()
    const body = asRecord(await readBody(request))
    if (body.as !== "human") throw new ApiError(403, "名字只能由用户自己改")
    return json(setUserName(body.name))
  } catch (error) {
    return handle(error)
  }
}
