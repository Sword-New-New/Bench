import { boot } from "@/lib/boot"
import { asRecord, handle, json, readBody } from "@/lib/http"
import { inRequest, recall } from "@/lib/store"
import { forgetMessage } from "@/lib/summon"

// The user takes back one of their messages (`as: "human"`, `id`). Seats it
// called that haven't started on it yet are no longer woken for it.
export async function POST(request: Request) {
  try {
    await boot()
    const body = asRecord(await readBody(request))
    return json(
      inRequest(body, () => {
        const result = recall(body)
        forgetMessage(result.message.id)
        return result
      }),
    )
  } catch (error) {
    return handle(error)
  }
}
