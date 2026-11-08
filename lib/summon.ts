import { spawn } from "node:child_process"

import { commandFor } from "@/lib/adapters"
import { onMessage, postSystem, summonCandidates } from "@/lib/store"
import type { Message } from "@/lib/types"

const SUMMON_GAP_MS = 8_000
const NOTE_GAP_MS = 30_000

type SummonGlobal = typeof globalThis & {
  __benchSummonBound?: boolean
  __benchSummonHandler?: (message: Message) => void
  __benchSummonAt?: Map<string, number>
}

function clock() {
  const g = globalThis as SummonGlobal
  if (!g.__benchSummonAt) g.__benchSummonAt = new Map()
  return g.__benchSummonAt
}

function cooled(key: string, gap: number) {
  const at = clock()
  const now = Date.now()
  const last = at.get(key) ?? 0
  if (now - last < gap) return false
  at.set(key, now)
  return true
}

function wake(message: Message) {
  if (message.kind === "system") return
  for (const agent of summonCandidates(message)) {
    if (!agent.agentName || !agent.session) {
      if (cooled(`${agent.id}:session`, NOTE_GAP_MS)) {
        postSystem(`${agent.name} 被点到了，还没报 agent 和 uuid`)
      }
      continue
    }
    const command = commandFor(
      agent.agentName,
      agent.session,
      `${message.authorName}: ${message.text}`,
    )
    if (!command) {
      if (cooled(`${agent.id}:config`, NOTE_GAP_MS)) {
        postSystem(`${agent.name} 被点到了，还没有 ${agent.agentName} 的唤起模板`)
      }
      continue
    }
    if (!cooled(`${agent.id}:run`, SUMMON_GAP_MS)) continue
    try {
      const child = spawn(command, {
        shell: true,
        detached: true,
        stdio: "ignore",
        env: {
          ...process.env,
          BENCH_AGENT: agent.agentName,
          BENCH_UUID: agent.session,
          BENCH_SESSION: agent.session,
        },
      })
      child.on("error", () => {
        postSystem(`唤起 ${agent.name} 失败`)
      })
      child.unref()
      postSystem(`已唤起 ${agent.name}`)
    } catch (error) {
      console.error(error)
      postSystem(`唤起 ${agent.name} 失败`)
    }
  }
}

export function ensureSummon() {
  const g = globalThis as SummonGlobal
  g.__benchSummonHandler = wake
  if (g.__benchSummonBound) return
  g.__benchSummonBound = true
  onMessage((message) => g.__benchSummonHandler?.(message))
}
