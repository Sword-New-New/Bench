import { boot } from "@/lib/boot"
import { ApiError, asRecord, handle, json, readBody } from "@/lib/http"
import { SPAWNABLE, spawnSession, workspaces } from "@/lib/spawn"

// For the 「开新会话」 dialog: which kinds the room can create, and the folders
// it can put them in.
export async function GET() {
  try {
    await boot()
    return json({ kinds: SPAWNABLE, workspaces: await workspaces() })
  } catch (error) {
    return handle(error)
  }
}

// Create a session, seat it, and hand it its task if there is one.
export async function POST(request: Request) {
  try {
    await boot()
    const body = asRecord(await readBody(request))
    if (body.as !== "human") throw new ApiError(400, "只有这台电脑上的人能开新会话")
    return json(await spawnSession(body))
  } catch (error) {
    return handle(error)
  }
}
