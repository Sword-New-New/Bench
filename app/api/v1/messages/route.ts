import { boot } from "@/lib/boot"
import { asRecord, handle, json, readBody } from "@/lib/http"
import { inRequest, messagesFor } from "@/lib/store"

// The room's talk as structured data: a reply chain, one seat's part, or a page back.
export async function POST(request: Request) {
  try {
    await boot()
    const body = asRecord(await readBody(request))
    return json(inRequest(body, () => messagesFor(body)))
  } catch (error) {
    return handle(error)
  }
}
