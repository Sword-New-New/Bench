import { boot } from "@/lib/boot"
import { ApiError, asRecord, handle, json, readBody } from "@/lib/http"
import { listRuns } from "@/lib/runs"
import { adapterFor, modelOf } from "@/lib/adapters"
import { checkPct, checkWindow } from "@/lib/context"
import { checkEffort, checkPick } from "@/lib/models"
import {
  agentState,
  currentProjectInfo,
  getSeatProfile,
  inSeat,
  renameAgent,
  setAutoFull,
  setSeatModel,
  setSeatProfile,
} from "@/lib/store"
import { rebindSession, renameSeatFiles, seatDir, switchBackBinding } from "@/lib/spawn"
import { dropQueuedMessage, pauseQueue, requestCompact, requestGoal, stopAgent, whisper } from "@/lib/summon"

// What you said to this seat alone (default), or its portable profile (`?view=profile`).
export async function GET(request: Request, ctx: RouteContext<"/api/v1/agents/[id]">) {
  try {
    await boot()
    const { id } = await ctx.params
    const url = new URL(request.url)
    if (url.searchParams.get("view") === "profile") {
      return json(
        inSeat(id, () => ({
          ...getSeatProfile(id),
          workdir: seatDir(id) ?? currentProjectInfo().dir ?? process.cwd(),
        })),
      )
    }
    return json({ runs: listRuns(id, "private") })
  } catch (error) {
    return handle(error)
  }
}

// From the page: stop what a seat is running, say something to it alone, give it
// another name or model, compact its context, manage its wake queue, edit its
// persona/memory, or rebind it across AI vendors.
export async function POST(request: Request, ctx: RouteContext<"/api/v1/agents/[id]">) {
  try {
    await boot()
    const { id } = await ctx.params
    const body = asRecord(await readBody(request))
    if (body.as !== "human") throw new ApiError(400, "只有这台电脑上的人能这么做")
    if (body.action === "stop") return json(inSeat(id, () => stopAgent(id)))
    if (body.action === "compact") return json(inSeat(id, () => requestCompact(id)))
    if (body.action === "goal") return json(inSeat(id, () => requestGoal(id, body.text)))
    if (body.action === "whisper") return json(inSeat(id, () => whisper(id, typeof body.text === "string" ? body.text : "")))
    if (body.action === "queue_pause") return json(inSeat(id, () => pauseQueue(id, true)))
    if (body.action === "auto_full") return json(inSeat(id, () => setAutoFull(id, body.on === true)))
    if (body.action === "queue_resume") return json(inSeat(id, () => pauseQueue(id, false)))
    if (body.action === "queue_drop") {
      const messageId = typeof body.messageId === "string" ? body.messageId : undefined
      return json(inSeat(id, () => dropQueuedMessage(id, messageId)))
    }
    if (body.action === "profile") {
      return json(
        inSeat(id, () =>
          setSeatProfile(id, {
            persona: typeof body.persona === "string" ? body.persona : undefined,
            memory: typeof body.memory === "string" ? body.memory : undefined,
          }),
        ),
      )
    }
    if (body.action === "rebind") {
      return json(await inSeat(id, () => rebindSession(id, body)))
    }
    if (body.action === "restore_binding") {
      const index = Number(body.index ?? 0)
      if (!Number.isInteger(index) || index < 0) throw new ApiError(400, "index 不对")
      return json(inSeat(id, () => switchBackBinding(id, index)))
    }
    if (body.action === "rename") {
      return json(
        inSeat(id, () => {
          const result = renameAgent(id, body.name)
          renameSeatFiles(id, currentProjectInfo().id, result.agent.name)
          return result
        }),
      )
    }
    if (body.action === "model") {
      const pick = checkPick(body.model)
      return json(
        inSeat(id, () => {
          const kind = agentState(id)?.agentName ?? ""
          const effort = checkEffort(kind, body.effort)
          const window = checkWindow(body.window)
          const pct = checkPct(body.compactPct)
          const adapter = adapterFor(kind)
          // Back to the default: say what that is, where the room can tell.
          const fallback = kind === "claude" ? "Claude Code" : (adapter && modelOf(adapter)) || agentState(id)?.model || ""
          const shown = pick ?? fallback
          return setSeatModel(id, pick, shown, effort, window, pct)
        }),
      )
    }
    throw new ApiError(
      400,
      "action 只能是 stop、whisper、rename、model、compact、goal、queue_pause、queue_resume、queue_drop、profile、rebind 或 restore_binding",
    )
  } catch (error) {
    return handle(error)
  }
}
