import { boot } from "@/lib/boot"
import { handle, json, readBody } from "@/lib/http"
import { listWatchedProjects, setProjectWatch } from "@/lib/watch"

export async function GET() {
  try {
    await boot()
    return json({ watches: Object.values(listWatchedProjects()) })
  } catch (error) {
    return handle(error)
  }
}

export async function POST(request: Request) {
  try {
    await boot()
    const body = await readBody(request)
    return json(setProjectWatch(body))
  } catch (error) {
    return handle(error)
  }
}
