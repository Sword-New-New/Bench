import { boot } from "@/lib/boot"
import { ApiError, handle, json } from "@/lib/http"
import { showCommit } from "@/lib/open-ref"
import { inRequest } from "@/lib/store"

// One commit named in a message: who, when, what changed (lib/open-ref.ts).
// ?hash=…&project=…&from=<seat id whose folder to look in first>
export async function GET(request: Request) {
  try {
    await boot()
    const params = new URL(request.url).searchParams
    const hash = params.get("hash") ?? ""
    if (!hash) throw new ApiError(400, "缺少 hash")
    return json(await inRequest({ project: params.get("project") ?? undefined }, () => showCommit(hash, params.get("from") ?? undefined)))
  } catch (error) {
    return handle(error)
  }
}
