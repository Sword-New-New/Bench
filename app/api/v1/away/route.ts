import { awayOverview } from "@/lib/away"
import { boot } from "@/lib/boot"
import { handle, json } from "@/lib/http"

// Read-only: what happened since `since` (ms), in one project or, with no
// `project` (or the front desk), across the ordinary ones. Same trust boundary
// as GET /api/v1/room and GET /api/v1/waiting; changes nothing.
export async function GET(request: Request) {
  try {
    await boot()
    const url = new URL(request.url)
    return json(awayOverview(url.searchParams.get("since"), url.searchParams.get("project") ?? undefined))
  } catch (error) {
    return handle(error)
  }
}
