import { boot } from "@/lib/boot"
import { ApiError, asRecord, asString, handle, json, readBody } from "@/lib/http"
import { openFile } from "@/lib/open-ref"
import { inRequest } from "@/lib/store"

// A file named in a message, opened in the editor at its line (lib/open-ref.ts).
// It starts a program on this computer, so only the user's own page may ask.
export async function POST(request: Request) {
  try {
    await boot()
    const body = asRecord(await readBody(request))
    if (body.as !== "human") throw new ApiError(403, "只有这台电脑上的人能打开文件")
    const file = asString(body.path)
    if (!file) throw new ApiError(400, "缺少 path")
    const line = Number(body.line)
    const from = asString(body.from)
    return json(await inRequest({ project: body.project }, () => openFile(file, Number.isInteger(line) && line > 0 ? line : undefined, from)))
  } catch (error) {
    return handle(error)
  }
}
