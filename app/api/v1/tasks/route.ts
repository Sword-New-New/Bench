import { boot } from "@/lib/boot"
import { asRecord, handle, json, readBody } from "@/lib/http"
import { createTask, inRequest, queryDoneTasks } from "@/lib/store"

export async function GET(request: Request) {
  try {
    await boot()
    const url = new URL(request.url)
    const project = url.searchParams.get("project") ?? undefined
    const before = url.searchParams.get("before") ?? undefined
    const limit = url.searchParams.get("limit") ?? undefined
    return json(
      inRequest({ project }, () =>
        queryDoneTasks({
          before,
          limit: limit ? Number(limit) : undefined,
        }),
      ),
    )
  } catch (error) {
    return handle(error)
  }
}

export async function POST(request: Request) {
  try {
    await boot()
    const body = asRecord(await readBody(request))
    return json(inRequest(body, () => createTask(body)), 201)
  } catch (error) {
    return handle(error)
  }
}
