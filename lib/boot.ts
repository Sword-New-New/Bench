import { connection } from "next/server"

import { dropDemoSeats } from "@/lib/store"
import { ensureSummon } from "@/lib/summon"

export async function boot() {
  await connection()
  dropDemoSeats()
  ensureSummon()
}
