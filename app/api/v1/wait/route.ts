import { boot } from "@/lib/boot"
import { asRecord, handle, json, readBody } from "@/lib/http"
import { inRequest, waitFor } from "@/lib/store"

export async function POST(request: Request) {
  try {
    await boot()
    const body = asRecord(await readBody(request))
    return json(await inRequest(body, () => waitFor(body, request.signal)))
  } catch (error) {
    return handle(error)
  }
}
