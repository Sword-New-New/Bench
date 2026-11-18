import { boot } from "@/lib/boot"
import { draftRelay, settleRelay } from "@/lib/front-relay"
import { asRecord, handle, json, readBody } from "@/lib/http"
import { inRequest } from "@/lib/store"

// The front desk's cards (lib/front-relay.ts). Its seat drafts one (agentId
// and token); the user's page sends, drops or passes it (`as: "human"`, which
// readBody only takes with the page key).
export async function POST(request: Request) {
  try {
    await boot()
    const body = asRecord(await readBody(request))
    if (body.as === "human") return json(inRequest(body, () => settleRelay(body)))
    return json(draftRelay(body))
  } catch (error) {
    return handle(error)
  }
}
