import { boot } from "@/lib/boot"
import { handle, json } from "@/lib/http"
import { inRequest, snapshot } from "@/lib/store"


export async function GET(request: Request) {
  try {
    await boot()
    const project = new URL(request.url).searchParams.get("project") ?? undefined
    return json(inRequest({ project }, snapshot))
  } catch (error) {
    return handle(error)
  }
}
