import { boot } from "@/lib/boot"
import { ApiError, handle } from "@/lib/http"
import { isHumanKey } from "@/lib/human"
import { audioAvailable, listenAudio } from "@/lib/audio"

// The computer's sound as band levels, one JSON line per frame, for the
// rhythm beside the thread (lib/audio.ts). Only the user's own page may
// listen: it says what is playing, if not the sound itself.
export async function GET(request: Request) {
  try {
    await boot()
    if (!isHumanKey(request.headers.get("x-bench-human"))) throw new ApiError(403, "只有用户自己的页面能听")
    if (!audioAvailable()) return new Response(null, { status: 204 })
    const encoder = new TextEncoder()
    let stop = () => {}
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        stop = listenAudio((frame) => {
          try {
            controller.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`))
          } catch {
            stop()
          }
        })
        request.signal.addEventListener("abort", () => {
          stop()
          try {
            controller.close()
          } catch {}
        })
      },
      cancel() {
        stop()
      },
    })
    return new Response(stream, {
      headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" },
    })
  } catch (error) {
    return handle(error)
  }
}
