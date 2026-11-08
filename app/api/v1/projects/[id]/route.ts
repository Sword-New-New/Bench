import { boot } from "@/lib/boot"
import { ApiError, asRecord, handle, json, readBody } from "@/lib/http"
import { deleteProject, inProject, snapshot, updateProject } from "@/lib/store"
import { stopAgent } from "@/lib/summon"

// From the page: rename a project, change its folder, or delete it.
export async function POST(request: Request, ctx: RouteContext<"/api/v1/projects/[id]">) {
  try {
    await boot()
    const { id } = await ctx.params
    const body = asRecord(await readBody(request))
    if (body.as !== "human") throw new ApiError(400, "只有这台电脑上的人能改项目")
    if (body.action === "update") return json(updateProject(id, body))
    if (body.action === "delete") {
      if (body.confirm !== "删除") throw new ApiError(400, "删除项目要带 confirm 为「删除」")
      // Wakes still running in it are stopped first; they'd have nowhere to post.
      inProject(id, () => {
        for (const agent of snapshot().agents) {
          try {
            stopAgent(agent.id)
          } catch {}
        }
      })
      return json(deleteProject(id))
    }
    throw new ApiError(400, "action 只能是 update 或 delete")
  } catch (error) {
    return handle(error)
  }
}
