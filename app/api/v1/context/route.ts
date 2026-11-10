import { boot } from "@/lib/boot"
import { handle, json } from "@/lib/http"
import { seatContext, type SeatContext } from "@/lib/context"
import { agentState, inRequest, snapshot } from "@/lib/store"

// How full each seat's conversation is in the open project (lib/context.ts),
// by seat id. Seats whose client keeps no record the room can read are left out.
// Compacting one is POST /api/v1/agents/<id> {action:"compact"}.
export async function GET(request: Request) {
  try {
    await boot()
    const project = new URL(request.url).searchParams.get("project") ?? undefined
    return json(
      await inRequest({ project }, () => {
        const contexts: Record<string, SeatContext> = {}
        for (const seat of snapshot().agents) {
          if (seat.demo) continue
          const agent = agentState(seat.id)
          const context = seatContext(agent?.agentName, agent?.session, agent ?? {})
          if (context) contexts[seat.id] = context
        }
        return { contexts }
      }),
    )
  } catch (error) {
    return handle(error)
  }
}
