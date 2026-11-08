import { boot } from "@/lib/boot"
import { handle, json } from "@/lib/http"
import { snapshot } from "@/lib/store"


export async function GET() {
  try {
    await boot()
    return json(snapshot())
  } catch (error) {
    return handle(error)
  }
}
