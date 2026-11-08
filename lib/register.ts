import { execFile } from "node:child_process"
import path from "node:path"

import { summonPath } from "@/lib/adapters"
import { ApiError } from "@/lib/http"
import { kindById } from "@/lib/kinds"

export type RegisterResult = { kind: string; ok: boolean; output: string }

const LIMIT_MS = 60_000

// Runs scripts/register-mcp.sh for one kind, as the user the room runs as:
// the same as pasting the command into their own terminal. Only kind ids from
// lib/kinds.ts get through, and no shell is involved.
function registerOne(kind: string): Promise<RegisterResult> {
  const script = path.join(process.cwd(), "scripts", "register-mcp.sh")
  return new Promise((resolve) => {
    execFile(
      script,
      [kind],
      { cwd: process.cwd(), timeout: LIMIT_MS, env: { ...process.env, PATH: summonPath() }, maxBuffer: 256_000 },
      (error, stdout, stderr) => {
        const output = `${stdout}${stderr}`.trim().slice(-1200)
        const why = error?.killed ? "超过 60 秒没结束，已停掉" : ""
        resolve({ kind, ok: !error, output: [output, why].filter(Boolean).join("\n") })
      },
    )
  })
}

export async function register(input: unknown) {
  if (!Array.isArray(input) || input.length === 0) throw new ApiError(400, "kinds 要是一个非空列表")
  const kinds = [...new Set(input.map((item) => (typeof item === "string" ? item.trim() : "")))]
  const unknown = kinds.filter((kind) => !kindById(kind))
  if (unknown.length > 0) throw new ApiError(400, `不认识的 agent：${unknown.join("、")}`)
  // One after another: several kinds can touch the same config file.
  const results: RegisterResult[] = []
  for (const kind of kinds) results.push(await registerOne(kind))
  return results
}
