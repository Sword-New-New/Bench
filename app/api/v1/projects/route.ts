import { boot } from "@/lib/boot"
import { ApiError, asRecord, handle, json, readBody } from "@/lib/http"
import { createProject, listProjects } from "@/lib/store"

export async function GET() {
  try {
    await boot()
    return json({ projects: listProjects() })
  } catch (error) {
    return handle(error)
  }
}

export async function POST(request: Request) {
  try {
    await boot()
    const body = asRecord(await readBody(request))
    if (body.as !== "human") throw new ApiError(400, "只有这台电脑上的人能建项目")
    return json(createProject(body), 201)
  } catch (error) {
    return handle(error)
  }
}
