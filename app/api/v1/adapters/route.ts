import { adapters, installed, modelOf, replaceAdapters } from "@/lib/adapters"
import { boot } from "@/lib/boot"
import { ApiError, asRecord, handle, json, readBody } from "@/lib/http"
import { refreshRooms } from "@/lib/store"

export async function GET() {
  try {
    await boot()
    return json({
      agents: adapters().map((adapter) => ({ ...adapter, installed: installed(adapter.command), model: modelOf(adapter) })),
    })
  } catch (error) {
    return handle(error)
  }
}

export async function POST(request: Request) {
  try {
    await boot()
    const body = asRecord(await readBody(request))
    if (body.as !== "human") throw new ApiError(400, "只有这台电脑上的人能改唤起命令")
    const agents = replaceAdapters(body.agents)
    refreshRooms()
    return json({
      agents: agents.map((adapter) => ({ ...adapter, installed: installed(adapter.command), model: modelOf(adapter) })),
    })
  } catch (error) {
    return handle(error)
  }
}
