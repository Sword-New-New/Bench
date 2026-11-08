import { boot } from "@/lib/boot"
import { ApiError, asRecord, handle, json, readBody } from "@/lib/http"
import { register } from "@/lib/register"

// The join dialog's "替我运行": give the picked agents the bench tools.
export async function POST(request: Request) {
  try {
    await boot()
    const body = asRecord(await readBody(request))
    if (body.as !== "human") throw new ApiError(400, "只有这台电脑上的人能替 agent 注册")
    return json({ results: await register(body.kinds) })
  } catch (error) {
    return handle(error)
  }
}
