import { boot } from "@/lib/boot"
import { ApiError, asRecord, handle, json, readBody } from "@/lib/http"
import { patrolOn, setPatrol, sweep } from "@/lib/patrol"

// The front desk's patrol (lib/patrol.ts): whether it runs, and a sweep now.
export async function GET() {
  try {
    await boot()
    return json({ on: patrolOn() })
  } catch (error) {
    return handle(error)
  }
}

export async function POST(request: Request) {
  try {
    await boot()
    const body = asRecord(await readBody(request))
    if (body.as !== "human") throw new ApiError(403, "只有用户自己能改")
    if (body.action === "on" || body.action === "off") {
      setPatrol(body.action === "on")
      // Turned on: the first look right away, not in three minutes.
      if (body.action === "on") void sweep().catch((error) => console.error(error))
      return json({ on: patrolOn() })
    }
    if (body.action === "sweep") {
      const force = body.force !== false
      const message = await sweep(force)
      return json({ posted: message?.id ?? null })
    }
    throw new ApiError(400, "action 只能是 on、off 或 sweep")
  } catch (error) {
    return handle(error)
  }
}
