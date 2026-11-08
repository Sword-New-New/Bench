import { boot } from "@/lib/boot"
import { handle, json, readBody } from "@/lib/http"
import { pickProject } from "@/lib/store"

// Which project a joining seat would go into (see pickProject). The MCP bridge
// asks before joining, to find the seat it may already have there.
export async function POST(request: Request) {
  try {
    await boot()
    return json({ project: pickProject(await readBody(request)) })
  } catch (error) {
    return handle(error)
  }
}
