import { boot } from "@/lib/boot"
import { handle, json, readBody } from "@/lib/http"
import { registerSession } from "@/lib/store"

export async function POST(request: Request) {
  try {
    await boot()
    return json(registerSession(await readBody(request)))
  } catch (error) {
    return handle(error)
  }
}
