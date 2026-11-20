import { boot } from "@/lib/boot"
import { acceptDeputy, deputyIssues, deputyPasses, reopenDeputy, setAutoAccept } from "@/lib/deputy"
import { ApiError, asRecord, asString, handle, json, readBody } from "@/lib/http"
import { autoAcceptSince } from "@/lib/store"

// The front desk signing off for the user (lib/deputy.ts). Its seat:
// {action:"accept", project, taskId, why}; the user's page (page key):
// {as:"human", action:"reopen", project, taskId}; the room-wide switch
// 「查过没问题的，自动替我收下」: {as:"human", action:"auto", on}.
export async function POST(request: Request) {
  try {
    await boot()
    const body = asRecord(await readBody(request))
    const action = asString(body.action)
    if (action === "reopen") return json(reopenDeputy(body))
    if (action === "auto") return json(setAutoAccept(body))
    if (action === "accept") {
      if (body.as === "human") throw new ApiError(400, "你自己验收就在待办上点通过；accept 是前台用的")
      return json(acceptDeputy(body))
    }
    throw new ApiError(400, "action 只能是 accept、reopen 或 auto")
  } catch (error) {
    return handle(error)
  }
}

// The passes it made (reopened ones left out): ?since=<ms>; plus recent 14-day
// human passes signed off despite check issues, and whether the switch is on.
export async function GET(request: Request) {
  try {
    await boot()
    const since = Number(new URL(request.url).searchParams.get("since") ?? 0)
    return json({
      passes: deputyPasses(Number.isFinite(since) && since > 0 ? since : 0),
      issues: deputyIssues(),
      auto: autoAcceptSince() > 0,
    })
  } catch (error) {
    return handle(error)
  }
}
