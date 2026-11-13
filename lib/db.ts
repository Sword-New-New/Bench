import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { DatabaseSync, type StatementSync } from "node:sqlite"

import type { Message, Run, RunStep, SeatBinding, SeatProfile, Task } from "@/lib/types"

// Central SQLite store (WAL + FTS5) replacing whole-file JSON rewrites and
// hard array caps (400 messages / 200 tasks / 80 runs). Uses Node 24's built-in
// synchronous `node:sqlite`, so callers in store.ts, runs.ts and summon.ts keep
// their synchronous signatures without adding external npm dependencies.

export function dataDir() {
  return process.env.BENCH_DATA_DIR || path.join(process.cwd(), "data")
}

export function dbFile() {
  return path.join(dataDir(), "bench.db")
}

export function seatsDir() {
  return path.join(dataDir(), "seats")
}

type DbBundle = {
  file: string
  db: DatabaseSync
  stmts: Map<string, StatementSync>
}

type LegacyRoomGlobal = typeof globalThis & {
  __benchSqlite?: DbBundle
  __benchRooms?: {
    dbBacked?: boolean
    projects?: { id: string; name: string; dir?: string; createdAt: number }[]
    rooms?: Map<string, { id: string; state: Record<string, unknown> }>
  }
  __benchRuns?: Run[]
  __benchUserName?: string
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  dir TEXT,
  created_at INTEGER NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  rev INTEGER NOT NULL DEFAULT 0,
  seq INTEGER NOT NULL DEFAULT 0,
  summary_json TEXT,
  summary_skip_seq INTEGER,
  relay_closed INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS seats (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  data_json TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_seats_project ON seats(project_id, sort_order);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  author_id TEXT NOT NULL,
  author_name TEXT NOT NULL,
  text TEXT NOT NULL,
  reply_to TEXT,
  task_id TEXT,
  ask_state TEXT,
  recalled_at INTEGER,
  created_at INTEGER NOT NULL,
  mentions_json TEXT NOT NULL DEFAULT '[]',
  handoff_from TEXT,
  handoff_to TEXT,
  data_json TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_proj_seq ON messages(project_id, seq);
CREATE INDEX IF NOT EXISTS idx_messages_proj_ask ON messages(project_id, ask_state) WHERE ask_state IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messages_proj_author ON messages(project_id, author_id, seq);
CREATE INDEX IF NOT EXISTS idx_messages_proj_reply ON messages(project_id, reply_to) WHERE reply_to IS NOT NULL;

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  project_id UNINDEXED,
  message_id UNINDEXED,
  author_name,
  text,
  tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS trg_messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, project_id, message_id, author_name, text)
  VALUES (new.rowid, new.project_id, new.id, new.author_name, new.text);
END;

CREATE TRIGGER IF NOT EXISTS trg_messages_ad AFTER DELETE ON messages BEGIN
  DELETE FROM messages_fts WHERE rowid = old.rowid;
END;

CREATE TRIGGER IF NOT EXISTS trg_messages_au AFTER UPDATE OF author_name, text ON messages BEGIN
  DELETE FROM messages_fts WHERE rowid = old.rowid;
  INSERT INTO messages_fts(rowid, project_id, message_id, author_name, text)
  VALUES (new.rowid, new.project_id, new.id, new.author_name, new.text);
END;

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  status TEXT NOT NULL,
  owner_id TEXT,
  updated_at INTEGER NOT NULL,
  data_json TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_tasks_proj_seq ON tasks(project_id, seq);
CREATE INDEX IF NOT EXISTS idx_tasks_proj_status ON tasks(project_id, status, updated_at);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  project_id TEXT,
  purpose TEXT NOT NULL,
  state TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  interrupted INTEGER NOT NULL DEFAULT 0,
  announced INTEGER NOT NULL DEFAULT 0,
  resumed_at INTEGER,
  limited_resume_at INTEGER,
  data_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runs_agent ON runs(agent_id, started_at);
CREATE INDEX IF NOT EXISTS idx_runs_started ON runs(started_at);
CREATE INDEX IF NOT EXISTS idx_runs_running ON runs(state) WHERE state = 'running';

CREATE TABLE IF NOT EXISTS run_steps (
  run_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  step_id TEXT NOT NULL,
  data_json TEXT NOT NULL,
  PRIMARY KEY(run_id, step_id),
  FOREIGN KEY(run_id) REFERENCES runs(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_run_steps_order ON run_steps(run_id, idx);

CREATE TABLE IF NOT EXISTS lane_state (
  agent_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  paused INTEGER NOT NULL DEFAULT 0,
  hops INTEGER NOT NULL DEFAULT 0,
  summary INTEGER NOT NULL DEFAULT 0,
  compact INTEGER NOT NULL DEFAULT 0,
  goal TEXT,
  carry TEXT,
  whisper TEXT,
  trigger_id TEXT,
  dropped_json TEXT
);

CREATE TABLE IF NOT EXISTS lane_queue (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  line TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lane_queue_agent ON lane_queue(agent_id, seq);
`

function bundle(): DbBundle {
  const g = globalThis as LegacyRoomGlobal
  const target = dbFile()
  if (g.__benchSqlite && g.__benchSqlite.file === target && g.__benchSqlite.db.isOpen) {
    return g.__benchSqlite
  }
  if (g.__benchSqlite?.db.isOpen) {
    try {
      g.__benchSqlite.db.close()
    } catch {}
  }
  mkdirSync(path.dirname(target), { recursive: true })
  const db = new DatabaseSync(target)
  db.exec("PRAGMA journal_mode = WAL;")
  db.exec("PRAGMA synchronous = NORMAL;")
  db.exec("PRAGMA foreign_keys = ON;")
  db.exec("PRAGMA busy_timeout = 5000;")
  db.exec(SCHEMA_SQL)
  const created: DbBundle = { file: target, db, stmts: new Map() }
  g.__benchSqlite = created
  migrateLegacyJsonIfNeeded(created)
  cleanFtsResidue(db)
  return created
}

function cleanFtsResidue(db: DatabaseSync) {
  try {
    db.exec("DELETE FROM messages_fts WHERE rowid NOT IN (SELECT rowid FROM messages)")
    const staleRecalled = db
      .prepare(
        "SELECT m.rowid AS rid, m.project_id AS pid, m.id AS mid, m.author_name AS aname FROM messages m JOIN messages_fts f ON f.rowid = m.rowid WHERE m.recalled_at IS NOT NULL AND f.text != ''",
      )
      .all()
    if (staleRecalled.length > 0) {
      const del = db.prepare("DELETE FROM messages_fts WHERE rowid = ?")
      const ins = db.prepare("INSERT INTO messages_fts(rowid, project_id, message_id, author_name, text) VALUES (?, ?, ?, ?, '')")
      for (const r of staleRecalled) {
        del.run(Number(r.rid))
        ins.run(Number(r.rid), String(r.pid), String(r.mid), String(r.aname))
      }
    }
  } catch {
    // Non-fatal if FTS cleanup encounters a transient lock.
  }
}

export function getDb(): DatabaseSync {
  return bundle().db
}

export function stmt(sql: string): StatementSync {
  const b = bundle()
  let found = b.stmts.get(sql)
  if (!found) {
    found = b.db.prepare(sql)
    b.stmts.set(sql, found)
  }
  return found
}

export function inTransaction<T>(fn: () => T): T {
  const db = getDb()
  if (db.isTransaction) return fn()
  db.exec("BEGIN IMMEDIATE")
  try {
    const out = fn()
    db.exec("COMMIT")
    return out
  } catch (error) {
    try {
      db.exec("ROLLBACK")
    } catch {}
    throw error
  }
}

// ---- Legacy JSON -> SQLite one-shot migration ----

function readJsonSafe<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T
  } catch {
    return null
  }
}

function migrateLegacyJsonIfNeeded(b: DbBundle) {
  const done = b.db.prepare("SELECT value FROM meta WHERE key = 'migrated_v1'").get()
  if (done) return

  const dir = dataDir()
  const g = globalThis as LegacyRoomGlobal
  const liveRooms = g.__benchRooms && !g.__benchRooms.dbBacked ? g.__benchRooms : undefined
  const projectsJsonPath = path.join(dir, "projects.json")
  const legacyRoomPath = path.join(dir, "room.json")
  const userJsonPath = path.join(dir, "user.json")
  const runsJsonPath = path.join(dir, "runs.json")

  let projectList: { id: string; name: string; dir?: string; createdAt: number }[] = []
  if (liveRooms?.projects?.length) {
    projectList = liveRooms.projects
  } else {
    const parsed = readJsonSafe<{ projects?: { id: string; name: string; dir?: string; createdAt: number }[] }>(projectsJsonPath)
    if (Array.isArray(parsed?.projects) && parsed.projects.length > 0) {
      projectList = parsed.projects
    } else if (existsSync(legacyRoomPath)) {
      projectList = [{ id: `p_${Math.random().toString(16).slice(2, 10)}`, name: "默认项目", createdAt: Date.now() }]
    }
  }

  const backupDir = path.join(dir, "backup-json-v1")
  const hasAnyLegacy =
    projectList.length > 0 || existsSync(projectsJsonPath) || existsSync(legacyRoomPath) || existsSync(userJsonPath) || existsSync(runsJsonPath)

  b.db.exec("BEGIN IMMEDIATE")
  try {
    // 1. User name
    let migratedUser = g.__benchUserName
    if (!migratedUser) {
      const u = readJsonSafe<{ name?: string }>(userJsonPath)
      if (typeof u?.name === "string" && u.name.trim()) migratedUser = u.name.trim()
    }

    // 2. Projects + seats + messages + tasks
    const insProject = b.db.prepare(
      `INSERT OR REPLACE INTO projects (id, name, dir, created_at, sort_order, rev, seq, summary_json, summary_skip_seq, relay_closed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    const insSeat = b.db.prepare(
      `INSERT OR REPLACE INTO seats (id, project_id, sort_order, data_json) VALUES (?, ?, ?, ?)`,
    )
    const insMsg = b.db.prepare(
      `INSERT OR REPLACE INTO messages (
         id, project_id, seq, kind, author_id, author_name, text, reply_to, task_id,
         ask_state, recalled_at, created_at, mentions_json, handoff_from, handoff_to, data_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    const insTask = b.db.prepare(
      `INSERT OR REPLACE INTO tasks (id, project_id, seq, status, owner_id, updated_at, data_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )

    for (let pIdx = 0; pIdx < projectList.length; pIdx++) {
      const p = projectList[pIdx]
      const memState = liveRooms?.rooms?.get(p.id)?.state
      const fileState =
        memState ??
        readJsonSafe<Record<string, unknown>>(path.join(dir, "projects", `${p.id}.json`)) ??
        (projectList.length === 1 && existsSync(legacyRoomPath) ? readJsonSafe<Record<string, unknown>>(legacyRoomPath) : null) ??
        {}

      const rev = typeof fileState.rev === "number" ? fileState.rev : 0
      const seq = typeof fileState.seq === "number" ? fileState.seq : 0
      const summary = fileState.summary ? JSON.stringify(fileState.summary) : null
      const skipSeq = typeof fileState.summarySkipSeq === "number" ? fileState.summarySkipSeq : null
      const relayClosed = fileState.relayClosed === true ? 1 : 0

      insProject.run(p.id, p.name, p.dir ?? null, p.createdAt || Date.now(), pIdx, rev, seq, summary, skipSeq, relayClosed)

      const agents = Array.isArray(fileState.agents) ? (fileState.agents as Record<string, unknown>[]) : []
      for (let aIdx = 0; aIdx < agents.length; aIdx++) {
        const agent = agents[aIdx]
        if (typeof agent?.id === "string") {
          insSeat.run(agent.id, p.id, aIdx, JSON.stringify(agent))
        }
      }

      const messages = Array.isArray(fileState.messages) ? (fileState.messages as Message[]) : []
      for (const m of messages) {
        if (!m || typeof m.id !== "string") continue
        if (!migratedUser && m.authorId === "human" && m.authorName) migratedUser = m.authorName
        insMsg.run(
          m.id,
          p.id,
          m.seq,
          m.kind,
          m.authorId,
          m.authorName,
          m.text ?? "",
          m.replyTo ?? null,
          m.taskId ?? null,
          m.ask?.state ?? null,
          m.recalled?.at ?? null,
          m.createdAt,
          JSON.stringify(m.mentions ?? []),
          m.handoff?.fromId ?? null,
          m.handoff?.toId ?? null,
          JSON.stringify(m),
        )
      }

      const tasks = Array.isArray(fileState.tasks) ? (fileState.tasks as Task[]) : []
      for (const t of tasks) {
        if (!t || typeof t.id !== "string") continue
        insTask.run(t.id, p.id, t.seq, t.status, t.ownerId ?? null, t.updatedAt, JSON.stringify(t))
      }
    }

    if (migratedUser) {
      b.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('user_name', ?)").run(migratedUser)
    }

    // 3. Runs + steps
    const liveRuns = g.__benchRuns
    const diskRuns = !liveRuns ? readJsonSafe<{ runs?: Run[] }>(runsJsonPath)?.runs : undefined
    const sourceRuns = liveRuns ?? diskRuns ?? []
    const fromColdDisk = !liveRuns && Boolean(diskRuns)

    const insRun = b.db.prepare(
      `INSERT OR REPLACE INTO runs (
         id, agent_id, agent_name, project_id, purpose, state, started_at, ended_at,
         interrupted, announced, resumed_at, limited_resume_at, data_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    const insStep = b.db.prepare(
      `INSERT OR REPLACE INTO run_steps (run_id, idx, step_id, data_json) VALUES (?, ?, ?, ?)`,
    )

    for (const rawRun of sourceRuns) {
      if (!rawRun || typeof rawRun.id !== "string") continue
      let r: Run = rawRun
      if (fromColdDisk && r.state === "running") {
        const at = Date.now()
        const steps: RunStep[] = (r.steps ?? []).map((s) => (s.state === "running" ? { ...s, state: "failed" } : s))
        steps.push({ id: "end", at, kind: "note", title: "服务器重启，这次唤起被打断了", state: "failed" })
        r = { ...r, state: "failed", endedAt: at, interrupted: true, steps }
      }
      const { steps = [], ...metaOnly } = r
      insRun.run(
        r.id,
        r.agentId,
        r.agentName,
        r.project ?? null,
        r.purpose,
        r.state,
        r.startedAt,
        r.endedAt ?? null,
        r.interrupted ? 1 : 0,
        r.announced ? 1 : 0,
        r.resumedAt ?? null,
        r.limited?.resumeAt ?? null,
        JSON.stringify(metaOnly),
      )
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i]
        insStep.run(r.id, i, step.id || `step_${i}`, JSON.stringify(step))
      }
    }

    b.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('migrated_v1', ?)").run(String(Date.now()))
    b.db.exec("COMMIT")
  } catch (error) {
    try {
      b.db.exec("ROLLBACK")
    } catch {}
    throw error
  }

  // Archive legacy JSON files safely into data/backup-json-v1/ so nothing is lost.
  if (hasAnyLegacy) {
    try {
      mkdirSync(path.join(backupDir, "projects"), { recursive: true })
      for (const name of ["projects.json", "room.json", "user.json", "runs.json"]) {
        const src = path.join(dir, name)
        if (existsSync(src)) {
          copyFileSync(src, path.join(backupDir, name))
          renameSync(src, path.join(backupDir, name))
        }
      }
      const projDir = path.join(dir, "projects")
      if (existsSync(projDir)) {
        for (const entry of readdirSync(projDir)) {
          if (!entry.endsWith(".json")) continue
          const src = path.join(projDir, entry)
          copyFileSync(src, path.join(backupDir, "projects", entry))
          rmSync(src, { force: true })
        }
      }
    } catch {
      // Non-fatal if backup archival encounters a permission hiccup.
    }
  }
}

// ---- Meta helpers ----

export function dbGetMeta(key: string): string | undefined {
  const row = stmt("SELECT value FROM meta WHERE key = ?").get(key)
  return typeof row?.value === "string" ? row.value : undefined
}

export function dbSetMeta(key: string, value: string) {
  stmt("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(key, value)
}

// ---- Project & Room persistence ----

export type StoredProjectRow = {
  id: string
  name: string
  dir?: string
  createdAt: number
  rev: number
  seq: number
  summaryJson: string | null
  summarySkipSeq: number | null
  relayClosed: boolean
}

export function dbLoadProjects(): StoredProjectRow[] {
  const rows = stmt(
    "SELECT id, name, dir, created_at, rev, seq, summary_json, summary_skip_seq, relay_closed FROM projects ORDER BY sort_order ASC, created_at ASC",
  ).all()
  return rows.map((r) => ({
    id: String(r.id),
    name: String(r.name),
    dir: typeof r.dir === "string" ? r.dir : undefined,
    createdAt: Number(r.created_at),
    rev: Number(r.rev),
    seq: Number(r.seq),
    summaryJson: typeof r.summary_json === "string" ? r.summary_json : null,
    summarySkipSeq: typeof r.summary_skip_seq === "number" ? r.summary_skip_seq : null,
    relayClosed: Number(r.relay_closed) === 1,
  }))
}

export function dbSaveProject(
  p: { id: string; name: string; dir?: string; createdAt: number },
  sortOrder: number,
  state: { rev: number; seq: number; summary?: unknown; summarySkipSeq?: number; relayClosed?: boolean },
) {
  stmt(
    `INSERT INTO projects (id, name, dir, created_at, sort_order, rev, seq, summary_json, summary_skip_seq, relay_closed)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       dir = excluded.dir,
       sort_order = excluded.sort_order,
       rev = excluded.rev,
       seq = excluded.seq,
       summary_json = excluded.summary_json,
       summary_skip_seq = excluded.summary_skip_seq,
       relay_closed = excluded.relay_closed`,
  ).run(
    p.id,
    p.name,
    p.dir ?? null,
    p.createdAt,
    sortOrder,
    state.rev,
    state.seq,
    state.summary ? JSON.stringify(state.summary) : null,
    state.summarySkipSeq ?? null,
    state.relayClosed ? 1 : 0,
  )
}

export function dbSaveRoomHeader(
  projectId: string,
  state: { rev: number; seq: number; summary?: unknown; summarySkipSeq?: number; relayClosed?: boolean },
) {
  stmt(
    `UPDATE projects SET rev = ?, seq = ?, summary_json = ?, summary_skip_seq = ?, relay_closed = ? WHERE id = ?`,
  ).run(
    state.rev,
    state.seq,
    state.summary ? JSON.stringify(state.summary) : null,
    state.summarySkipSeq ?? null,
    state.relayClosed ? 1 : 0,
    projectId,
  )
}

export function dbDeleteProject(projectId: string) {
  const seatRows = stmt("SELECT id FROM seats WHERE project_id = ?").all(projectId)
  inTransaction(() => {
    stmt("DELETE FROM lane_queue WHERE project_id = ?").run(projectId)
    stmt("DELETE FROM lane_state WHERE project_id = ?").run(projectId)
    stmt("DELETE FROM projects WHERE id = ?").run(projectId)
  })
  for (const row of seatRows) {
    rmSync(seatMarkdownPath(String(row.id)), { force: true })
  }
}

export function dbResetProjectRoom(projectId: string) {
  const seatRows = stmt("SELECT id FROM seats WHERE project_id = ?").all(projectId)
  inTransaction(() => {
    stmt("DELETE FROM seats WHERE project_id = ?").run(projectId)
    stmt("DELETE FROM messages WHERE project_id = ?").run(projectId)
    stmt("DELETE FROM tasks WHERE project_id = ?").run(projectId)
    stmt("DELETE FROM lane_queue WHERE project_id = ?").run(projectId)
    stmt("DELETE FROM lane_state WHERE project_id = ?").run(projectId)
    stmt("UPDATE projects SET rev = 0, seq = 0, summary_json = NULL, summary_skip_seq = NULL, relay_closed = 0 WHERE id = ?").run(projectId)
  })
  for (const row of seatRows) {
    rmSync(seatMarkdownPath(String(row.id)), { force: true })
  }
}

// ---- Seats & Seat Markdown Mirror ----

export function dbLoadSeats<T>(projectId: string): T[] {
  const rows = stmt("SELECT data_json FROM seats WHERE project_id = ? ORDER BY sort_order ASC").all(projectId)
  const out: T[] = []
  for (const r of rows) {
    try {
      out.push(JSON.parse(String(r.data_json)) as T)
    } catch {}
  }
  return out
}

export function dbSyncSeats(projectId: string, agents: ({ id: string } & Record<string, unknown>)[]) {
  inTransaction(() => {
    const keep = new Set(agents.map((a) => a.id))
    const existing = stmt("SELECT id FROM seats WHERE project_id = ?").all(projectId)
    const del = stmt("DELETE FROM seats WHERE id = ?")
    for (const row of existing) {
      const id = String(row.id)
      if (!keep.has(id)) del.run(id)
    }
    const up = stmt("INSERT OR REPLACE INTO seats (id, project_id, sort_order, data_json) VALUES (?, ?, ?, ?)")
    for (let i = 0; i < agents.length; i++) {
      up.run(agents[i].id, projectId, i, JSON.stringify(agents[i]))
    }
  })
}

export function dbSaveSeat(projectId: string, agent: { id: string } & Record<string, unknown>, sortOrder = 0) {
  stmt(
    `INSERT INTO seats (id, project_id, sort_order, data_json) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET project_id = excluded.project_id, data_json = excluded.data_json`,
  ).run(agent.id, projectId, sortOrder, JSON.stringify(agent))
}

export function dbDeleteSeat(agentId: string) {
  stmt("DELETE FROM seats WHERE id = ?").run(agentId)
  stmt("DELETE FROM lane_queue WHERE agent_id = ?").run(agentId)
  stmt("DELETE FROM lane_state WHERE agent_id = ?").run(agentId)
  rmSync(seatMarkdownPath(agentId), { force: true })
}

// Export SeatProfile one-way from the room to `data/seats/<agentId>.md` for
// convenient human inspection. Edits on disk are never read back into the room
// so another agent cannot inject persona instructions by rewriting a teammate's file.
const PERSONA_HEAD = "## 职责与规范"
const MEMORY_HEAD = "## 长期记忆与备忘"

export function seatMarkdownPath(agentId: string) {
  return path.join(seatsDir(), `${agentId}.md`)
}

export function writeSeatMarkdown(agentId: string, name: string, role: string, profile: SeatProfile | undefined) {
  const file = seatMarkdownPath(agentId)
  if (!profile || (!profile.persona.trim() && !profile.memory.trim())) {
    rmSync(file, { force: true })
    return
  }
  mkdirSync(path.dirname(file), { recursive: true })
  const content = [
    `# ${name}（${agentId} · ${role}）`,
    "",
    PERSONA_HEAD,
    profile.persona.trim() || "（未设置）",
    "",
    MEMORY_HEAD,
    profile.memory.trim() || "（暂无）",
    "",
  ].join("\n")
  writeFileSync(file, content, "utf8")
}

// ---- Messages & FTS5 Queries ----

export function dbPutMessage(projectId: string, m: Message) {
  stmt(
    `INSERT INTO messages (
       id, project_id, seq, kind, author_id, author_name, text, reply_to, task_id,
       ask_state, recalled_at, created_at, mentions_json, handoff_from, handoff_to, data_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       seq = excluded.seq,
       kind = excluded.kind,
       author_id = excluded.author_id,
       author_name = excluded.author_name,
       text = excluded.text,
       reply_to = excluded.reply_to,
       task_id = excluded.task_id,
       ask_state = excluded.ask_state,
       recalled_at = excluded.recalled_at,
       created_at = excluded.created_at,
       mentions_json = excluded.mentions_json,
       handoff_from = excluded.handoff_from,
       handoff_to = excluded.handoff_to,
       data_json = excluded.data_json`,
  ).run(
    m.id,
    projectId,
    m.seq,
    m.kind,
    m.authorId,
    m.authorName,
    m.text ?? "",
    m.replyTo ?? null,
    m.taskId ?? null,
    m.ask?.state ?? null,
    m.recalled?.at ?? null,
    m.createdAt,
    JSON.stringify(m.mentions ?? []),
    m.handoff?.fromId ?? null,
    m.handoff?.toId ?? null,
    JSON.stringify(m),
  )
}

function rowToMessage(row: Record<string, unknown> | undefined): Message | null {
  if (!row || typeof row.data_json !== "string") return null
  try {
    return JSON.parse(row.data_json) as Message
  } catch {
    return null
  }
}

export function dbLoadRecentMessages(projectId: string, limit = 400): Message[] {
  const rows = stmt(
    "SELECT data_json FROM (SELECT seq, data_json FROM messages WHERE project_id = ? ORDER BY seq DESC LIMIT ?) ORDER BY seq ASC",
  ).all(projectId, limit)
  return rows.map(rowToMessage).filter((m): m is Message => m !== null)
}

export function dbCountMessages(projectId: string): number {
  const row = stmt("SELECT COUNT(*) AS cnt FROM messages WHERE project_id = ?").get(projectId)
  return Number(row?.cnt ?? 0)
}

export function dbGetMessage(projectId: string, messageId: string): Message | null {
  return rowToMessage(stmt("SELECT data_json FROM messages WHERE project_id = ? AND id = ?").get(projectId, messageId))
}

export function dbLoadOpenAsks(projectId: string, beforeSeq?: number): Message[] {
  const rows =
    beforeSeq !== undefined
      ? stmt(
          "SELECT data_json FROM messages WHERE project_id = ? AND ask_state = 'open' AND recalled_at IS NULL AND seq < ? ORDER BY seq ASC",
        ).all(projectId, beforeSeq)
      : stmt(
          "SELECT data_json FROM messages WHERE project_id = ? AND ask_state = 'open' AND recalled_at IS NULL ORDER BY seq ASC",
        ).all(projectId)
  return rows.map(rowToMessage).filter((m): m is Message => m !== null)
}

export function dbCountOpenAsks(projectId: string): number {
  const row = stmt(
    "SELECT COUNT(*) AS cnt FROM messages WHERE project_id = ? AND ask_state = 'open' AND recalled_at IS NULL",
  ).get(projectId)
  return Number(row?.cnt ?? 0)
}

export function dbOpenAskAuthorIds(projectId: string): string[] {
  const rows = stmt(
    "SELECT DISTINCT author_id FROM messages WHERE project_id = ? AND ask_state = 'open' AND recalled_at IS NULL",
  ).all(projectId)
  return rows.map((r) => String(r.author_id))
}

export function dbLoadMessagesAfter(projectId: string, afterSeq: number, limit?: number): Message[] {
  const rows =
    limit !== undefined
      ? stmt("SELECT data_json FROM messages WHERE project_id = ? AND seq > ? AND recalled_at IS NULL ORDER BY seq ASC LIMIT ?").all(
          projectId,
          afterSeq,
          limit,
        )
      : stmt("SELECT data_json FROM messages WHERE project_id = ? AND seq > ? AND recalled_at IS NULL ORDER BY seq ASC").all(
          projectId,
          afterSeq,
        )
  return rows.map(rowToMessage).filter((m): m is Message => m !== null)
}

export function dbLoadTalkAfter(projectId: string, afterSeq: number): Message[] {
  const rows = stmt(
    "SELECT data_json FROM messages WHERE project_id = ? AND seq > ? AND kind != 'system' AND recalled_at IS NULL ORDER BY seq ASC",
  ).all(projectId, afterSeq)
  return rows.map(rowToMessage).filter((m): m is Message => m !== null)
}

export function dbFindMessageByRunField(
  projectId: string,
  predicate: (m: Message) => boolean,
): Message | null {
  const rows = stmt("SELECT data_json FROM messages WHERE project_id = ? AND kind = 'system' ORDER BY seq DESC").all(projectId)
  for (const r of rows) {
    const m = rowToMessage(r)
    if (m && predicate(m)) return m
  }
  return null
}

export function dbRewriteMessages(projectId: string, mutator: (m: Message) => boolean) {
  inTransaction(() => {
    const rows = stmt("SELECT data_json FROM messages WHERE project_id = ? ORDER BY seq ASC").all(projectId)
    for (const r of rows) {
      const m = rowToMessage(r)
      if (m && mutator(m)) dbPutMessage(projectId, m)
    }
  })
}

// Full-history message query supporting pagination (`before`), `about` seat filter,
// full reply `chain`, and full-text / substring search (`q`).
export function dbQueryMessages(
  projectId: string,
  opts: { chainId?: string; seatId?: string; query?: string; beforeSeq?: number; limit: number },
): { messages: Message[]; hasMore: boolean } {
  if (opts.chainId) {
    // Walk up to root, then collect every non-system message in the project sharing that root.
    const allRows = stmt("SELECT data_json FROM messages WHERE project_id = ? ORDER BY seq ASC").all(projectId)
    const all = allRows.map(rowToMessage).filter((m): m is Message => m !== null)
    const byId = new Map(all.map((m) => [m.id, m]))
    const start = byId.get(opts.chainId)
    if (!start) return { messages: [], hasMore: false }
    const chainRootOf = (msg: Message) => {
      let cur = msg
      const seen = new Set<string>()
      while (cur.replyTo && !seen.has(cur.id)) {
        seen.add(cur.id)
        const up = byId.get(cur.replyTo)
        if (!up || up.kind === "system") break
        cur = up
      }
      return cur.id
    }
    const root = chainRootOf(start)
    let list = all.filter((m) => m.kind !== "system" && chainRootOf(m) === root)
    if (opts.seatId) {
      const sid = opts.seatId
      list = list.filter(
        (m) => m.authorId === sid || m.mentions.includes(sid) || m.handoff?.fromId === sid || m.handoff?.toId === sid,
      )
    }
    if (opts.query) {
      const terms = opts.query.toLowerCase().split(/\s+/).filter(Boolean)
      list = list.filter((m) => {
        if (m.recalled) return false
        const hay = `${m.authorName}\n${m.text}`.toLowerCase()
        return terms.every((t) => hay.includes(t))
      })
    }
    if (opts.beforeSeq && opts.beforeSeq > 0) list = list.filter((m) => m.seq < opts.beforeSeq!)
    const page = list.slice(-opts.limit)
    return { messages: page, hasMore: list.length > page.length }
  }

  const clauses: string[] = ["m.project_id = ?"]
  const params: (string | number)[] = [projectId]

  if (opts.beforeSeq && opts.beforeSeq > 0) {
    clauses.push("m.seq < ?")
    params.push(opts.beforeSeq)
  }

  if (opts.seatId) {
    clauses.push("(m.author_id = ? OR m.handoff_from = ? OR m.handoff_to = ? OR INSTR(m.mentions_json, ?) > 0)")
    params.push(opts.seatId, opts.seatId, opts.seatId, `"${opts.seatId}"`)
  }

  const cleanQ = (opts.query ?? "").trim()
  if (cleanQ) {
    clauses.push("m.recalled_at IS NULL")
    const terms = cleanQ.split(/\s+/).filter(Boolean)
    const longTerms = terms.filter((t) => [...t].length >= 3 && !/["*()]/.test(t))
    if (longTerms.length > 0) {
      const ftsExpr = longTerms.map((t) => `"${t.replace(/"/g, '""')}"`).join(" AND ")
      clauses.push("m.rowid IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)")
      params.push(ftsExpr)
    }
    for (const term of terms) {
      clauses.push("(INSTR(LOWER(m.text), LOWER(?)) > 0 OR INSTR(LOWER(m.author_name), LOWER(?)) > 0)")
      params.push(term, term)
    }
  }

  const sql = `SELECT m.data_json FROM messages m WHERE ${clauses.join(" AND ")} ORDER BY m.seq DESC LIMIT ?`
  const rows = stmt(sql).all(...params, opts.limit + 1)
  const hasMore = rows.length > opts.limit
  const slice = hasMore ? rows.slice(0, opts.limit) : rows
  const messages = slice
    .map(rowToMessage)
    .filter((m): m is Message => m !== null)
    .reverse()
  return { messages, hasMore }
}

// ---- Tasks ----

export function dbPutTask(projectId: string, t: Task) {
  stmt(
    `INSERT OR REPLACE INTO tasks (id, project_id, seq, status, owner_id, updated_at, data_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(t.id, projectId, t.seq, t.status, t.ownerId ?? null, t.updatedAt, JSON.stringify(t))
}

export function dbLoadTasks(projectId: string): Task[] {
  const rows = stmt("SELECT data_json FROM tasks WHERE project_id = ? ORDER BY seq ASC").all(projectId)
  const out: Task[] = []
  for (const r of rows) {
    try {
      out.push(JSON.parse(String(r.data_json)) as Task)
    } catch {}
  }
  return out
}

// ---- Runs & Steps ----

function hydrateRun(row: Record<string, unknown> | undefined, withSteps = true): Run | null {
  if (!row || typeof row.data_json !== "string") return null
  try {
    const base = JSON.parse(row.data_json) as Omit<Run, "steps">
    if (!withSteps) return { ...base, steps: [] }
    const stepRows = stmt("SELECT data_json FROM run_steps WHERE run_id = ? ORDER BY idx ASC").all(String(row.id))
    const steps: RunStep[] = []
    for (const sr of stepRows) {
      try {
        steps.push(JSON.parse(String(sr.data_json)) as RunStep)
      } catch {}
    }
    return { ...base, steps }
  } catch {
    return null
  }
}

export function dbSaveRunMeta(run: Run) {
  const { steps: _steps, ...metaOnly } = run
  void _steps
  stmt(
    `INSERT OR REPLACE INTO runs (
       id, agent_id, agent_name, project_id, purpose, state, started_at, ended_at,
       interrupted, announced, resumed_at, limited_resume_at, data_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    run.id,
    run.agentId,
    run.agentName,
    run.project ?? null,
    run.purpose,
    run.state,
    run.startedAt,
    run.endedAt ?? null,
    run.interrupted ? 1 : 0,
    run.announced ? 1 : 0,
    run.resumedAt ?? null,
    run.limited?.resumeAt ?? null,
    JSON.stringify(metaOnly),
  )
}

export function dbSaveRunStep(runId: string, idx: number, step: RunStep) {
  stmt("INSERT OR REPLACE INTO run_steps (run_id, idx, step_id, data_json) VALUES (?, ?, ?, ?)").run(
    runId,
    idx,
    step.id,
    JSON.stringify(step),
  )
}

export function dbGetRun(runId: string): Run | null {
  return hydrateRun(stmt("SELECT id, data_json FROM runs WHERE id = ?").get(runId), true)
}

export function dbLastRunOf(agentId: string): Run | undefined {
  const row = stmt("SELECT id, data_json FROM runs WHERE agent_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1").get(agentId)
  return hydrateRun(row, true) ?? undefined
}

export function dbListRuns(agentId: string, purpose: Run["purpose"], limit = 200): Run[] {
  const rows = stmt(
    "SELECT id, data_json FROM (SELECT rowid, id, started_at, data_json FROM runs WHERE agent_id = ? AND purpose = ? ORDER BY started_at DESC, rowid DESC LIMIT ?) ORDER BY started_at ASC, rowid ASC",
  ).all(agentId, purpose, limit)
  return rows.map((r) => hydrateRun(r, true)).filter((r): r is Run => r !== null)
}

export function dbMarkColdRunningInterrupted(): void {
  const rows = stmt("SELECT id, data_json FROM runs WHERE state = 'running'").all()
  if (rows.length === 0) return
  inTransaction(() => {
    const at = Date.now()
    for (const row of rows) {
      const run = hydrateRun(row, true)
      if (!run) continue
      const steps: RunStep[] = run.steps.map((s) => (s.state === "running" ? { ...s, state: "failed" } : s))
      const endStep: RunStep = { id: "end", at, kind: "note", title: "服务器重启，这次唤起被打断了", state: "failed" }
      steps.push(endStep)
      const updated: Run = { ...run, state: "failed", endedAt: at, interrupted: true, steps }
      dbSaveRunMeta(updated)
      for (let i = 0; i < steps.length; i++) dbSaveRunStep(updated.id, i, steps[i])
    }
  })
}

export function dbTakeUnannouncedInterrupted(): Run[] {
  const rows = stmt("SELECT id, data_json FROM runs WHERE interrupted = 1 AND announced = 0 ORDER BY started_at ASC").all()
  if (rows.length === 0) return []
  const list: Run[] = []
  inTransaction(() => {
    for (const row of rows) {
      const run = hydrateRun(row, false)
      if (!run) continue
      run.announced = true
      dbSaveRunMeta(run)
      list.push(run)
    }
  })
  return list
}

export function dbPendingResumes(): Run[] {
  const rows = stmt(
    "SELECT id, data_json FROM runs WHERE limited_resume_at IS NOT NULL AND resumed_at IS NULL ORDER BY limited_resume_at ASC",
  ).all()
  return rows.map((r) => hydrateRun(r, false)).filter((r): r is Run => r !== null)
}

// ---- Crash-safe Wake Lanes ----

export type StoredLane = {
  agentId: string
  projectId: string
  paused: boolean
  hops: number
  summary: boolean
  compact: boolean
  goal?: string
  carry?: string
  whisper?: string
  trigger?: string
  dropped?: string[]
  pending: { id: string; line: string }[]
}

let laneDroppedColChecked = false
function ensureLaneDroppedCol() {
  if (laneDroppedColChecked) return
  laneDroppedColChecked = true
  try {
    getDb().exec("ALTER TABLE lane_state ADD COLUMN dropped_json TEXT")
  } catch {}
}

export function dbLoadLanes(): StoredLane[] {
  ensureLaneDroppedCol()
  const stateRows = stmt("SELECT * FROM lane_state").all()
  const queueRows = stmt("SELECT agent_id, project_id, message_id, line FROM lane_queue ORDER BY seq ASC").all()
  const byAgent = new Map<string, StoredLane>()

  for (const r of stateRows) {
    const agentId = String(r.agent_id)
    let dropped: string[] | undefined
    if (typeof r.dropped_json === "string" && r.dropped_json) {
      try {
        const parsed = JSON.parse(r.dropped_json)
        if (Array.isArray(parsed) && parsed.length > 0) dropped = parsed.map(String)
      } catch {}
    }
    byAgent.set(agentId, {
      agentId,
      projectId: String(r.project_id),
      paused: Number(r.paused) === 1,
      hops: Number(r.hops ?? 0),
      summary: Number(r.summary) === 1,
      compact: Number(r.compact) === 1,
      goal: typeof r.goal === "string" ? r.goal : undefined,
      carry: typeof r.carry === "string" ? r.carry : undefined,
      whisper: typeof r.whisper === "string" ? r.whisper : undefined,
      trigger: typeof r.trigger_id === "string" ? r.trigger_id : undefined,
      dropped,
      pending: [],
    })
  }

  for (const q of queueRows) {
    const agentId = String(q.agent_id)
    let entry = byAgent.get(agentId)
    if (!entry) {
      entry = {
        agentId,
        projectId: String(q.project_id),
        paused: false,
        hops: 0,
        summary: false,
        compact: false,
        pending: [],
      }
      byAgent.set(agentId, entry)
    }
    entry.pending.push({ id: String(q.message_id), line: String(q.line) })
  }

  return [...byAgent.values()]
}

export function dbSaveLane(
  agentId: string,
  projectId: string,
  lane: {
    paused?: boolean
    hops: number
    summary?: boolean
    compact?: boolean
    goal?: string
    carry?: string
    whisper?: string
    trigger?: string
    dropped?: string[]
    pending: { id: string; line: string }[]
  },
) {
  ensureLaneDroppedCol()
  inTransaction(() => {
    const hasDropped = Boolean(lane.dropped && lane.dropped.length > 0)
    const empty =
      !lane.paused &&
      lane.hops === 0 &&
      !lane.summary &&
      !lane.compact &&
      lane.goal === undefined &&
      lane.carry === undefined &&
      lane.whisper === undefined &&
      lane.trigger === undefined &&
      !hasDropped &&
      lane.pending.length === 0

    stmt("DELETE FROM lane_queue WHERE agent_id = ?").run(agentId)
    if (empty) {
      stmt("DELETE FROM lane_state WHERE agent_id = ?").run(agentId)
      return
    }
    stmt(
      `INSERT OR REPLACE INTO lane_state (
         agent_id, project_id, paused, hops, summary, compact, goal, carry, whisper, trigger_id, dropped_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      agentId,
      projectId,
      lane.paused ? 1 : 0,
      lane.hops,
      lane.summary ? 1 : 0,
      lane.compact ? 1 : 0,
      lane.goal ?? null,
      lane.carry ?? null,
      lane.whisper ?? null,
      lane.trigger ?? null,
      hasDropped ? JSON.stringify(lane.dropped) : null,
    )
    const ins = stmt(
      "INSERT INTO lane_queue (agent_id, project_id, message_id, line, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    const now = Date.now()
    for (const item of lane.pending) {
      ins.run(agentId, projectId, item.id, item.line, now)
    }
  })
}

export type { SeatBinding }
