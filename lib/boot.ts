import { connection } from "next/server"

import { ensureDemo } from "@/lib/demo"
import { ensureSummon } from "@/lib/summon"

export async function boot() {
  await connection()
  ensureDemo()
  ensureSummon()
}
