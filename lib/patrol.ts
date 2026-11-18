import { execFile } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import { dbGetMeta, dbSetMeta } from "@/lib/db"
import { isLaneIdle, isSeatStoppedByUser } from "@/lib/lane-state"
import { isKindQuotaBlocked } from "@/lib/quota"
import { awaitingReview } from "@/lib/review"
import { activeRun } from "@/lib/runs"
import { agentState, brokenCallsInRoom, inProject, limitedAgentNames, listProjects, postRisk, snapshot } from "@/lib/store"
import { terminalOpen } from "@/lib/terminal-state"
import type { PatrolRisk, RiskItem, RiskLevel, RunStep } from "@/lib/types"
import { listWatchedProjects, removeWatchedProject, type WatchedProject } from "@/lib/watch"

// The front desk's patrol (AverageJoe 2026-11-16, t_8c888d57): the desk's AI
// (an expensive model) talks with the user, works out what they mean and
// decides; the patrol, cheap, watches the other projects' seats work and
// reports risks. Most of it is rules over what the room already knows
// (snapshot: seats that stopped owing work, calls that failed, to-dos stuck
// or waiting on the user). Only a seat that has been at one wake for a long
// time is read by a cheap model (dsh-agent, one shot, no seat), to tell
// going in circles from slow progress.
//
// To the user the desk is one AI (AverageJoe m_2dab84ab: how the two work
// it out between them stays out of sight). Each sweep leaves what is new as
// a note for the desk's AI (Message.risk), which the page doesn't show; the
// AI reads it the next time it is woken. Something serious wakes it now, at
// most every WAKE_GAP, and it tells the user in its own words. The first
// sweep only takes note of what was already there. Keys of what was told are
// kept in meta, so a restart doesn't tell it again.

const SWEEP_MS = 3 * 60_000
// The first sweep, a little after the room starts.
const FIRST_MS = 20_000
const WAKE_GAP = 30 * 60_000
const PERMIT_LATE = 15 * 60_000
const ASK_LATE = 30 * 60_000
const REVIEW_LATE = 2 * 60 * 60_000
const STALE = 4 * 60 * 60_000
// A wake this long is read by the cheap model, again each time it runs this much longer.
const LONG_RUN = 40 * 60_000
const MAX_READS = 2
const NOTE_ITEMS = 8
const KEEP_SEEN = 3 * 24 * 60 * 60_000
const META_SEEN = "patrol.seen"
const META_OFF = "patrol.off"
const META_WOKE = "patrol.wokeAt"
const DEFAULT_WATCH_IDLE_MS = 10 * 60_000
// A wake still open but quiet this long counts as stopped in a watched project.
const DEFAULT_WATCH_HANG_MS = 30 * 60_000
const DEFAULT_WATCH_EXPIRE_MS = 24 * 60 * 60_000

function envMs(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === "") return fallback
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

export function watchIdleMs() {
  return envMs("BENCH_WATCH_IDLE_MS", DEFAULT_WATCH_IDLE_MS)
}

export function watchHangMs() {
  return Math.max(1_000, envMs("BENCH_WATCH_HANG_MS", DEFAULT_WATCH_HANG_MS))
}

export function watchExpireMs() {
  return Math.max(1_000, envMs("BENCH_WATCH_EXPIRE_MS", DEFAULT_WATCH_EXPIRE_MS))
}

// Bumped when patrol's sweep rules change so hot-reload replaces the old timer closure.
const PATROL_VERSION = 3

type State = {
  version?: number
  timer?: ReturnType<typeof setInterval>
  first?: ReturnType<typeof setTimeout>
  busy?: boolean
}
const g = globalThis as typeof globalThis & { __benchPatrol?: State }

function state() {
  return (g.__benchPatrol ??= {})
}

// Off until the user turns it on at the desk (FrontBar).
export function patrolOn() {
  return dbGetMeta(META_OFF) === "0"
}

export function setPatrol(on: boolean) {
  dbSetMeta(META_OFF, on ? "0" : "1")
}

// Started with the room (lib/boot.ts); once per process/version, across hot reloads.
export function ensurePatrol() {
  const s = state()
  if (s.timer && s.version === PATROL_VERSION) return
  if (s.first) clearTimeout(s.first)
  if (s.timer) clearInterval(s.timer)
  s.version = PATROL_VERSION
  s.first = setTimeout(() => void sweep(), FIRST_MS)
  s.timer = setInterval(() => void sweep(), SWEEP_MS)
  s.first.unref?.()
  s.timer.unref?.()
}

function readSeen(): Record<string, number> {
  try {
    const parsed = JSON.parse(dbGetMeta(META_SEEN) ?? "")
    return parsed && typeof parsed === "object" ? parsed : {}
  } catch {
    return {}
  }
}

function minutes(ms: number) {
  if (ms < 90 * 60_000) return `${Math.max(1, Math.round(ms / 60_000))} 分钟`
  return `${Math.round(ms / 3_600_000)} 小时`
}

function clip(text: string, max: number) {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

type Found = RiskItem & {
  read?: { agentName: string; steps: RunStep[]; body: string; age: number }
  watch?: true
}

function lookWatched(
  project: { id: string; name: string },
  watched: WatchedProject,
  snap: ReturnType<typeof snapshot>,
  limitedKinds: ReadonlySet<string>,
  now: number,
): Found[] {
  const out: Found[] = []

  // Auto-stop after 24 hours if still unfinished.
  if (now - watched.startedAt >= watchExpireMs()) {
    removeWatchedProject(project.id)
    out.push({
      key: `watch-expired:${project.id}:${watched.startedAt}`,
      projectId: project.id,
      project: project.name,
      level: "low",
      text: `${project.name} 盯满 24 小时还没完，自动不再盯了`,
      watch: true,
    })
    return out
  }

  const realSeats = snap.agents.filter((s) => !s.demo)
  // When a seat last did something: its run's last step, what it said, its
  // to-dos, messages it took mid-run. Not lastSeenAt, which its client
  // refreshes while it hangs. The latest of all, as one client's steps can
  // lag (Antigravity).
  const activityAt = (seat: (typeof realSeats)[number]) =>
    Math.max(
      seat.stepAt ?? 0,
      seat.runStartedAt ?? 0,
      seat.ranUntil ?? 0,
      ...snap.messages.filter((m) => m.authorId === seat.id).map((m) => m.createdAt),
      ...snap.messages.flatMap((m) => (m.reached ?? []).filter((r) => r.id === seat.id).map((r) => r.at)),
      ...snap.tasks.filter((t) => t.ownerId === seat.id).map((t) => t.updatedAt),
    )
  // A wake open with nothing to show for this long counts as stopped
  // (2026-11-17: a seat sat in one wake for 6 hours, the desk took it as working).
  const hung = realSeats.filter((s) => Boolean(s.runId) && now - activityAt(s) >= watchHangMs())
  const busy = (s: (typeof realSeats)[number]) =>
    Boolean(s.runId) ||
    s.status === "working" ||
    Boolean(s.terminal) ||
    terminalOpen(s.id) ||
    Boolean(s.queuedCount) ||
    Boolean(s.retry) ||
    !isLaneIdle(s.id)
  const anyBusyOrQueued = realSeats.some(busy)
  const anyMoving = realSeats.some((s) => !hung.includes(s) && busy(s))

  // Unfinished work that is NOT waiting for the user's review.
  const unfinishedWork = snap.tasks.filter((t) => t.status !== "done" && !awaitingReview(t))
  const hadAnyTasks = snap.tasks.length > 0 || (snap.doneTotal ?? 0) > 0

  // Auto-stop when all unfinished work is cleared (all done or all waiting on the user).
  if (hadAnyTasks && unfinishedWork.length === 0 && !anyBusyOrQueued) {
    removeWatchedProject(project.id)
    out.push({
      key: `watch-done:${project.id}:${watched.startedAt}`,
      projectId: project.id,
      project: project.name,
      level: "low",
      text: `${project.name} 的活都交了，在等用户`,
      watch: true,
    })
    return out
  }

  if (unfinishedWork.length === 0 || anyMoving) return out

  const coord =
    realSeats.find((s) => s.id === watched.seatId) ??
    realSeats.find((s) => s.name === watched.seatName)
  if (!coord) return out

  // Guard: coordinator's client is blocked by usage/quota limit.
  const rawCoord = agentState(coord.id)
  const coordKind = rawCoord?.agentName || coord.agentName
  if (coordKind && (limitedKinds.has(coordKind) || isKindQuotaBlocked(coordKind, now))) return out

  // Guard: stopped or paused intentionally by the user.
  if (isSeatStoppedByUser(coord.id) || coord.queuePaused) return out
  const activeOwners = unfinishedWork
    .map((t) => (t.ownerId ? realSeats.find((s) => s.id === t.ownerId) : undefined))
    .filter((s): s is NonNullable<typeof s> => Boolean(s))
  if (
    activeOwners.length > 0 &&
    activeOwners.every((s) => isSeatStoppedByUser(s.id) || Boolean(s.queuePaused))
  ) {
    return out
  }

  // The stretch of quiet starts at the last thing anyone did there: a seat
  // ran or took a step, someone spoke (the desk's own nudge too), a to-do
  // moved. It is the key, so one stretch is told once however long it lasts,
  // and the next only after something happened and it went quiet again.
  const lastSeatAt = Math.max(0, ...realSeats.map(activityAt))
  const lastTalkAt = Math.max(
    0,
    ...snap.messages.filter((m) => m.authorId !== "patrol").map((m) => m.createdAt ?? 0),
  )
  const lastTaskAt = Math.max(0, ...snap.tasks.map((t) => t.updatedAt ?? 0))
  const idleSince = Math.max(lastSeatAt, lastTalkAt, lastTaskAt, watched.lastNudgeAt ?? 0) || watched.startedAt
  if (now - idleSince < watchIdleMs()) return out

  const titles = unfinishedWork
    .slice(0, 3)
    .map((t) => `「${clip(t.title, 28)}」`)
    .join("、")
  const work = `额度还有，还有 ${unfinishedWork.length} 件没做完（${titles}${unfinishedWork.length > 3 ? " 等" : ""}）。统筹是 ${coord.name}。`
  const text = hung.length
    ? `${hung
        .map((s) => `${s.name} 这一轮开了 ${minutes(now - (s.runStartedAt ?? activityAt(s)))}，最近 ${Math.round((now - activityAt(s)) / 60_000)} 分钟没动静`)
        .join("；")}，别的席位都停着，${work}只有用户能停下一轮：先用 bench_peek 看它是不是真卡住了；真卡住了，用 bench_nudge 告诉统筹，再用你自己的话请用户点它的「停止」。`
    : `席位全停了 ${minutes(now - idleSince)}，${work}先用 bench_peek 看是不是卡住：别人已经交了活而统筹没接上、或者谁断了没人管，就用 bench_nudge 叫统筹接着推进（盯着的项目里这句会直接发出，不用用户点）；确实都做完了、只剩等用户的，就不用叫，下次用户问起时说一句做到哪了。`
  out.push({
    key: `watch:${project.id}:${idleSince}`,
    projectId: project.id,
    project: project.name,
    level: "high",
    text,
    ref: { kind: "task", id: unfinishedWork[0].id },
    watch: true,
  })
  return out
}

// What the rules see in one project now.
function look(
  project: { id: string; name: string },
  now: number,
  options: { onlyWatch?: boolean; watched?: WatchedProject; limitedKinds?: ReadonlySet<string> } = {},
): Found[] {
  const snap = snapshot()
  const out: Found[] = []
  if (options.watched) {
    out.push(...lookWatched(project, options.watched, snap, options.limitedKinds ?? new Set(), now))
  }
  if (options.onlyWatch) return out
  const add = (key: string, level: RiskLevel, text: string, ref?: RiskItem["ref"]) =>
    out.push({ key, projectId: project.id, project: project.name, level, text, ref })

  for (const seat of snap.agents) {
    if (seat.demo) continue
    const owes = seat.owes
    if (owes && seat.status !== "working" && owes.tasks.length + owes.calls.length > 0) {
      const ids = [...owes.tasks.map((t) => t.id), ...owes.calls.map((c) => c.messageId)].sort()
      const what = owes.tasks[0] ? `「${clip(owes.tasks[0].title, 30)}」（${owes.tasks[0].id}）` : `被点名的话（${owes.calls[0].messageId}）`
      const n = owes.tasks.length + owes.calls.length
      add(
        `owes:${seat.id}:${ids.join(",")}`,
        "mid",
        `${seat.name} 停了 ${minutes(now - owes.since)}，还欠着 ${what}${n > 1 ? ` 等 ${n} 件` : ""}`,
        owes.tasks[0] ? { kind: "task", id: owes.tasks[0].id } : { kind: "message", id: owes.calls[0].messageId },
      )
    }
    const run = seat.runId ? activeRun(seat.id) : null
    if (run && now - run.startedAt >= LONG_RUN) {
      const age = now - run.startedAt
      const round = Math.floor(age / LONG_RUN)
      out.push({
        key: `long:${run.id}:${round}`,
        projectId: project.id,
        project: project.name,
        level: "high",
        text: `${seat.name} 这一轮跑了 ${minutes(age)}`,
        ref: { kind: "run", id: run.id },
        read: { agentName: seat.name, steps: run.steps ?? [], body: run.body ?? "", age },
      })
    }
  }

  for (const call of brokenCallsInRoom()) {
    if (call.state === "retrying") continue
    add(
      `call:${call.messageId}:${call.seatId}`,
      "high",
      `叫 ${call.seatName} 没叫成（${call.state === "cut" ? "中途断了" : "唤起失败"}）：${clip(call.gist, 40)}`,
      { kind: "message", id: call.messageId },
    )
  }

  for (const permit of snap.permits) {
    if (now - permit.at < PERMIT_LATE) continue
    add(`permit:${permit.id}`, "mid", `${permit.agentName} 等你批权限 ${minutes(now - permit.at)}了：${clip(permit.tool ?? permit.input ?? "", 40)}`)
  }

  for (const message of [...(snap.openAsks ?? []), ...snap.messages]) {
    if (message.ask?.state !== "open" || message.recalled || now - message.createdAt < ASK_LATE) continue
    add(`ask:${message.id}`, "mid", `${message.authorName} 问你的话等了 ${minutes(now - message.createdAt)}：${clip(message.text, 40)}`, {
      kind: "message",
      id: message.id,
    })
  }

  for (const task of snap.tasks) {
    if (task.status === "done") continue
    const quiet = now - task.updatedAt
    if (task.status === "blocked") {
      add(`blocked:${task.id}:${task.updatedAt}`, "high", `「${clip(task.title, 30)}」卡住了（${task.ownerName ?? "没人负责"}）`, { kind: "task", id: task.id })
    } else if (awaitingReview(task)) {
      if (quiet >= REVIEW_LATE) {
        add(`review:${task.id}:${task.updatedAt}`, "mid", `「${clip(task.title, 30)}」等你验收 ${minutes(quiet)}了`, { kind: "task", id: task.id })
      }
    } else if (task.status === "doing" && quiet >= STALE) {
      const owner = snap.agents.find((agent) => agent.id === task.ownerId)
      if (owner?.status !== "working") {
        add(`stale:${task.id}:${task.updatedAt}`, "low", `「${clip(task.title, 30)}」${minutes(quiet)}没动了（${task.ownerName ?? "没人负责"}）`, {
          kind: "task",
          id: task.id,
        })
      }
    }
  }
  return out
}

// The cheap model reads a long wake's last steps: circles, stuck, or moving.
async function readRun(item: Found): Promise<{ verdict: "moving" | "circles" | "stuck"; line: string } | null> {
  const read = item.read
  if (!read) return null
  // A wake this long with nothing done yet is stuck at its start; no need to ask.
  if (read.steps.length === 0) return { verdict: "stuck", line: "一步都还没动" }
  // What called it: only the ★ lines. The rest of a wake's text is the room's
  // backlog, which says nothing about this seat's work (it misled the reader).
  const called = read.body
    .split("\n")
    .filter((line) => line.startsWith("★"))
    .join(" ")
  const steps = read.steps
    .slice(-30)
    .map((step) => `- ${step.kind === "tool" ? "调用" : step.kind === "text" ? "说" : "记"} ${clip(step.title, 60)}${step.input ? `：${clip(step.input, 80)}` : ""}${step.state === "failed" ? "（失败）" : ""}`)
    .join("\n")
  const prompt = [
    `你是巡查员，只看不做，不要调用任何工具。下面是 ${read.agentName}（一个写代码的 AI）这一轮工作的最近步骤，它已经跑了 ${minutes(read.age)}。`,
    `叫它做的事：${clip(called || read.body.slice(-300), 300) || "（没有）"}`,
    `最近的步骤：\n${steps || "（没有记录）"}`,
    "只根据这些步骤判断它是在推进、在原地打转（反复做同样的事、同样的错一直出现），还是卡住了（在等什么、或一直失败）。",
    "只回两行：第一行写「推进」「打转」「卡住」之一；第二行用一句话（30 字内）说依据。",
  ].join("\n\n")
  const dir = mkdtempSync(path.join(os.tmpdir(), "bench-patrol-"))
  try {
    const stdout = await new Promise<string>((resolve) => {
      execFile(
        "dsh-agent",
        ["exec", "--json", "--timeout", "90", "-C", dir, prompt],
        { cwd: dir, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 },
        (_error, out) => resolve(String(out ?? "")),
      )
    })
    let text = ""
    for (const line of stdout.split("\n")) {
      try {
        const event = JSON.parse(line)
        if (event?.type === "final" && typeof event.text === "string") text = event.text
      } catch {}
    }
    const [head = "", ...rest] = text.trim().split("\n").map((line) => line.trim()).filter(Boolean)
    const verdict = head.includes("打转") ? "circles" : head.includes("卡住") ? "stuck" : head.includes("推进") ? "moving" : null
    if (!verdict) return null
    return { verdict, line: clip(rest.join(" "), 60) }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function noteText(items: RiskItem[], more: number, wake: boolean) {
  const mark: Record<RiskLevel, string> = { high: "【要紧】", mid: "", low: "" }
  const lines = items.map((item) => {
    const body = item.text.startsWith(item.project) ? item.text : `${item.project}：${item.text}`
    return `- ${mark[item.level]}${body}${item.ref && item.ref.kind !== "run" ? `（${item.ref.id}）` : ""}`
  })
  return [
    "（巡查记下的，只给你看，用户看不到这条。）",
    ...lines,
    more > 0 ? `- 另有 ${more} 件不急的，用 bench_overview 能看到` : "",
    wake
      ? "有要紧的，所以叫醒你：先用 bench_peek 核实，再用你自己的话跟用户说，一两句：哪件事、要不要他管、去哪个房间。不要提巡查，也不要贴这张清单；说完再用 bench_notify 推一句摘要给他。核实下来不要紧就不用说话，也不推，直接【本轮结束】。"
      : "不急，不用现在说。用户下次找你时，如果跟他问的有关，或者他问有什么要注意的，再顺带提。",
  ]
    .filter(Boolean)
    .join("\n")
}

const ORDER: Record<RiskLevel, number> = { high: 0, mid: 1, low: 2 }

export async function sweep(force = false, now = Date.now()) {
  const s = state()
  const activePatrol = force || patrolOn()
  const watchedMap = listWatchedProjects()
  const hasWatched = Object.keys(watchedMap).length > 0
  if (s.busy || (!activePatrol && !hasWatched)) return null
  s.busy = true
  try {
    const projects = listProjects()
    const projectIds = new Set(projects.map((p) => p.id))
    for (const wid of Object.keys(watchedMap)) {
      if (!projectIds.has(wid)) {
        removeWatchedProject(wid)
        delete watchedMap[wid]
      }
    }
    const desk = projects.find((item) => item.front)
    if (!desk || desk.seats === 0) return null
    const limitedKinds = Object.keys(watchedMap).length > 0 ? limitedAgentNames(now) : new Set<string>()
    const found = projects
      .filter((item) => !item.front && (activePatrol || Boolean(watchedMap[item.id])))
      .flatMap((item) =>
        inProject(item.id, () =>
          look(item, now, {
            onlyWatch: !activePatrol,
            watched: watchedMap[item.id],
            limitedKinds,
          }),
        ),
      )

    const seen = readSeen()
    const first = activePatrol && Object.keys(seen).length === 0 && dbGetMeta(META_WOKE) === undefined
    const fresh = found.filter((item) => !seen[item.key])
    // Long wakes: the cheap model says whether they are worth telling.
    const told: RiskItem[] = []
    let reads = 0
    for (const item of fresh) {
      seen[item.key] = now
      if (!item.read) {
        if (!first || item.watch) told.push(item)
        continue
      }
      if (first || reads >= MAX_READS) continue
      reads++
      const judged = await readRun(item).catch(() => null)
      console.log(`巡查读了 ${item.project} ${item.text}：${judged ? `${judged.verdict} ${judged.line}` : "没读出结论"}`)
      if (!judged || judged.verdict === "moving") continue
      told.push({
        ...item,
        text: `${item.text}，看着在${judged.verdict === "circles" ? "原地打转" : "卡住"}${judged.line ? `：${judged.line}` : ""}`,
      })
    }
    for (const [key, at] of Object.entries(seen)) if (now - at > KEEP_SEEN) delete seen[key]
    dbSetMeta(META_SEEN, JSON.stringify(seen))
    // What was there before the patrol started is no news: the AI finds it
    // with bench_overview when the user asks. Watched-project items (`item.watch`)
    // were explicitly asked for and are never swallowed by `first`.
    if (first) dbSetMeta(META_WOKE, "0")
    if (told.length === 0) return null

    const shown = [...told].sort((a, b) => ORDER[a.level] - ORDER[b.level]).slice(0, NOTE_ITEMS)
    const items = shown.map(({ key, projectId, project, level, text, ref }) => ({ key, projectId, project, level, text, ref }))
    const more = told.length - shown.length
    const risk: PatrolRisk = { items, ...(more > 0 ? { more } : {}) }
    const lastWoke = Number(dbGetMeta(META_WOKE) ?? 0)
    const wakeGap = envMs("BENCH_PATROL_WAKE_GAP_MS", WAKE_GAP)
    const wake = items.some((item) => item.level === "high") && now - lastWoke >= wakeGap
    if (wake) dbSetMeta(META_WOKE, String(now))
    return inProject(desk.id, () => postRisk(risk, noteText(items, more, wake), wake))
  } finally {
    s.busy = false
  }
}

// When all queued/running checks in a project have finished, leave an invisible
// note for the front desk's AI and wake it (same `postRisk` path as patrol,
// independent of the periodic sweep toggle). Does nothing if there is no front
// desk or nobody is on duty there.
export function noteChecksSettled(summary: {
  projectId: string
  project: string
  passed: number
  failed: number
  unverified: number
  other?: number
}) {
  const desk = listProjects().find((item) => item.front)
  if (!desk || desk.seats === 0) return null
  const hasSeat = inProject(desk.id, () => snapshot().agents.some((agent) => !agent.demo))
  if (!hasSeat) return null
  const extra = summary.other ? `（另有 ${summary.other} 件跳过或没跑成）` : ""
  const line = `复验全部有了结论：通过 ${summary.passed} 件、没过 ${summary.failed} 件、没验到 ${summary.unverified} 件${extra}`
  const item: RiskItem = {
    key: `checks:${summary.projectId}:${Date.now()}`,
    projectId: summary.projectId,
    project: summary.project,
    level: "high",
    text: line,
  }
  const text = [
    "（房间记下的，只给你看，用户看不到这条。）",
    `- ${summary.project}：${line}。`,
    "先用 bench_peek 看这个项目等验收的每一件：标着「可代签」的，用 bench_accept 逐件替用户通过；其余的用 bench_review_batch 整理成一张卡片给用户，再用你自己的话简短说一句，不要提内部通知。",
    ...(summary.other ? ["写着「复验没跑成」的，先用 bench_check 再排一次（房间会换一个席位来验），等它有结论再出卡片；又没跑成就告诉用户是哪个席位叫不动。"] : []),
  ].join("\n")
  return inProject(desk.id, () => postRisk({ items: [item] }, text, true))
}

// When the room has woken a stopped seat twice for the same owed work and it
// still hasn't moved (lib/continue.ts, t_4494da49), leave an urgent note for
// the front desk's AI via the same patrol risk channel.
export function noteSeatStalled(info: {
  key: string
  projectId: string
  project: string
  line: string
  ref?: RiskItem["ref"]
}): boolean {
  const desk = listProjects().find((item) => item.front)
  if (!desk || desk.seats === 0) return false
  const hasSeat = inProject(desk.id, () => snapshot().agents.some((agent) => !agent.demo))
  if (!hasSeat) return false
  const item: RiskItem = {
    key: info.key,
    projectId: info.projectId,
    project: info.project,
    level: "high",
    text: info.line,
    ref: info.ref,
  }
  const text = [
    "（巡查记下的，只给你看，用户看不到这条。）",
    `- 【要紧】${info.project}：${info.line}${info.ref && info.ref.kind !== "run" ? `（${info.ref.id}）` : ""}`,
    "有要紧的，所以叫醒你：房间已经自动叫过它两次还是没动，不会再叫了。先用 bench_peek 看一眼它卡在哪，再用你自己的话跟用户说一两句（哪件事、要不要换人或去房间处理），不要提巡查或内部通知；说完再用 bench_notify 推一句摘要给他。",
  ].join("\n")
  inProject(desk.id, () => postRisk({ items: [item] }, text, true))
  return true
}
