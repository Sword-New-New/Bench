import { boot } from "@/lib/boot"
import { asRecord, handle, json, readBody } from "@/lib/http"
import { askUser, awaitAnswer, inRequest } from "@/lib/store"

// bench_ask: put a question to the user (`action: "ask"`), then wait for the
// answer (`action: "wait"`, long poll).
export async function POST(request: Request) {
  try {
    await boot()
    const body = asRecord(await readBody(request))
    if (body.action === "wait") return json(await inRequest(body, () => awaitAnswer(body, request.signal)))
    return json(inRequest(body, () => askUser(body)))
  } catch (error) {
    return handle(error)
  }
}
