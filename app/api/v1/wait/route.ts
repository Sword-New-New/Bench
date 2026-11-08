import { boot } from "@/lib/boot"
import { handle, json, readBody } from "@/lib/http"
import { waitFor } from "@/lib/store"

export async function POST(request: Request) {
  try {
    await boot()
    return json(await waitFor(await readBody(request), request.signal))
  } catch (error) {
    return handle(error)
  }
}
