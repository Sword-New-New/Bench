import { randomBytes, timingSafeEqual } from "node:crypto"
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

// The key that makes a request the user's own. `as: "human"` alone used to be
// enough, so any agent could approve its own permits with one curl. Now
// readBody refuses `as: "human"` without this key in the x-bench-human header.
//
// It lives only in data/human-key (mode 600, kept across restarts so open
// tabs stay signed in). Not in the page and not in the server's output: the
// launchers (scripts/open-room.mjs) open the room as /?key=…, and the page
// keeps it in localStorage (components/room/api.ts). An agent that reads this
// file still gets it: it runs as the same user. What it stops is the casual
// curl, and posting as the user by following a doc or a prompt.
export const HUMAN_HEADER = "x-bench-human"

const store = globalThis as typeof globalThis & { __benchHumanKey?: string }

export function humanKey(): string {
  if (store.__benchHumanKey) return store.__benchHumanKey
  const file = path.join(process.env.BENCH_DATA_DIR || path.join(process.cwd(), "data"), "human-key")
  let key = ""
  try {
    key = readFileSync(file, "utf8").trim()
  } catch {}
  if (!/^[0-9a-f]{64}$/.test(key)) {
    key = randomBytes(32).toString("hex")
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, `${key}\n`, { mode: 0o600 })
  }
  try {
    chmodSync(file, 0o600)
  } catch {}
  store.__benchHumanKey = key
  return key
}

export function isHumanKey(value: string | null): boolean {
  if (!value) return false
  const want = Buffer.from(humanKey())
  const got = Buffer.from(value)
  return got.length === want.length && timingSafeEqual(got, want)
}
