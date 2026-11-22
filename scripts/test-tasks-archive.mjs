#!/usr/bin/env node
// Done-task archival & read-only lookup (`snapshotTasks`, `queryDoneTasks`, `getTaskById` in lib/store.ts).
// Runs the room's code in-process against a throwaway SQLite folder so it never touches a live room:
//   node scripts/test-tasks-archive.mjs
// BENCH_ROOT=<a copy of the repo> runs that copy's code instead (used by scripts/test-faults.mjs).
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { register } from "node:module"
import os from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = process.env.BENCH_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
register(pathToFileURL(path.join(root, "scripts/ts-alias.mjs")).href, import.meta.url)

// Phase 1 (child): seed a fresh temporary DB with 1 open, 1 recent done (<48h), and 1 archived done (>48h).
const seedDir = process.env.ARCHIVE_SEED_DIR
if (seedDir) {
  process.env.BENCH_DATA_DIR = seedDir
  const store = await import(pathToFileURL(path.join(root, "lib/store.ts")).href)
  const proj = store.createProject({ as: "human", name: "归档测试项目" }).project
  const ids = store.inProject(proj.id, () => {
    const owner = store.join({ name: "工匠", model: "mock", role: "开发" })
    const asOwner = { agentId: owner.agent.id, token: owner.token }

    const active = store.createTask({ ...asOwner, title: "还在做的待办", owner: owner.agent.name, steps: ["做事"] })
    const oldRes = store.createTask({ ...asOwner, title: "五天前做完的待办", owner: owner.agent.name, steps: ["做完它"] })
    store.actOnTask({ ...asOwner, taskId: oldRes.task.id, action: "step", step: 1, state: "done" })
    store.actOnTask({ ...asOwner, taskId: oldRes.task.id, action: "review", note: "完成" })
    store.actOnTask({ as: "human", taskId: oldRes.task.id, action: "pass" })

    const recentRes = store.createTask({ ...asOwner, title: "刚刚做完的待办", owner: owner.agent.name, steps: ["做完它"] })
    store.actOnTask({ ...asOwner, taskId: recentRes.task.id, action: "step", step: 1, state: "done" })
    store.actOnTask({ ...asOwner, taskId: recentRes.task.id, action: "review", note: "完成" })
    store.actOnTask({ as: "human", taskId: recentRes.task.id, action: "pass" })

    return {
      projectId: proj.id,
      activeId: active.task.id,
      oldId: oldRes.task.id,
      recentId: recentRes.task.id,
    }
  })

  // Move oldId's completion timestamp back 5 days directly in the cold DB before the next process loads it.
  const db = new DatabaseSync(path.join(seedDir, "bench.db"))
  try {
    const fiveDaysAgo = Date.now() - 5 * 24 * 3600_000
    const row = db.prepare("SELECT data_json FROM tasks WHERE id = ?").get(ids.oldId)
    const parsed = JSON.parse(String(row.data_json))
    parsed.updatedAt = fiveDaysAgo
    db.prepare("UPDATE tasks SET updated_at = ?, data_json = ? WHERE id = ?").run(
      fiveDaysAgo,
      JSON.stringify(parsed),
      ids.oldId,
    )
  } finally {
    db.close()
  }
  console.log(JSON.stringify(ids))
  process.exit(0)
}

// Phase 2 (main): spawn phase 1 to populate the temp DB, then load the store cold from that DB.
const tmp = mkdtempSync(path.join(os.tmpdir(), "bench-archive-"))
const dataDir = path.join(tmp, "data")
process.on("exit", () => {
  try { globalThis.__benchSqlite?.db?.close() } catch {}
  try { rmSync(tmp, { recursive: true, force: true }) } catch {}
})

const seedRun = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
  cwd: root,
  env: { ...process.env, BENCH_ROOT: root, ARCHIVE_SEED_DIR: dataDir },
  encoding: "utf8",
})
if (seedRun.status !== 0) {
  throw new Error(`初始化归档测试数据库失败：${seedRun.stderr || seedRun.stdout}`)
}
const seeded = JSON.parse(seedRun.stdout.trim().split("\n").at(-1))

process.env.BENCH_DATA_DIR = dataDir
const store = await import(pathToFileURL(path.join(root, "lib/store.ts")).href)

let failed = 0
function check(ok, what) {
  console.log(`${ok ? "ok " : "FAIL"} ${what}`)
  if (!ok) failed++
}

store.inProject(seeded.projectId, () => {
  const snap = store.snapshot()
  check(snap.tasks.some((t) => t.id === seeded.activeId), "主快照保留进行中待办")
  check(snap.tasks.some((t) => t.id === seeded.recentId), "主快照保留 48 小时内完成的待办")
  check(!snap.tasks.some((t) => t.id === seeded.oldId), "主快照剔除超过 48 小时完成的旧待办")
  check(snap.doneTotal === 2, `快照 doneTotal 应为全部已完成总数 2，实际 ${snap.doneTotal}`)

  const page1 = store.queryDoneTasks({ limit: 1 })
  check(
    page1.tasks.length === 1 && page1.tasks[0].id === seeded.recentId && page1.doneTotal === 2 && page1.hasMore === true,
    `queryDoneTasks 第一页应返回近期待办且 hasMore 为 true`,
  )

  const page2ById = store.queryDoneTasks({ before: seeded.recentId, limit: 5 })
  check(
    page2ById.tasks.length === 1 && page2ById.tasks[0].id === seeded.oldId && page2ById.hasMore === false,
    `按 before=id 分页应拉回超过 48 小时的旧待办`,
  )

  const page2ByTs = store.queryDoneTasks({ before: page1.tasks[0].updatedAt, limit: 5 })
  check(
    page2ByTs.tasks.length === 1 && page2ByTs.tasks[0].id === seeded.oldId && page2ByTs.hasMore === false,
    `按 before=时间戳 分页应拉回超过 48 小时的旧待办`,
  )

  let fetchedOld = null
  let fetchOldErr = ""
  try {
    fetchedOld = store.getTaskById(seeded.oldId)
  } catch (error) {
    fetchOldErr = error instanceof Error ? error.message : String(error)
  }
  check(
    Boolean(fetchedOld && fetchedOld.id === seeded.oldId && fetchedOld.status === "done"),
    `getTaskById 必须能按 id 拉到超 48 小时旧待办${fetchOldErr ? `（报错：${fetchOldErr}）` : ""}`,
  )

  let missingStatus = 0
  try {
    store.getTaskById("t_00000000")
  } catch (error) {
    missingStatus = Number(error?.status ?? 0)
  }
  check(missingStatus === 404, `不存在的待办应抛出 404，实际 ${missingStatus}`)
})

if (failed > 0) {
  throw new Error(`archive test: ${failed} failed`)
}
console.log("tasks-archive ok")
