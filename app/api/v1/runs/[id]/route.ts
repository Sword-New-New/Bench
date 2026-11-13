import { inSeat, userName } from "@/lib/store"
import { boot } from "@/lib/boot"
import { ApiError, asRecord, handle, json, readBody } from "@/lib/http"
import { getRun } from "@/lib/runs"
import { rebindSession } from "@/lib/spawn"
import { limitChoice, rewake } from "@/lib/summon"

// One wake's steps, for the 「过程」 panel.
export async function GET(_request: Request, ctx: RouteContext<"/api/v1/runs/[id]">) {
  try {
    await boot()
    const { id } = await ctx.params
    const run = getRun(id)
    if (!run) throw new ApiError(404, "这次唤起的记录已经不在了")
    return json({ run })
  } catch (error) {
    return handle(error)
  }
}

// Wake a seat again with what a run cut off by a restart was doing, or choose
// what to do after it hit the usage limit (including switching AI client).
export async function POST(request: Request, ctx: RouteContext<"/api/v1/runs/[id]">) {
  try {
    await boot()
    const { id } = await ctx.params
    const body = asRecord(await readBody(request))
    if (body.as !== "human") throw new ApiError(403, `重新叫醒由 ${userName()} 在页面上点`)
    if (body.action === "rewake") return json(rewake(id))
    if (body.action === "rebind") {
      const run = getRun(id)
      if (!run?.limited) throw new ApiError(404, "这次唤起没撞额度，或者记录已经不在了")
      return json(await inSeat(run.agentId, () => rebindSession(run.agentId, { ...body, fromRunId: id })))
    }
    if (typeof body.action === "string" && ["schedule", "now", "cancel", "dismiss"].includes(body.action)) {
      return json(limitChoice(id, body.action))
    }
    throw new ApiError(400, "action 只能是 rewake、schedule、now、cancel、dismiss 或 rebind")
  } catch (error) {
    return handle(error)
  }
}
