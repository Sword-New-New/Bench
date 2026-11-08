import { boot } from "@/lib/boot"
import { handle, json, readBody } from "@/lib/http"
import { join } from "@/lib/store"


export async function POST(request: Request) {
  try {
    await boot()
    return json(join(await readBody(request)), 201)
  } catch (error) {
    return handle(error)
  }
}
