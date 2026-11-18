import { boot } from "@/lib/boot"
import { frontNotify } from "@/lib/front"
import { asRecord, handle, json, readBody } from "@/lib/http"

// The front desk's AI pushes one line to the user (lib/front.ts frontNotify).
export async function POST(request: Request) {
  try {
    await boot()
    const body = asRecord(await readBody(request))
    return json(frontNotify(body))
  } catch (error) {
    return handle(error)
  }
}
