import { boot } from "@/lib/boot"
import { firstOpenInfo, startFirst } from "@/lib/first-open"
import { asRecord, handle, json, readBody } from "@/lib/http"

// 「第一次打开」 (lib/first-open.ts). GET: whether the room is still fresh, who
// would do it and where. POST {as:"human", text, kind?, dir?}: 「开始」.
export async function GET() {
  try {
    await boot()
    return json(firstOpenInfo())
  } catch (error) {
    return handle(error)
  }
}

export async function POST(request: Request) {
  try {
    await boot()
    return json(await startFirst(asRecord(await readBody(request))))
  } catch (error) {
    return handle(error)
  }
}
