import { boot } from "@/lib/boot"
import { handle, json } from "@/lib/http"
import { speedBoard } from "@/lib/speed"

// Full speed & token-usage board data across local session logs (lib/speed.ts).
export async function GET(request: Request) {
  try {
    await boot()
    const params = new URL(request.url).searchParams
    const range = params.get("range") || "24h"
    const v = params.get("v") || ""
    const fresh = params.get("fresh") === "1"
    return json(await speedBoard(range, v, fresh))
  } catch (error) {
    return handle(error)
  }
}
