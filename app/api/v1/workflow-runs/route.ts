import { boot } from "@/lib/boot"
import { asRecord, handle, json, readBody } from "@/lib/http"
import { currentProject, inRequest } from "@/lib/store"
import { listWorkflowRuns, workflowRunAction } from "@/lib/workflow-engine"

export async function GET(request: Request) {
  try {
    await boot()
    const project = new URL(request.url).searchParams.get("project") ?? undefined
    return json(inRequest({ project }, () => ({ runs: listWorkflowRuns(currentProject()) })))
  } catch (error) {
    return handle(error)
  }
}

export async function POST(request: Request) {
  try {
    await boot()
    const body = asRecord(await readBody(request))
    return json(inRequest(body, () => workflowRunAction(body)))
  } catch (error) {
    return handle(error)
  }
}
