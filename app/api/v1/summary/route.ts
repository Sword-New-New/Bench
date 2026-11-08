import { boot } from "@/lib/boot"
import { asRecord, asString, handle, json, readBody } from "@/lib/http"
import { inRequest, summaryAction } from "@/lib/store"
import { requestSummary } from "@/lib/summon"


// The user asks a seat to write the room summary, skips this stretch, or edits
// it; an agent hands its summary in with action "write".
export async function POST(request: Request) {
  try {
    await boot()
    const body = asRecord(await readBody(request))
    return json(
      inRequest(body, () =>
        body.as === "human" && asString(body.action) === "request"
          ? requestSummary(asString(body.agentId) ?? "")
          : summaryAction(body),
      ),
    )
  } catch (error) {
    return handle(error)
  }
}
