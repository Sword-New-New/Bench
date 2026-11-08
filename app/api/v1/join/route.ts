import { boot } from "@/lib/boot"
import { asRecord, handle, json, readBody } from "@/lib/http"
import { inProject, join, pickProject } from "@/lib/store"


export async function POST(request: Request) {
  try {
    await boot()
    const body = asRecord(await readBody(request))
    const project = pickProject(body)
    return json({ ...inProject(project.id, () => join(body)), project }, 201)
  } catch (error) {
    return handle(error)
  }
}
