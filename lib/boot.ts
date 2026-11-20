import { connection } from "next/server"

import { ensureBackup } from "@/lib/backup"
import { ensureContinue } from "@/lib/continue"
import { ensurePatrol } from "@/lib/patrol"
import { dropDemoSeats } from "@/lib/store"
import { ensureSummaryAuto } from "@/lib/summary-auto"
import { ensureSummon } from "@/lib/summon"

export async function boot() {
  await connection()
  dropDemoSeats()
  ensureSummon()
  ensureContinue()
  ensurePatrol()
  ensureSummaryAuto()
  ensureBackup()
}
