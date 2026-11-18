import { boot } from "@/lib/boot"
import { handle, json } from "@/lib/http"
import { waitingOverview } from "@/lib/waiting"

// Read-only overview of items waiting on the user across every ordinary project
// (same trust boundary as GET /api/v1/room and GET /api/v1/deputy).
export async function GET() {
  try {
    await boot()
    return json(waitingOverview())
  } catch (error) {
    return handle(error)
  }
}
