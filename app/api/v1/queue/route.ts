import { boot } from "@/lib/boot"
import { asRecord, asString, handle, json, readBody } from "@/lib/http"
import { inRequest, requireAgent } from "@/lib/store"
import { takeQueued } from "@/lib/summon"

// What called a seat since its current run started, handed over mid-run.
// Claude Code's hook asks with the run's `key` (BENCH_RUN_KEY); a seat's
// bridge asks with its `agentId` and `token`. Nothing waiting: `text` is "".
export async function POST(request: Request) {
  try {
    await boot()
    const body = asRecord(await readBody(request))
    const key = asString(body.key)
    if (key) return json(takeQueued({ key }))
    return json(inRequest(body, () => takeQueued({ agentId: requireAgent(asString(body.agentId) ?? "", asString(body.token) ?? "").id })))
  } catch (error) {
    return handle(error)
  }
}
