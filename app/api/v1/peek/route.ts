import { boot } from "@/lib/boot"
import { frontPeek } from "@/lib/front"
import { asRecord, handle, json, readBody } from "@/lib/http"

// Read-only detail view of one project for seats in the reception project (「前台」).
export async function POST(request: Request) {
  try {
    await boot()
    const body = asRecord(await readBody(request))
    return json(frontPeek(body))
  } catch (error) {
    return handle(error)
  }
}
