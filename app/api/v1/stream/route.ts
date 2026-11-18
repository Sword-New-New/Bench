import { boot } from "@/lib/boot"
import { handle } from "@/lib/http"
import { currentProject, inProject, inRequest, snapshot, subscribe } from "@/lib/store"
import type { RoomSnapshot } from "@/lib/types"


const SPACING = 400
// How old the page's copy of a moving "quiet since" may get (see shown()).
const REFRESH_MS = 60_000

// The snapshot as far as the page can tell two of them apart. A seat's
// last-seen time moves with every pulse of its bridge (20 s), and so does the
// "quiet since" worked out from it (lib/owes.ts). The page reads the first
// only for a seat that is offline, and holds the second against the clock
// (PARKED_MS, three minutes). Left out for the seats that are online, the
// text changes only when there is something new to draw; `moving` says a
// seat's "quiet since" was left out, so the page's copy of it needs a refresh
// now and then.
function shown(room: RoomSnapshot) {
  let moving = false
  const agents = room.agents.map((agent) => {
    if (agent.status === "offline") return agent
    if (agent.owes) moving = true
    return { ...agent, lastSeenAt: 0, owes: agent.owes && { ...agent.owes, since: 0 } }
  })
  return { key: JSON.stringify({ ...room, agents }), moving }
}

export async function GET(request: Request) {
  try {
    await boot()
    const project = inRequest({ project: new URL(request.url).searchParams.get("project") ?? undefined }, currentProject)
    const encoder = new TextEncoder()
    let closed = false
    let cleanup = () => {}
    const stream = new ReadableStream({
      start(controller) {
        let lastSent = 0
        let lastKey = ""
        let pending: ReturnType<typeof setTimeout> | null = null
        // The room goes out when the page would see a difference. The check
        // every five seconds is what notices a seat going offline (no pulse,
        // so nothing fires); it used to send the whole room each time, and a
        // pulse changed the text, so the page parsed and redrew everything
        // every few seconds with nothing going on. A comment line keeps the
        // connection open instead.
        const send = () => {
          if (closed) return
          try {
            const room = inProject(project, snapshot)
            const { key, moving } = shown(room)
            const now = Date.now()
            if (key === lastKey && !(moving && now - lastSent >= REFRESH_MS)) {
              controller.enqueue(encoder.encode(": nothing new\n\n"))
              return
            }
            lastKey = key
            lastSent = now
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(room)}\n\n`))
          } catch {
            // The page went away, or the project was deleted.
            closed = true
            cleanup()
            try {
              controller.close()
            } catch {}
          }
        }
        send()
        // A busy room fires many changes a second, and every one used to send the
        // whole room again. Changes within 400ms of the last send go out together.
        const later = () => {
          if (pending || closed) return
          pending = setTimeout(() => {
            pending = null
            send()
          }, Math.max(0, SPACING - (Date.now() - lastSent)))
        }
        const unsubscribe = subscribe(project, later)
        const keepAlive = setInterval(send, 5000)
        cleanup = () => {
          closed = true
          clearInterval(keepAlive)
          if (pending) clearTimeout(pending)
          unsubscribe()
        }
      },
      cancel() {
        cleanup()
      },
    })
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    })
  } catch (error) {
    return handle(error)
  }
}
