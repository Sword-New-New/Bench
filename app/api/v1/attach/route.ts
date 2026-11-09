import { boot } from "@/lib/boot"
import { asRecord, handle, json, readBody } from "@/lib/http"
import { inRequest, pinAttachments } from "@/lib/store"

// A woken seat pins files on this computer (`paths`) to what it says next in
// this wake, usually its posted answer: a video or a sound plays in the page.
export async function POST(request: Request) {
  try {
    await boot()
    const body = asRecord(await readBody(request))
    return json(inRequest(body, () => pinAttachments(body)))
  } catch (error) {
    return handle(error)
  }
}
