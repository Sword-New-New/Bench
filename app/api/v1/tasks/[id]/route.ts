import { boot } from "@/lib/boot"
import { asRecord, handle, json, readBody } from "@/lib/http"
import { actOnTask, getTaskById, inRequest } from "@/lib/store"

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    await boot()
    const { id } = await context.params
    const url = new URL(request.url)
    const project = url.searchParams.get("project") ?? undefined
    return json(inRequest({ project }, () => ({ task: getTaskById(id) })))
  } catch (error) {
    return handle(error)
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    await boot()
    const { id } = await context.params
    const body = asRecord(await readBody(request))
    return json(inRequest(body, () => actOnTask({ ...body, taskId: id })))
  } catch (error) {
    return handle(error)
  }
}
