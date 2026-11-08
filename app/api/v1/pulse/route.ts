import { boot } from "@/lib/boot"
import { handle, json, readBody } from "@/lib/http"
import { pulse } from "@/lib/store"


export async function POST(request: Request) {
  try {
    await boot()
    return json(pulse(await readBody(request)))
  } catch (error) {
    return handle(error)
  }
}
