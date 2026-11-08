import { boot } from "@/lib/boot"
import { asRecord, handle, json, readBody } from "@/lib/http"
import { inRequest, say } from "@/lib/store"


export async function POST(request: Request) {
  try {
    await boot()
    const body = asRecord(await readBody(request))
    return json(inRequest(body, () => say(body)))
  } catch (error) {
    return handle(error)
  }
}
