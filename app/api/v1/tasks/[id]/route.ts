import { boot } from "@/lib/boot"
import { asRecord, handle, json, readBody } from "@/lib/http"
import { actOnTask, inRequest } from "@/lib/store"


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
