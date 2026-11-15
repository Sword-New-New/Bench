import { boot } from "@/lib/boot"
import { frontOverview } from "@/lib/front"
import { asRecord, handle, json, readBody } from "@/lib/http"

// Cross-project overview for seats in the reception project (「前台」).
export async function POST(request: Request) {
  try {
    await boot()
    const body = asRecord(await readBody(request))
    return json(frontOverview(body))
  } catch (error) {
    return handle(error)
  }
}
