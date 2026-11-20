import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, utimesSync } from "node:fs"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"

import { backupsDir, dbSourceCounts, dbVacuumInto } from "@/lib/db"
import { inProject, listProjects, postSystem } from "@/lib/store"

// Automatic daily SQLite backup (t_8e27bddd):
// - Starts checking 10 minutes after room boot, then checks once an hour.
// - Writes a consistent snapshot via SQLite `VACUUM INTO` to a temporary file,
//   verifies it read-only (`PRAGMA quick_check` + non-empty project/message
//   counts when the live DB is non-empty), sets mode 0600, and atomically
//   renames it to `data/backups/bench-YYYYMMDD-HHMM.db`.
// - Keeps the newest 7 verified backups, pruning older ones only AFTER the new
//   backup passes verification. Unrelated files in `data/backups/` are untouched.

const DEFAULT_BOOT_MS = 10 * 60_000
const DEFAULT_TICK_MS = 60 * 60_000
const DEFAULT_INTERVAL_MS = 24 * 60 * 60_000
const ALERT_COOLDOWN_MS = 6 * 60 * 60_000
export const MAX_BACKUPS = 7

const BACKUP_NAME_RE = /^bench-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})\.db$/

// Bumped when backup timer rules change so hot-reload replaces old closures.
const SWEEP_VERSION = 2

type BackupRuntime = {
  bootAt: number
  version?: number
  bootMs?: number
  tickMs?: number
  bootTimer?: ReturnType<typeof setTimeout>
  timer?: ReturnType<typeof setInterval>
  busy?: boolean
  lastAlertWhy?: string
  lastAlertAt?: number
}

const g = globalThis as typeof globalThis & { __benchBackup?: BackupRuntime }

function rt(): BackupRuntime {
  return (g.__benchBackup ??= { bootAt: Date.now() })
}

function envMs(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === "") return fallback
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

export function backupBootMs() {
  return envMs("BENCH_BACKUP_BOOT_MS", DEFAULT_BOOT_MS)
}

export function backupTickMs() {
  return Math.max(100, envMs("BENCH_BACKUP_TICK_MS", DEFAULT_TICK_MS))
}

export function backupIntervalMs() {
  return envMs("BENCH_BACKUP_INTERVAL_MS", DEFAULT_INTERVAL_MS)
}

const pad2 = (n: number) => String(n).padStart(2, "0")

export function formatBackupStamp(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}`
}

export function formatBackupName(ms: number): string {
  return `bench-${formatBackupStamp(ms)}.db`
}

export function parseBackupName(name: string): number | null {
  const m = BACKUP_NAME_RE.exec(name)
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  const da = Number(m[3])
  const hh = Number(m[4])
  const mm = Number(m[5])
  const d = new Date(y, mo - 1, da, hh, mm, 0, 0)
  if (
    d.getFullYear() !== y ||
    d.getMonth() + 1 !== mo ||
    d.getDate() !== da ||
    d.getHours() !== hh ||
    d.getMinutes() !== mm
  ) {
    return null
  }
  return d.getTime()
}

export type BackupInspection =
  | { ok: true; projects: number; messages: number; tasks: number }
  | { ok: false; why: string; detail?: string }

export function inspectBackupFile(
  filePath: string,
  expectedSource?: { projects: number; messages: number },
): BackupInspection {
  let st
  try {
    st = statSync(filePath)
  } catch (err) {
    return { ok: false, why: "备份文件不存在", detail: String(err) }
  }
  if (!st.isFile() || st.size === 0) {
    return { ok: false, why: "备份文件是空的" }
  }

  let ro: DatabaseSync | undefined
  try {
    ro = new DatabaseSync(filePath, { readOnly: true })
    const rows = ro.prepare("PRAGMA quick_check").all() as Record<string, unknown>[]
    const firstVal = rows.length === 1 ? String(Object.values(rows[0] ?? {})[0] ?? "").toLowerCase() : ""
    if (firstVal !== "ok") {
      return {
        ok: false,
        why: "完整性检查没过",
        detail: JSON.stringify(rows.slice(0, 3)),
      }
    }
    const projects = Number((ro.prepare("SELECT COUNT(*) AS c FROM projects").get() as { c?: number } | undefined)?.c ?? 0)
    const messages = Number((ro.prepare("SELECT COUNT(*) AS c FROM messages").get() as { c?: number } | undefined)?.c ?? 0)
    const tasks = Number((ro.prepare("SELECT COUNT(*) AS c FROM tasks").get() as { c?: number } | undefined)?.c ?? 0)

    if (expectedSource) {
      if (expectedSource.projects > 0 && projects === 0) {
        return { ok: false, why: "缺少原有的项目数据" }
      }
      if (expectedSource.messages > 0 && messages === 0) {
        return { ok: false, why: "缺少原有的对话消息" }
      }
    }
    return { ok: true, projects, messages, tasks }
  } catch (err) {
    return {
      ok: false,
      why: "备份文件打不开或已损坏",
      detail: err instanceof Error ? err.message : String(err),
    }
  } finally {
    try {
      ro?.close()
    } catch {}
  }
}

export type BackupCandidate = {
  name: string
  file: string
  at: number
  size: number
}

export type BackupEntry = BackupCandidate & {
  projects: number
  messages: number
  tasks: number
}

// Lightweight listing used by the hourly sweep: inspects ONLY filenames and
// `statSync` metadata (`size` + `mtimeMs`), never opening any `.db` file.
export function listBackupCandidates(dir = backupsDir()): BackupCandidate[] {
  if (!existsSync(dir)) return []
  const items: BackupCandidate[] = []
  for (const name of readdirSync(dir)) {
    const parsedAt = parseBackupName(name)
    if (parsedAt === null) continue
    const file = path.join(dir, name)
    let st
    try {
      st = statSync(file)
    } catch {
      continue
    }
    if (!st.isFile() || st.size === 0) continue
    const at = Math.abs(st.mtimeMs - parsedAt) < 120_000 ? st.mtimeMs : parsedAt
    items.push({ name, file, at, size: st.size })
  }
  return items.sort((a, b) => a.name.localeCompare(b.name))
}

// Lists verified backup files matching `bench-YYYYMMDD-HHMM.db` in chronological
// order (oldest first, newest last). Called once a day during retention pruning
// (and in tests), never on the hourly "not due yet" fast path.
export function listVerifiedBackups(dir = backupsDir()): BackupEntry[] {
  const items: BackupEntry[] = []
  for (const cand of listBackupCandidates(dir)) {
    const check = inspectBackupFile(cand.file)
    if (!check.ok) continue
    items.push({
      ...cand,
      projects: check.projects,
      messages: check.messages,
      tasks: check.tasks,
    })
  }
  return items
}

function notifyBackupFailed(why: string, now: number, cooldownMs = 0) {
  const s = rt()
  if (cooldownMs > 0 && s.lastAlertWhy === why && s.lastAlertAt && now - s.lastAlertAt < cooldownMs) {
    return
  }
  s.lastAlertWhy = why
  s.lastAlertAt = now
  try {
    const desk = listProjects().find((item) => item.front)
    if (desk) {
      inProject(desk.id, () => {
        postSystem(`数据备份没留成：${why}`)
      })
    }
  } catch {}
}

export function pruneBackups(dir = backupsDir(), keep = MAX_BACKUPS): string[] {
  const good = listVerifiedBackups(dir)
  if (good.length <= keep) return []
  const toRemove = good.slice(0, good.length - keep)
  const removed: string[] = []
  for (const item of toRemove) {
    try {
      rmSync(item.file, { force: true })
      removed.push(item.name)
    } catch {}
  }
  return removed
}

export type RunBackupOptions = {
  now?: number
  keep?: number
  alertCooldownMs?: number
  // Hook used only by tests to simulate a corrupt/incomplete snapshot write.
  produceSnapshot?: (tmpFile: string) => void
}

export type RunBackupResult =
  | { ok: true; file: string; name: string; projects: number; messages: number; tasks: number; removed: string[] }
  | { ok: false; why: string }

export function runBackup(opts: RunBackupOptions = {}): RunBackupResult {
  const now = opts.now ?? Date.now()
  const keep = opts.keep ?? MAX_BACKUPS
  const dir = backupsDir()
  mkdirSync(dir, { recursive: true, mode: 0o700 })

  const targetName = formatBackupName(now)
  const finalFile = path.join(dir, targetName)
  const tmpFile = path.join(dir, `.tmp-${targetName}-${process.pid}-${Date.now()}`)

  let sourceCounts: { projects: number; messages: number; tasks: number }
  try {
    sourceCounts = dbSourceCounts()
  } catch (err) {
    const why = "读原数据库出错"
    console.error(`[bench backup] 数据备份没留成：${why}`, err)
    notifyBackupFailed(why, now, opts.alertCooldownMs)
    return { ok: false, why }
  }

  try {
    if (opts.produceSnapshot) {
      opts.produceSnapshot(tmpFile)
    } else {
      dbVacuumInto(tmpFile)
    }
    try {
      chmodSync(tmpFile, 0o600)
    } catch {}
  } catch (err) {
    try {
      rmSync(tmpFile, { force: true })
    } catch {}
    const why = "写备份文件出错"
    console.error(`[bench backup] 数据备份没留成：${why}`, err)
    notifyBackupFailed(why, now, opts.alertCooldownMs)
    return { ok: false, why }
  }

  const check = inspectBackupFile(tmpFile, sourceCounts)
  if (!check.ok) {
    try {
      rmSync(tmpFile, { force: true })
    } catch {}
    console.error(`[bench backup] 数据备份没留成：${check.why}`, check.detail ?? "")
    notifyBackupFailed(check.why, now, opts.alertCooldownMs)
    return { ok: false, why: check.why }
  }

  try {
    renameSync(tmpFile, finalFile)
    try {
      chmodSync(finalFile, 0o600)
    } catch {}
    try {
      const stampDate = new Date(now)
      utimesSync(finalFile, stampDate, stampDate)
    } catch {}
  } catch (err) {
    try {
      rmSync(tmpFile, { force: true })
    } catch {}
    const why = "保存备份文件出错"
    console.error(`[bench backup] 数据备份没留成：${why}`, err)
    notifyBackupFailed(why, now, opts.alertCooldownMs)
    return { ok: false, why }
  }

  const s = rt()
  s.lastAlertWhy = undefined
  s.lastAlertAt = undefined

  const removed = pruneBackups(dir, keep)
  return {
    ok: true,
    file: finalFile,
    name: targetName,
    projects: check.projects,
    messages: check.messages,
    tasks: check.tasks,
    removed,
  }
}

export type SweepBackupResult =
  | { status: "busy" | "boot-grace" }
  | { status: "not-due"; latest: string }
  | { status: "backed-up"; result: Extract<RunBackupResult, { ok: true }> }
  | { status: "failed"; why: string }

export function sweepBackup(now = Date.now()): SweepBackupResult {
  const s = rt()
  if (s.busy) return { status: "busy" }
  if (now - s.bootAt < backupBootMs()) return { status: "boot-grace" }
  s.busy = true
  try {
    const latest = listBackupCandidates().at(-1)
    if (latest && now - latest.at < backupIntervalMs()) {
      return { status: "not-due", latest: latest.file }
    }
    const res = runBackup({ now, alertCooldownMs: ALERT_COOLDOWN_MS })
    if (!res.ok) return { status: "failed", why: res.why }
    return { status: "backed-up", result: res }
  } finally {
    s.busy = false
  }
}

export function ensureBackup() {
  const s = rt()
  const bMs = backupBootMs()
  const tMs = backupTickMs()
  if (s.timer && s.version === SWEEP_VERSION && s.bootMs === bMs && s.tickMs === tMs) return
  if (s.bootTimer) clearTimeout(s.bootTimer)
  if (s.timer) clearInterval(s.timer)
  s.version = SWEEP_VERSION
  s.bootMs = bMs
  s.tickMs = tMs

  const waitBoot = Math.max(0, s.bootAt + bMs - Date.now())
  s.bootTimer = setTimeout(() => {
    sweepBackup()
  }, waitBoot + 25)
  s.timer = setInterval(() => {
    sweepBackup()
  }, tMs)
  s.bootTimer.unref?.()
  s.timer.unref?.()
}

export function resetBackupRuntimeForTest(bootAt = Date.now()) {
  const s = rt()
  if (s.bootTimer) clearTimeout(s.bootTimer)
  if (s.timer) clearInterval(s.timer)
  g.__benchBackup = { bootAt }
}
