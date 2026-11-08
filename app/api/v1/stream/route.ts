import { boot } from "@/lib/boot"
import { handle } from "@/lib/http"
import { snapshot, subscribe } from "@/lib/store"


export async function GET() {
  try {
    await boot()
    const encoder = new TextEncoder()
    let closed = false
    let cleanup = () => {}
    const stream = new ReadableStream({
      start(controller) {
        const send = () => {
          if (closed) return
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(snapshot())}\n\n`))
          } catch {
            closed = true
            cleanup()
          }
        }
        send()
        const unsubscribe = subscribe(send)
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
