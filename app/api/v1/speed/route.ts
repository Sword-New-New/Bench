import { boot } from "@/lib/boot"
import { handle, json } from "@/lib/http"
import { speeds } from "@/lib/speed"

// Each client's latest output speed for the roster summary line (lib/speed.ts).
export async function GET(request: Request) {
  try {
    await boot()
    const fresh = new URL(request.url).searchParams.get("fresh") === "1"
    return json(await speeds(fresh))
  } catch (error) {
    return handle(error)
  }
}
