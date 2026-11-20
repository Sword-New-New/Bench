import { awayLines, lineWeight, type AwayOverview } from "@/lib/away-shared"
import { whenText } from "@/lib/limits"
import { inProject, listProjects, resolveProjectInfo, snapshot } from "@/lib/store"
import { ApiError } from "@/lib/http"

// GET /api/v1/away: what happened since a moment, for the card the page draws
// when the user comes back (lib/away-shared.ts). Read-only: it builds the
// answer from what the rooms already hold and stores nothing.

function linesOf(projectId: string, since: number, now: number) {
  return inProject(projectId, () => {
    const snap = snapshot()
    return awayLines({
      messages: snap.messages,
      tasks: snap.tasks,
      agents: snap.agents,
      permits: snap.permits ?? [],
      openAsks: snap.openAsks,
      since,
      now,
      when: (at) => whenText(at, now),
    })
  })
}

export function awayOverview(sinceInput: unknown, projectRef?: string, now = Date.now()): AwayOverview {
  const since = Number(sinceInput)
  if (!Number.isFinite(since) || since <= 0) throw new ApiError(400, "since 要是一个毫秒时间戳")
  const from = Math.min(since, now)
  const ref = projectRef?.trim()
  const target = ref ? resolveProjectInfo(ref) : undefined
  if (target && !target.front) {
    return { since: from, now, scope: "project", lines: linesOf(target.id, from, now), projects: [] }
  }
  const projects = listProjects()
    .filter((project) => !project.front)
    .map((project) => ({ projectId: project.id, projectName: project.name, lines: linesOf(project.id, from, now) }))
    .filter((project) => project.lines.length > 0)
    .map((project) => ({ ...project, lines: [...project.lines].sort((a, b) => lineWeight(a) - lineWeight(b)).slice(0, 2) }))
    .sort((a, b) => lineWeight(a.lines[0]) - lineWeight(b.lines[0]) || a.projectName.localeCompare(b.projectName))
  return { since: from, now, scope: "front", lines: [], projects }
}
