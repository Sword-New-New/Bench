import { adapterFor, modelOf } from "@/lib/adapters"
import { boot } from "@/lib/boot"
import { handle, json } from "@/lib/http"
import { effortLevels, modelChoices } from "@/lib/models"

// The models the page offers for a kind (「开新会话」 and a seat's 「换模型…」).
// The user can always type another id. `fallback` is the default, if known.
export async function GET(request: Request) {
  try {
    await boot()
    const kind = new URL(request.url).searchParams.get("kind") ?? ""
    const adapter = adapterFor(kind)
    // What an unpicked seat runs on, where its command or client config says.
    const fallback = (adapter && modelOf(adapter)) || null
    return json({ models: modelChoices(kind), fallback, efforts: effortLevels(kind) })
  } catch (error) {
    return handle(error)
  }
}
