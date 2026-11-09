import { boot } from "@/lib/boot"
import { handle } from "@/lib/http"
import { currentProject, inProject, inRequest, snapshot, subscribe } from "@/lib/store"


const SPACING = 400

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
        let pending: ReturnType<typeof setTimeout> | null = null
        const send = () => {
          if (closed) return
          lastSent = Date.now()
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(inProject(project, snapshot))}\n\n`))
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
