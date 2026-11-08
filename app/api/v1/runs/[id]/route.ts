import { boot } from "@/lib/boot"
import { ApiError, handle, json } from "@/lib/http"
import { getRun } from "@/lib/runs"

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
