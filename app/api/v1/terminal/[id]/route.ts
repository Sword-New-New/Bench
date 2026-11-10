import { boot } from "@/lib/boot"
import { HUMAN_HEADER, isHumanKey } from "@/lib/human"
import { ApiError, asRecord, handle, json, readBody } from "@/lib/http"
import { inSeat, userName } from "@/lib/store"
import { openSeatTerminal } from "@/lib/summon"
import { closeTerminal, resizeTerminal, typeIn, watchTerminal } from "@/lib/terminal"

// A seat's live terminal (lib/terminal.ts). It runs commands as you, and its
// screen can show anything the session sees, so both ways need the user's key.

// The screen: what it shows so far, then every change, as server-sent events.
export async function GET(request: Request, ctx: RouteContext<"/api/v1/terminal/[id]">) {
  try {
    await boot()
    if (!isHumanKey(request.headers.get(HUMAN_HEADER))) throw new ApiError(403, `只有 ${userName()} 本人能看终端`)
    const { id } = await ctx.params
    const encoder = new TextEncoder()
    let cleanup = () => {}
    const stream = new ReadableStream({
      start(controller) {
        let closed = false
        const put = (text: string) => {
          if (closed) return
          try {
            controller.enqueue(encoder.encode(text))
          } catch {
            cleanup()
          }
        }
        const stop = watchTerminal(
          id,
          (data) => put(`data: ${JSON.stringify(data)}\n\n`),
          (code) => {
            put(`event: exit\ndata: ${code}\n\n`)
            cleanup()
            try {
              controller.close()
            } catch {}
          },
        )
        if (!stop) {
          put("event: exit\ndata: -1\n\n")
          closed = true
          controller.close()
          return
        }
        const ping = setInterval(() => put(": ping\n\n"), 15_000)
        cleanup = () => {
          closed = true
          clearInterval(ping)
          stop()
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
      },
    })
  } catch (error) {
    return handle(error)
  }
}

// open (with cols, rows), input (data), resize (cols, rows), close.
export async function POST(request: Request, ctx: RouteContext<"/api/v1/terminal/[id]">) {
  try {
    await boot()
    const { id } = await ctx.params
    const body = asRecord(await readBody(request))
    if (body.as !== "human") throw new ApiError(403, `终端只有 ${userName()} 本人能开、能打字`)
    if (body.action === "open") return json(inSeat(id, () => openSeatTerminal(id, body.cols, body.rows)))
    if (body.action === "input") {
      typeIn(id, body.data)
      return json({ ok: true })
    }
    if (body.action === "resize") {
      resizeTerminal(id, body.cols, body.rows)
      return json({ ok: true })
    }
    if (body.action === "close") return json(closeTerminal(id))
    throw new ApiError(400, "action 只能是 open、input、resize 或 close")
  } catch (error) {
    return handle(error)
  }
}
