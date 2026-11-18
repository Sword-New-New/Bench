import { dbGetMeta, dbSetMeta } from "@/lib/db"
import { ApiError, asRecord, asString } from "@/lib/http"
import { inProject, requireAnySeat, resolveProjectInfo, snapshot } from "@/lib/store"

// Watched projects table (t_0fefb44c): when the user tells the front desk to
// watch a project (or a project's own coordinator asks the desk to watch it),
// patrol checks whether all seats there have stopped for 10 minutes with quota
// available and work still unfinished, and lets `bench_nudge` speak directly to
// that coordinator under the front desk's own name.

const META_WATCH = "front.watch"

export type WatchedProject = {
  projectId: string
  projectName: string
  seatId: string
  seatName: string
  by: string
  startedAt: number
  lastNudgeAt?: number
}

export function listWatchedProjects(): Record<string, WatchedProject> {
  try {
    const raw = JSON.parse(dbGetMeta(META_WATCH) ?? "") as Record<string, WatchedProject>
    if (!raw || typeof raw !== "object") return {}
    const out: Record<string, WatchedProject> = {}
    for (const [k, v] of Object.entries(raw)) {
      if (v && typeof v === "object" && typeof v.projectId === "string" && typeof v.seatId === "string") {
        out[k] = v
      }
    }
    return out
  } catch {
    return {}
  }
}

function saveWatchedProjects(map: Record<string, WatchedProject>) {
  const keys = Object.keys(map)
  dbSetMeta(META_WATCH, keys.length > 0 ? JSON.stringify(map) : "")
}

export function getWatchedProject(projectId: string): WatchedProject | undefined {
  return listWatchedProjects()[projectId]
}

export function removeWatchedProject(projectId: string): WatchedProject | undefined {
  const map = listWatchedProjects()
  const prev = map[projectId]
  if (!prev) return undefined
  delete map[projectId]
  saveWatchedProjects(map)
  return prev
}

export function markWatchNudged(projectId: string, at = Date.now()) {
  const map = listWatchedProjects()
  const entry = map[projectId]
  if (!entry) return
  entry.lastNudgeAt = at
  saveWatchedProjects(map)
}

export function setProjectWatch(input: unknown, now = Date.now()) {
  const caller = requireAnySeat(input)
  const body = asRecord(input)
  const on = body.on === undefined ? true : Boolean(body.on)
  if (body.on !== undefined && typeof body.on !== "boolean") {
    throw new ApiError(400, "on 只能是 true 或 false")
  }

  if (caller.front) {
    const projRef = asString(body.project)?.trim()
    if (!projRef) throw new ApiError(400, "前台设置盯防时要填 project（项目名字或 id）")
    const target = resolveProjectInfo(projRef)
    if (target.front) throw new ApiError(400, "前台自己不用盯")

    if (!on) {
      const removed = removeWatchedProject(target.id)
      return { watching: false, project: { id: target.id, name: target.name }, removed: Boolean(removed) }
    }

    const seatRef = asString(body.seat)?.trim().replace(/^@/, "")
    if (!seatRef) throw new ApiError(400, "要填 seat（那个项目的统筹席位名）")
    const seat = inProject(target.id, () =>
      snapshot().agents.find((item) => item.id === seatRef || item.name === seatRef),
    )
    if (!seat) throw new ApiError(404, `「${target.name}」里没有叫 ${seatRef} 的席位`)
    if (seat.demo) throw new ApiError(400, `${seat.name} 是演示席位，不能设成统筹`)

    const map = listWatchedProjects()
    const prev = map[target.id]
    const entry: WatchedProject = {
      projectId: target.id,
      projectName: target.name,
      seatId: seat.id,
      seatName: seat.name,
      by: `前台（${caller.seatName}）`,
      startedAt: now,
      ...(prev?.lastNudgeAt ? { lastNudgeAt: prev.lastNudgeAt } : {}),
    }
    map[target.id] = entry
    saveWatchedProjects(map)
    return { watching: true, watch: entry }
  }

  // Ordinary project seat: may ONLY configure its own project, and the coordinator is itself.
  const projRef = asString(body.project)?.trim()
  if (projRef) {
    let resolved: { id: string }
    try {
      resolved = resolveProjectInfo(projRef)
    } catch {
      throw new ApiError(403, "普通项目的席位只能给自己所在的项目设盯防")
    }
    if (resolved.id !== caller.projectId) {
      throw new ApiError(403, "普通项目的席位只能给自己所在的项目设盯防")
    }
  }
  const seatRef = asString(body.seat)?.trim().replace(/^@/, "")
  if (seatRef && seatRef !== caller.seatId && seatRef !== caller.seatName) {
    throw new ApiError(403, "普通项目的席位设盯防时，统筹只能是调用者自己")
  }

  if (!on) {
    const removed = removeWatchedProject(caller.projectId)
    return {
      watching: false,
      project: { id: caller.projectId, name: caller.projectName },
      removed: Boolean(removed),
    }
  }

  const map = listWatchedProjects()
  const prev = map[caller.projectId]
  const entry: WatchedProject = {
    projectId: caller.projectId,
    projectName: caller.projectName,
    seatId: caller.seatId,
    seatName: caller.seatName,
    by: caller.seatName,
    startedAt: now,
    ...(prev?.lastNudgeAt ? { lastNudgeAt: prev.lastNudgeAt } : {}),
  }
  map[caller.projectId] = entry
  saveWatchedProjects(map)
  return { watching: true, watch: entry }
}
