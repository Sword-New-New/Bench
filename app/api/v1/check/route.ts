import { boot } from "@/lib/boot"
import { asRecord, asString, handle, json, readBody } from "@/lib/http"
import { requireFrontSeat, runBatchCheck } from "@/lib/store"

// Queue checks for waiting-review tasks that don't have a verdict yet (no check,
// skipped, or error). Callable by the user (x-bench-human + as: "human") or by
// the front desk seat (`bench_check`).
export async function POST(request: Request) {
  try {
    await boot()
    const body = asRecord(await readBody(request))
    if (body.as !== "human") {
      requireFrontSeat(body)
    }
    const project = asString(body.project)?.trim() || undefined
    return json(runBatchCheck(project))
  } catch (error) {
    return handle(error)
  }
}
