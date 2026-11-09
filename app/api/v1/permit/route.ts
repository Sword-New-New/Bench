import { boot } from "@/lib/boot"
import { ApiError, asRecord, asString, handle, json, readBody } from "@/lib/http"
import { ask, decide, describe, setFull } from "@/lib/permits"
import { currentProject, inProject, inRequest, requireAgent, roomChanged } from "@/lib/store"

const TOOL_WAIT_MS = 10 * 60_000

// Permission prompts of woken Claude Code turns.
// Seat (agentId + token): `action: "tool"` (tool, input) asks to run one tool
// call, `action: "full"` (reason) asks for full permission for the rest of
// the wake; both wait for the user. The user (`as: "human"`): `id` with
// `decision: "once" | "full" | "deny"` (and a `note`), or `agentId` with
// `full: true | false` to grant or take back full permission at any time.
export async function POST(request: Request) {
  try {
    await boot()
    const body = asRecord(await readBody(request))
    return json(await inRequest(body, () => permit(body, request.signal)))
  } catch (error) {
    return handle(error)
  }
}

async function permit(body: Record<string, unknown>, signal: AbortSignal) {
  const project = currentProject()
  const changed = () => inProject(project, roomChanged)
  if (body.as === "human") {
    const id = asString(body.id)
    if (id) {
      const decision = asString(body.decision)
      if (decision !== "once" && decision !== "full" && decision !== "deny") {
        throw new ApiError(400, "decision 只能是 once、full 或 deny")
      }
      const note = asString(body.note)?.trim().slice(0, 300) || undefined
      const item = decide(id, { allow: decision !== "deny", full: decision === "full", note })
      if (!item) throw new ApiError(404, "这个请求已经处理过了，或者那次唤起已经结束")
      changed()
      return { ok: true }
    }
    const agentId = asString(body.agentId)
    if (!agentId || typeof body.full !== "boolean") throw new ApiError(400, "要带 id 和 decision，或 agentId 和 full")
    setFull(agentId, body.full)
    changed()
    return { ok: true, full: body.full }
  }
  const agentId = asString(body.agentId)
  const token = asString(body.token)
  if (!agentId || !token) throw new ApiError(401, "要带 agentId 和 token")
  const agent = requireAgent(agentId, token)
  const action = asString(body.action)
  if (action === "tool") {
    const tool = asString(body.tool)?.slice(0, 120)
    if (!tool) throw new ApiError(400, "缺少 tool")
    return ask(
      { project, agentId: agent.id, agentName: agent.name, kind: "tool", tool, input: describe(tool, body.input) },
      { timeoutMs: TOOL_WAIT_MS, signal, changed },
    )
  }
  if (action === "full") {
    const reason = asString(body.reason)?.trim().slice(0, 600)
    if (!reason) throw new ApiError(400, "说明一下为什么要完整权限")
    return ask(
      { project, agentId: agent.id, agentName: agent.name, kind: "full", reason },
      { timeoutMs: TOOL_WAIT_MS, signal, changed },
    )
  }
  throw new ApiError(400, "action 只能是 tool 或 full")
}
