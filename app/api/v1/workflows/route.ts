import { boot } from "@/lib/boot"
import { asRecord, handle, json, readBody } from "@/lib/http"
import { currentProject, inRequest, workflowAction } from "@/lib/store"
import { listWorkflows } from "@/lib/workflows"

export async function GET(request: Request) {
  try {
    await boot()
    const project = new URL(request.url).searchParams.get("project") ?? undefined
    return json(inRequest({ project }, () => ({ workflows: listWorkflows(currentProject()) })))
  } catch (error) {
    return handle(error)
  }
}

export async function POST(request: Request) {
  try {
    await boot()
    const body = asRecord(await readBody(request))
    return json(inRequest(body, () => workflowAction(body)))
  } catch (error) {
    return handle(error)
  }
}
