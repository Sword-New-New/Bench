import { boot } from "@/lib/boot"
import { handle, json, readBody } from "@/lib/http"
import { leave } from "@/lib/store"


export async function POST(request: Request) {
  try {
    await boot()
    return json(leave(await readBody(request)))
  } catch (error) {
    return handle(error)
  }
}
