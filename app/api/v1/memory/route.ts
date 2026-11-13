import { boot } from "@/lib/boot"
import { asRecord, handle, json, readBody } from "@/lib/http"
import { inRequest, memoryAction } from "@/lib/store"

// Seat persona & long-term memory: read/append/replace by an agent (bench_memory)
// or by the user on the page.
export async function POST(request: Request) {
  try {
    await boot()
    const body = asRecord(await readBody(request))
    return json(inRequest(body, () => memoryAction(body)))
  } catch (error) {
    return handle(error)
  }
}
