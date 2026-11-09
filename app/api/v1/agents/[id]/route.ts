import { boot } from "@/lib/boot"
import { ApiError, asRecord, handle, json, readBody } from "@/lib/http"
import { listRuns } from "@/lib/runs"
import { currentProjectInfo, inSeat, renameAgent } from "@/lib/store"
import { renameSeatFiles } from "@/lib/spawn"
import { stopAgent, whisper } from "@/lib/summon"

// What you said to this seat alone, and what it answered.
export async function GET(_request: Request, ctx: RouteContext<"/api/v1/agents/[id]">) {
  try {
    await boot()
    const { id } = await ctx.params
    return json({ runs: listRuns(id, "private") })
  } catch (error) {
    return handle(error)
  }
}

// From the page: stop what a seat is running, say something to it alone, or
// give it another name.
export async function POST(request: Request, ctx: RouteContext<"/api/v1/agents/[id]">) {
  try {
    await boot()
    const { id } = await ctx.params
    const body = asRecord(await readBody(request))
    if (body.as !== "human") throw new ApiError(400, "只有这台电脑上的人能这么做")
    if (body.action === "stop") return json(inSeat(id, () => stopAgent(id)))
    if (body.action === "whisper") return json(inSeat(id, () => whisper(id, typeof body.text === "string" ? body.text : "")))
    if (body.action === "rename") {
      return json(
        inSeat(id, () => {
          const result = renameAgent(id, body.name)
          renameSeatFiles(id, currentProjectInfo().id, result.agent.name)
          return result
        }),
      )
    }
    throw new ApiError(400, "action 只能是 stop、whisper 或 rename")
  } catch (error) {
    return handle(error)
  }
}
