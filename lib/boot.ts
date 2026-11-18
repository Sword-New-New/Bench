import { connection } from "next/server"

import { ensureContinue } from "@/lib/continue"
import { ensurePatrol } from "@/lib/patrol"
import { dropDemoSeats } from "@/lib/store"
import { ensureSummon } from "@/lib/summon"

export async function boot() {
  await connection()
  dropDemoSeats()
  ensureSummon()
  ensureContinue()
  ensurePatrol()
}
