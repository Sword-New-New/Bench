import { boot } from "@/lib/boot"
import { handle, json, readBody } from "@/lib/http"
import { createTask } from "@/lib/store"


export async function POST(request: Request) {
  try {
    await boot()
    return json(createTask(await readBody(request)), 201)
  } catch (error) {
    return handle(error)
  }
}
