import { boot } from "@/lib/boot"
import { handle } from "@/lib/http"
import { currentProject, inProject, inRequest, snapshot, subscribe } from "@/lib/store"


export async function GET(request: Request) {
  try {
    await boot()
    const project = inRequest({ project: new URL(request.url).searchParams.get("project") ?? undefined }, currentProject)
    const encoder = new TextEncoder()
    let closed = false
    let cleanup = () => {}
    const stream = new ReadableStream({
      start(controller) {
        const send = () => {
          if (closed) return
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
        const unsubscribe = subscribe(project, send)
        const keepAlive = setInterval(send, 5000)
        cleanup = () => {
          closed = true
          clearInterval(keepAlive)
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
