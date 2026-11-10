import { boot } from "@/lib/boot"
import { asRecord, handle, json, readBody } from "@/lib/http"
import { quotas } from "@/lib/quota"
import { report } from "@/lib/quota-reports"

// Each account-signed-in client's 5-hour and weekly allowance (lib/quota.ts).
// ?fresh=1 skips the five-minute cache (unless Claude is in 429 cooldown).
export async function GET(request: Request) {
  try {
    await boot()
    const fresh = new URL(request.url).searchParams.get("fresh") === "1"
    return json(await quotas(fresh))
  } catch (error) {
    return handle(error)
  }
}

// A plugin sends in a client's usage the room can't read itself
// (lib/quota-reports.ts has the shape; scripts/quota-push.mjs sends one).
export async function POST(request: Request) {
  try {
    await boot()
    const saved = report(asRecord(await readBody(request)))
    return json({ ok: true, report: saved })
  } catch (error) {
    return handle(error)
  }
}
