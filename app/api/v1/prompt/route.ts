import { connection } from "next/server"

import { handle, json } from "@/lib/http"
import { joinPrompt } from "@/lib/prompt"


export async function GET(request: Request) {
  try {
    await connection()
    const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host")
    const proto = request.headers.get("x-forwarded-proto") ?? "http"
    const origin = host ? `${proto}://${host}` : "http://127.0.0.1:43123"
    return json({ origin, prompt: joinPrompt(origin) })
  } catch (error) {
    return handle(error)
  }
}
