#!/usr/bin/env node
// Automated tests for daily SQLite backup & one-command restore (t_8e27bddd).
// Strictly runs against disposable temp directories; never touches live `data/`.

import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { pathToFileURL } from "node:url"

const repoDir = process.cwd()
const repoUrl = pathToFileURL(repoDir + path.sep).href
const aliasUrl = pathToFileURL(path.join(repoDir, "scripts/ts-alias.mjs")).href
const restoreScript = path.join(repoDir, "scripts/restore-bench.mjs")

function cleanChildEnv(extra = {}) {
  const next = { ...process.env }
  for (const k of Object.keys(next)) {
    if (k.startsWith("BENCH_")) delete next[k]
  }
  for (const k of [
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDECODE",
    "ANTIGRAVITY_CONVERSATION_ID",
    "CODEX_THREAD_ID",
    "CURSOR_AGENT_CHAT_ID",
    "DSH_SESSION_ID",
  ]) {
    delete next[k]
  }
  return { ...next, ...extra }
}

function listenEphemeral() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address()
      resolve({ server: srv, port: typeof addr === "object" && addr ? addr.port : 0 })
    })
  })
}

async function getClosedPort() {
  const { server, port } = await listenEphemeral()
  await new Promise((resolve) => server.close(resolve))
  return port
}

async function main() {
  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "bench-backup-test-"))
  try {
    const dataDir = path.join(tmpRoot, "data")
    const stateDir = path.join(tmpRoot, "state")
    mkdirSync(dataDir, { recursive: true })
    mkdirSync(stateDir, { recursive: true })

    // Create side files that must NOT be copied into backups or wiped by restore.
    writeFileSync(path.join(dataDir, "human-key"), "deadbeef".repeat(8), { mode: 0o600 })
    mkdirSync(path.join(dataDir, "seats"), { recursive: true })
    writeFileSync(path.join(dataDir, "seats", "a_demo.md"), "# demo seat\n")
    mkdirSync(path.join(dataDir, "uploads"), { recursive: true })
    writeFileSync(path.join(dataDir, "uploads", "sample.txt"), "attachment-payload")

    // Phase 1: In-process backup lifecycle, verification, 24h window, 7-copy retention,
    // corrupt snapshot rejection + front-desk alert, and unrelated file preservation.
    const phase1Script = path.join(tmpRoot, "phase1.mjs")
    writeFileSync(
      phase1Script,
      `
import assert from "node:assert/strict"
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs"
import path from "node:path"
import { register } from "node:module"
import { DatabaseSync } from "node:sqlite"

register(${JSON.stringify(aliasUrl)}, import.meta.url)
const root = ${JSON.stringify(repoUrl)}
const dbMod = await import(new URL("lib/db.ts", root).href)
const store = await import(new URL("lib/store.ts", root).href)
const backup = await import(new URL("lib/backup.ts", root).href)
const plain = await import(new URL("lib/plain.ts", root).href)

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

const bootAt = new Date(2026, 10, 1, 10, 0, 0, 0).getTime()
backup.resetBackupRuntimeForTest(bootAt)

// Set up front desk + normal project + messages + tasks in WAL mode.
const frontProj = store.createProject({ front: true }).project
const workProj = store.createProject({ name: "备份测试项目" }).project

store.inProject(workProj.id, () => {
  store.say({ as: "human", text: "第一天的项目记录一" })
  store.say({ as: "human", text: "第一天的项目记录二" })
  store.createTask({
    as: "human",
    title: "第一件重要待办",
    steps: ["把事情做完"],
  })
})

// 1) Boot grace (< 10 min): does not back up yet.
const early = backup.sweepBackup(bootAt + 5 * MIN)
assert.equal(early.status, "boot-grace", "启动未满 10 分钟不应提前备份")
assert.equal(existsSync(dbMod.backupsDir()), false, "启动宽限期内不应创建 backups 目录")

// 2) At boot + 10 min: creates first verified backup via VACUUM INTO.
const day1 = bootAt + 10 * MIN
const first = backup.sweepBackup(day1)
assert.equal(first.status, "backed-up", "启动满 10 分钟且无备份时应自动留第一份")
assert.equal(existsSync(first.result.file), true, "第一份备份文件应存在")

if (process.platform !== "win32") {
  const mode = statSync(first.result.file).mode & 0o777
  assert.equal(mode, 0o600, "备份文件权限必须是 0600")
}

// Verify backup folder only contains bench-YYYYMMDD-HHMM.db (no human-key, seats, uploads).
const dirEntries1 = readdirSync(dbMod.backupsDir())
assert.deepEqual(dirEntries1, [first.result.name], "backups 目录只应包含数据库备份文件")

// Read-only open & content match check (including WAL data).
{
  const ro = new DatabaseSync(first.result.file, { readOnly: true })
  try {
    const qc = ro.prepare("PRAGMA quick_check").all()
    assert.equal(qc.length, 1)
    assert.equal(String(Object.values(qc[0])[0]).toLowerCase(), "ok")
    const msgs = ro.prepare("SELECT text FROM messages WHERE project_id = ? ORDER BY seq ASC").all(workProj.id)
    assert.equal(msgs.length, 2, "备份库里应包含 WAL 中的全部消息")
    assert.match(String(msgs[0].text), /第一天的项目记录一/)
    assert.match(String(msgs[1].text), /第一天的项目记录二/)
    const tasks = ro.prepare("SELECT data_json FROM tasks WHERE project_id = ?").all(workProj.id)
    assert.equal(tasks.length, 1, "备份库里应包含创建的待办")
  } finally {
    ro.close()
  }
}

// 3) Within 24 hours: does not duplicate backup, and NEVER opens any backup file!
{
  const savedBytes = readFileSync(first.result.file)
  const savedStat = statSync(first.result.file)
  try {
    // Replace contents with non-SQLite sentinel and (when non-root) chmod 0000:
    // if sweepBackup tried to open/read the file (e.g. via listVerifiedBackups / quick_check),
    // it would treat it as unreadable/corrupt and mistakenly run a new backup instead of "not-due".
    writeFileSync(first.result.file, "SENTINEL_MUST_NOT_BE_OPENED_ON_HOURLY_TICK")
    utimesSync(first.result.file, savedStat.atime, savedStat.mtime)
    if (typeof process.getuid === "function" && process.getuid() !== 0) {
      chmodSync(first.result.file, 0o000)
    }
    const check1h = backup.sweepBackup(day1 + 1 * HOUR)
    assert.equal(check1h.status, "not-due", "未到期每小时检查绝不能打开备份文件跑 quick_check，应只看文件名和 mtime 返回 not-due")
    assert.equal(backup.sweepBackup(day1 + 12 * HOUR).status, "not-due", "12 小时后不应重复留备份")
    assert.equal(backup.sweepBackup(day1 + 24 * HOUR - MIN).status, "not-due", "未满 24 小时不应重复留备份")
    assert.deepEqual(readdirSync(dbMod.backupsDir()), [first.result.name], "未到期检查期间不应产生任何新文件")
  } finally {
    try {
      chmodSync(first.result.file, 0o600)
    } catch {}
    writeFileSync(first.result.file, savedBytes)
    utimesSync(first.result.file, savedStat.atime, savedStat.mtime)
  }
}
assert.equal(backup.listVerifiedBackups().length, 1, "24 小时内备份份数应仍为 1")

// 4) Days 2..8: keep newest 7, prune oldest on the 8th.
const createdNames = [first.result.name]
for (let d = 2; d <= 8; d++) {
  const t = day1 + (d - 1) * (DAY + 5 * MIN)
  store.inProject(workProj.id, () => {
    store.say({ as: "human", text: \`第\${d}天新增的对话记录\` })
  })
  const res = backup.sweepBackup(t)
  assert.equal(res.status, "backed-up", \`第 \${d} 天满 24 小时应留出备份\`)
  createdNames.push(res.result.name)
  if (d <= 7) {
    assert.equal(res.result.removed.length, 0, \`前 7 份不应删除任何旧备份（d=\${d}）\`)
    assert.equal(backup.listVerifiedBackups().length, d)
  } else {
    assert.deepEqual(res.result.removed, [createdNames[0]], "第 8 份出来时应只删最旧的第 1 份")
  }
}

const after8 = backup.listVerifiedBackups().map((b) => b.name)
assert.deepEqual(
  after8,
  createdNames.slice(1, 8),
  \`第 8 份后应保留最新的第 2..8 份共 7 份，实际：\${JSON.stringify(after8)}\`,
)
// Double check the newest (day 8) backup actually has day 8's message!
{
  const newestFile = path.join(dbMod.backupsDir(), createdNames[7])
  assert.equal(existsSync(newestFile), true, "最新第 8 份备份文件必须存在，不能被误删")
  const ro = new DatabaseSync(newestFile, { readOnly: true })
  try {
    const texts = ro.prepare("SELECT text FROM messages WHERE project_id = ?").all(workProj.id).map((r) => String(r.text))
    assert.ok(texts.some((t) => t.includes("第8天新增的对话记录")), "最新第 8 份备份必须包含第 8 天消息")
  } finally {
    ro.close()
  }
}

// 5) Corrupt / empty new backup MUST fail verification, delete temp file, post plain
//    system message in front desk, and keep all 7 existing good backups intact!
const day9BadA = day1 + 9 * (DAY + 5 * MIN)
const badCorrupt = backup.runBackup({
  now: day9BadA,
  produceSnapshot: (tmp) => {
    writeFileSync(tmp, Buffer.from("NOT_A_VALID_SQLITE_FILE_CORRUPTED_BYTES"))
  },
})
assert.equal(badCorrupt.ok, false, "损坏字节的备份必须校验不通过")
assert.deepEqual(
  backup.listVerifiedBackups().map((b) => b.name),
  createdNames.slice(1, 8),
  "坏备份失败后，旧的 7 份好备份必须一份不少",
)
assert.ok(
  !readdirSync(dbMod.backupsDir()).some((n) => n.startsWith(".tmp-") || n === backup.formatBackupName(day9BadA)),
  "坏备份的临时文件必须被清理，且不能转正为正式备份文件",
)

// Check front-desk system message is plain human language.
{
  const deskSnap = store.inProject(frontProj.id, () => store.snapshot())
  const sysMsgs = deskSnap.messages.filter((m) => m.kind === "system" && m.text.startsWith("数据备份没留成："))
  assert.equal(sysMsgs.length, 1, "备份失败应在前台项目发出一行系统消息")
  assert.equal(plain.plainFault(sysMsgs[0].text), null, \`前台系统消息必须是大白话：\${sysMsgs[0].text}\`)
}

// Empty tables backup (valid SQLite, quick_check ok, but 0 projects/messages while live DB is non-empty).
const day9BadB = day9BadA + 10 * MIN
const badEmpty = backup.runBackup({
  now: day9BadB,
  produceSnapshot: (tmp) => {
    const emptyDb = new DatabaseSync(tmp)
    emptyDb.exec("CREATE TABLE projects(id TEXT); CREATE TABLE messages(id TEXT); CREATE TABLE tasks(id TEXT);")
    emptyDb.close()
  },
})
assert.equal(badEmpty.ok, false, "原库非空而新备份为空表时必须校验不通过")
assert.match(badEmpty.why, /缺少原有/, "原因应说明缺少原有数据")
assert.deepEqual(
  backup.listVerifiedBackups().map((b) => b.name),
  createdNames.slice(1, 8),
  "空表坏备份失败后，旧的 7 份好备份仍须一份不少",
)

// Corrupt B-tree page inside an otherwise real SQLite file (triggers quick_check != ok or sqlite read error).
const day9BadC = day9BadA + 20 * MIN
store.inProject(workProj.id, () => {
  for (let i = 0; i < 30; i++) {
    store.say({ as: "human", text: "填充多页数据用于测试页面损坏检测_" + "字".repeat(400) })
  }
})
const badPages = backup.runBackup({
  now: day9BadC,
  produceSnapshot: (tmp) => {
    dbMod.dbVacuumInto(tmp)
    const buf = Buffer.from(readFileSync(tmp))
    // Corrupt pages after header so file header is still SQLite format 3, testing PRAGMA quick_check / page checksum.
    if (buf.length > 8192) {
      buf.fill(0xff, 4096, buf.length)
      writeFileSync(tmp, buf)
    } else {
      writeFileSync(tmp, Buffer.from("corrupt"))
    }
  },
})
assert.equal(badPages.ok, false, "数据页损坏的 SQLite 备份必须被拦截")
assert.deepEqual(
  backup.listVerifiedBackups().map((b) => b.name),
  createdNames.slice(1, 8),
  "数据页损坏备份被拒后，旧的 7 份好备份仍须一份不少",
)

// 6) Unrelated filenames & subdirectories in data/backups/ must NEVER be deleted.
const unrelatedFiles = [
  "notes.txt",
  "manual-backup.db",
  "bench-keep.db",
  "bench-20261399-9999.db",
]
for (const f of unrelatedFiles) {
  writeFileSync(path.join(dbMod.backupsDir(), f), "do-not-touch-" + f)
}
mkdirSync(path.join(dbMod.backupsDir(), "extra-folder"), { recursive: true })
writeFileSync(path.join(dbMod.backupsDir(), "extra-folder", "inside.txt"), "keep")

const day10 = day1 + 10 * (DAY + 5 * MIN)
const tenth = backup.sweepBackup(day10)
assert.equal(tenth.status, "backed-up", "第 10 天正常备份应成功")
assert.deepEqual(tenth.result.removed, [createdNames[1]], "第 10 天好备份应只删去当时最旧的好备份（第 2 天）")

for (const f of unrelatedFiles) {
  const p = path.join(dbMod.backupsDir(), f)
  assert.equal(existsSync(p), true, \`非备份命名格式文件不能被删：\${f}\`)
  assert.equal(readFileSync(p, "utf8"), "do-not-touch-" + f)
}
assert.equal(existsSync(path.join(dbMod.backupsDir(), "extra-folder", "inside.txt")), true, "子目录不能被删")

// Leave an extra uncheckpointed WAL write before closing process so Phase 2 restore tests saving -wal/-shm too!
store.inProject(workProj.id, () => {
  store.say({ as: "human", text: "恢复前误写入的一条脏消息_应当保存在before_restore里" })
})

writeFileSync(
  path.join(${JSON.stringify(tmpRoot)}, "phase1-meta.json"),
  JSON.stringify({
    workProjId: workProj.id,
    day5Name: createdNames[4],
    day10Name: tenth.result.name,
  }),
)
`,
    )

    {
      const p1 = spawnSync(process.execPath, [phase1Script], {
        cwd: repoDir,
        env: cleanChildEnv({
          BENCH_DATA_DIR: dataDir,
          XDG_STATE_HOME: stateDir,
        }),
        encoding: "utf8",
      })
      if (p1.stdout) process.stdout.write(p1.stdout)
      if (p1.status !== 0) {
        throw new Error((p1.stderr || p1.stdout || "phase1 failed").trim())
      }
    }

    const meta = JSON.parse(readFileSync(path.join(tmpRoot, "phase1-meta.json"), "utf8"))
    const backupsPath = path.join(dataDir, "backups")
    const day5BackupPath = path.join(backupsPath, meta.day5Name)

    // Ensure -wal and -shm exist alongside bench.db so we verify all three are preserved as before-restore-*.
    const liveDbPath = path.join(dataDir, "bench.db")
    if (!existsSync(`${liveDbPath}-wal`)) writeFileSync(`${liveDbPath}-wal`, Buffer.alloc(0))
    if (!existsSync(`${liveDbPath}-shm`)) writeFileSync(`${liveDbPath}-shm`, Buffer.alloc(0))

    // Phase 2a: Restore MUST refuse when room port is listening (and tell user `npm run stop`).
    const { server: livePortServer, port: busyPort } = await listenEphemeral()
    try {
      const busyRes = spawnSync(process.execPath, [restoreScript, "--latest"], {
        cwd: repoDir,
        env: cleanChildEnv({
          BENCH_DATA_DIR: dataDir,
          BENCH_URL: `http://127.0.0.1:${busyPort}`,
        }),
        encoding: "utf8",
      })
      assert.notEqual(busyRes.status, 0, "房间端口开着时 restore 必须非零退出拒绝恢复")
      assert.match(
        `${busyRes.stdout}\n${busyRes.stderr}`,
        /npm run stop/,
        "房间开着时应提示先运行 npm run stop",
      )
      assert.ok(
        !readdirSync(dataDir).some((n) => n.startsWith("bench.db.before-restore-")),
        "房间开着被拦下时不应改动数据库或生成 before-restore",
      )
    } finally {
      await new Promise((resolve) => livePortServer.close(resolve))
    }

    const idlePort = await getClosedPort()

    // Phase 2a-2: BENCH_URL points at an empty port while the dataDir's own room
    // is listening on another port (mismatch between BENCH_URL and BENCH_DATA_DIR):
    // restore MUST follow the data directory and refuse!
    {
      const fakeRepo = path.join(tmpRoot, "fake-repo")
      mkdirSync(path.join(fakeRepo, "scripts"), { recursive: true })
      mkdirSync(path.join(fakeRepo, "data", "backups"), { recursive: true })
      const fakeRestoreScript = path.join(fakeRepo, "scripts", "restore-bench.mjs")
      copyFileSync(restoreScript, fakeRestoreScript)
      writeFileSync(path.join(fakeRepo, "data", "bench.db"), "LIVE_REPO_DB_DO_NOT_REPLACE")
      copyFileSync(day5BackupPath, path.join(fakeRepo, "data", "backups", meta.day5Name))

      const { server: defaultRoomServer, port: busyDefaultPort } = await listenEphemeral()
      try {
        // BENCH_DATA_DIR is unset -> targets fakeRepo/data (the repo's own data/).
        // BENCH_URL points at idlePort (nobody listening), while fakeRepo's default room port IS listening!
        const mismatchRes = spawnSync(process.execPath, [fakeRestoreScript, "--latest"], {
          cwd: fakeRepo,
          env: cleanChildEnv({
            BENCH_DEFAULT_PORT: String(busyDefaultPort),
            BENCH_URL: `http://127.0.0.1:${idlePort}`,
          }),
          encoding: "utf8",
        })
        assert.notEqual(
          mismatchRes.status,
          0,
          `BENCH_URL 指向空端口但仓库 data/ 对应房间正开着时必须拒绝找回：\n${mismatchRes.stdout}\n${mismatchRes.stderr}`,
        )
        assert.match(`${mismatchRes.stdout}\n${mismatchRes.stderr}`, /npm run stop/)
        assert.equal(
          readFileSync(path.join(fakeRepo, "data", "bench.db"), "utf8"),
          "LIVE_REPO_DB_DO_NOT_REPLACE",
          "被拦下时仓库默认 data/bench.db 绝不能被换掉",
        )

        // Also test test-copy `<copy>/data` + `<copy>/port` layout with mismatched BENCH_URL.
        const fakeCopy = path.join(tmpRoot, "fake-copy")
        mkdirSync(path.join(fakeCopy, "data", "backups"), { recursive: true })
        writeFileSync(path.join(fakeCopy, "port"), `${busyDefaultPort}\n`)
        writeFileSync(path.join(fakeCopy, "data", "bench.db"), "COPY_DB_DO_NOT_REPLACE")
        copyFileSync(day5BackupPath, path.join(fakeCopy, "data", "backups", meta.day5Name))
        const copyMismatchRes = spawnSync(process.execPath, [restoreScript, "--latest"], {
          cwd: repoDir,
          env: cleanChildEnv({
            BENCH_DATA_DIR: path.join(fakeCopy, "data"),
            BENCH_URL: `http://127.0.0.1:${idlePort}`,
          }),
          encoding: "utf8",
        })
        assert.notEqual(copyMismatchRes.status, 0, "副本 data/ 旁边的 port 仍在监听时即使 BENCH_URL 指空端口也必须拒绝找回")
        assert.equal(readFileSync(path.join(fakeCopy, "data", "bench.db"), "utf8"), "COPY_DB_DO_NOT_REPLACE")
      } finally {
        await new Promise((resolve) => defaultRoomServer.close(resolve))
      }
    }

    // Phase 2a-3 (Linux): Another process has bench.db open (custom/unknown port, all checked ports idle) -> MUST refuse!
    if (process.platform === "linux" && existsSync("/proc")) {
      const holderScript = path.join(tmpRoot, "hold-db.mjs")
      writeFileSync(
        holderScript,
        `
import { DatabaseSync } from "node:sqlite"
const db = new DatabaseSync(${JSON.stringify(liveDbPath)})
db.exec("PRAGMA journal_mode = WAL; SELECT COUNT(*) FROM projects;")
process.stdout.write("HOLDING\\n")
setInterval(() => {}, 1000)
`,
      )
      const holder = spawn(process.execPath, [holderScript], {
        cwd: tmpRoot,
        stdio: ["ignore", "pipe", "pipe"],
      })
      try {
        await new Promise((resolve, reject) => {
          let out = ""
          const timer = setTimeout(() => reject(new Error("等待持库子进程超时")), 5000)
          holder.stdout.on("data", (chunk) => {
            out += chunk.toString()
            if (out.includes("HOLDING")) {
              clearTimeout(timer)
              resolve()
            }
          })
          holder.once("exit", (code) => {
            clearTimeout(timer)
            reject(new Error(`持库子进程提前退出：${code}`))
          })
        })

        const heldRes = spawnSync(process.execPath, [restoreScript, "--latest"], {
          cwd: repoDir,
          env: cleanChildEnv({
            BENCH_DATA_DIR: dataDir,
            BENCH_URL: `http://127.0.0.1:${idlePort}`,
            BENCH_DEFAULT_PORT: String(idlePort),
          }),
          encoding: "utf8",
        })
        assert.notEqual(
          heldRes.status,
          0,
          `有其他进程打开着 bench.db 时即使端口空闲也必须拒绝找回：\n${heldRes.stdout}\n${heldRes.stderr}`,
        )
        assert.match(`${heldRes.stdout}\n${heldRes.stderr}`, /PID/)
        assert.match(`${heldRes.stdout}\n${heldRes.stderr}`, /npm run stop/)
        assert.ok(
          !readdirSync(dataDir).some((n) => n.startsWith("bench.db.before-restore-")),
          "因进程持有数据库被拦下时不应生成 before-restore 或改动数据库",
        )
      } finally {
        try {
          holder.kill("SIGKILL")
        } catch {}
        await new Promise((resolve) => holder.once("close", resolve))
      }
    }

    // Phase 2b: Non-TTY without --latest or --file lists backups (time, size, projects, messages, tasks) and stops.
    {
      const nonTtyRes = spawnSync(process.execPath, [restoreScript], {
        cwd: repoDir,
        env: cleanChildEnv({
          BENCH_DATA_DIR: dataDir,
          BENCH_URL: `http://127.0.0.1:${idlePort}`,
        }),
        stdio: ["pipe", "pipe", "pipe"],
        encoding: "utf8",
      })
      assert.notEqual(nonTtyRes.status, 0, "非终端且未传 --latest/--file 时必须停手返回非零")
      assert.match(nonTtyRes.stdout, /个项目/, "列表输出应包含项目数")
      assert.match(nonTtyRes.stdout, /条消息/, "列表输出应包含消息数")
      assert.match(nonTtyRes.stdout, /条待办/, "列表输出应包含待办数")
      assert.match(nonTtyRes.stderr, /--latest/, "非终端停手时应提示 --latest / --file")
    }

    // Phase 2c: Restore from specific `--file <day5>`:
    // - Saves current bench.db, -wal, -shm to bench.db.before-restore-<stamp>*
    // - Replaces bench.db with day5 backup, runs quick_check, and prompts to restart.
    {
      const restoreDay5 = spawnSync(process.execPath, [restoreScript, "--file", day5BackupPath], {
        cwd: repoDir,
        env: cleanChildEnv({
          BENCH_DATA_DIR: dataDir,
          BENCH_URL: `http://127.0.0.1:${idlePort}`,
        }),
        encoding: "utf8",
      })
      assert.equal(
        restoreDay5.status,
        0,
        `restore --file 应成功退出 0，实际输出：\n${restoreDay5.stdout}\n${restoreDay5.stderr}`,
      )
      assert.match(restoreDay5.stdout, /quick_check 通过/, "输出应确认换入后 quick_check 通过")
      assert.match(restoreDay5.stdout, /重新启动/, "输出应提示重新启动")

      const beforeFiles = readdirSync(dataDir).filter((n) => n.startsWith("bench.db.before-restore-"))
      const mainSaved = beforeFiles.find((n) => !n.endsWith("-wal") && !n.endsWith("-shm"))
      assert.ok(mainSaved, "找回前必须把原 bench.db 另存为 bench.db.before-restore-<时间>")
      assert.ok(beforeFiles.includes(`${mainSaved}-wal`), "找回前必须一并另存原 bench.db-wal")
      assert.ok(beforeFiles.includes(`${mainSaved}-shm`), "找回前必须一并另存原 bench.db-shm")
      assert.equal(existsSync(`${liveDbPath}-wal`), false, "恢复刚完成时原地不应残留旧 -wal")
      assert.equal(existsSync(`${liveDbPath}-shm`), false, "恢复刚完成时原地不应残留旧 -shm")

      // Verify the saved `before-restore` DB actually contains the pre-restore dirty message!
      const savedRo = new DatabaseSync(path.join(dataDir, mainSaved), { readOnly: true })
      try {
        const savedTexts = savedRo
          .prepare("SELECT text FROM messages WHERE project_id = ?")
          .all(meta.workProjId)
          .map((r) => String(r.text))
        assert.ok(
          savedTexts.some((t) => t.includes("恢复前误写入的一条脏消息_应当保存在before_restore里")),
          "before-restore 备份里必须完整保留恢复前（含原 WAL）的数据",
        )
      } finally {
        savedRo.close()
      }

      // Verify the restored `bench.db` matches day 5 (has day 5, does NOT have day 8 or the dirty message).
      const restoredRo = new DatabaseSync(liveDbPath, { readOnly: true })
      try {
        const qc = restoredRo.prepare("PRAGMA quick_check").all()
        assert.equal(String(Object.values(qc[0])[0]).toLowerCase(), "ok")
        const texts = restoredRo
          .prepare("SELECT text FROM messages WHERE project_id = ?")
          .all(meta.workProjId)
          .map((r) => String(r.text))
        assert.ok(texts.some((t) => t.includes("第5天新增的对话记录")), "找回第 5 天备份后应有第 5 天的记录")
        assert.ok(!texts.some((t) => t.includes("第8天新增的对话记录")), "找回第 5 天备份后不应有第 8 天的记录")
        assert.ok(
          !texts.some((t) => t.includes("恢复前误写入的一条脏消息")),
          "找回第 5 天备份后不应残留恢复前的误写消息",
        )
      } finally {
        restoredRo.close()
      }

      // Side files untouched.
      assert.equal(readFileSync(path.join(dataDir, "human-key"), "utf8"), "deadbeef".repeat(8))
      assert.equal(readFileSync(path.join(dataDir, "uploads", "sample.txt"), "utf8"), "attachment-payload")
    }

    // Phase 2d: Corrupt live `bench.db` completely, then rescue with `restore --latest` (day 10).
    {
      writeFileSync(liveDbPath, "TOTALLY_CORRUPTED_DATABASE_BYTES")
      const rescueRes = spawnSync(process.execPath, [restoreScript, "--latest"], {
        cwd: repoDir,
        env: cleanChildEnv({
          BENCH_DATA_DIR: dataDir,
          BENCH_URL: `http://127.0.0.1:${idlePort}`,
        }),
        encoding: "utf8",
      })
      assert.equal(rescueRes.status, 0, `bench.db 损坏后 restore --latest 应成功救回：${rescueRes.stderr}`)
      const rescuedRo = new DatabaseSync(liveDbPath, { readOnly: true })
      try {
        const texts = rescuedRo
          .prepare("SELECT text FROM messages WHERE project_id = ?")
          .all(meta.workProjId)
          .map((r) => String(r.text))
        assert.ok(texts.some((t) => t.includes("第8天新增的对话记录")), "restore --latest 应找回最新好备份的数据")
      } finally {
        rescuedRo.close()
      }
    }

    // Phase 2e: `--file` pointing at a corrupt file must refuse without touching live `bench.db`.
    {
      const brokenBackup = path.join(tmpRoot, "broken-backup.db")
      writeFileSync(brokenBackup, "BAD_FILE")
      const badFileRes = spawnSync(process.execPath, [restoreScript, "--file", brokenBackup], {
        cwd: repoDir,
        env: cleanChildEnv({
          BENCH_DATA_DIR: dataDir,
          BENCH_URL: `http://127.0.0.1:${idlePort}`,
        }),
        encoding: "utf8",
      })
      assert.notEqual(badFileRes.status, 0, "指定损坏备份文件恢复时必须报错停手")
      const stillGoodRo = new DatabaseSync(liveDbPath, { readOnly: true })
      try {
        const qc = stillGoodRo.prepare("PRAGMA quick_check").all()
        assert.equal(String(Object.values(qc[0])[0]).toLowerCase(), "ok", "拒绝坏备份后现有 bench.db 必须完好")
      } finally {
        stillGoodRo.close()
      }
    }

    // Phase 2f: Interactive TTY selection via node-pty (pick item #2 = day 8 backup).
    {
      const ptyMod = await import("node-pty").catch(() => null)
      if (ptyMod) {
        const ptyOut = await new Promise((resolve, reject) => {
          const proc = ptyMod.spawn(process.execPath, [restoreScript], {
            name: "xterm-256color",
            cols: 100,
            rows: 30,
            cwd: repoDir,
            env: cleanChildEnv({
              BENCH_DATA_DIR: dataDir,
              BENCH_URL: `http://127.0.0.1:${idlePort}`,
            }),
          })
          let buf = ""
          let answered = false
          const timer = setTimeout(() => {
            try {
              proc.kill()
            } catch {}
            reject(new Error(`交互式 restore 超时，已输出：\n${buf}`))
          }, 10_000)
          proc.onData((chunk) => {
            buf += chunk
            if (!answered && buf.includes("要找回哪一份")) {
              answered = true
              proc.write("2\r")
            }
          })
          proc.onExit(({ exitCode }) => {
            clearTimeout(timer)
            resolve({ exitCode, buf })
          })
        })
        assert.equal(ptyOut.exitCode, 0, `交互式终端选第 2 份应成功退出 0：\n${ptyOut.buf}`)
        assert.match(ptyOut.buf, /已找回数据/, "交互式输出应确认已找回数据")
        const ttyRo = new DatabaseSync(liveDbPath, { readOnly: true })
        try {
          const texts = ttyRo
            .prepare("SELECT text FROM messages WHERE project_id = ?")
            .all(meta.workProjId)
            .map((r) => String(r.text))
          // Item #1 is day 10 (has "填充多页数据"), Item #2 is day 8 (has day 8, does NOT have day 9/10 filler).
          assert.ok(texts.some((t) => t.includes("第8天新增的对话记录")), "选第 2 份应包含第 8 天记录")
          assert.ok(!texts.some((t) => t.includes("填充多页数据用于测试页面损坏检测")), "选第 2 份不应包含第 9/10 天的填充记录")
        } finally {
          ttyRo.close()
        }
      }
    }

    // Phase 3: Real timer firing via `ensureBackup()` with shortened env intervals.
    const timerDir = path.join(tmpRoot, "timer-data")
    mkdirSync(timerDir, { recursive: true })
    const timerScript = path.join(tmpRoot, "phase3-timer.mjs")
    writeFileSync(
      timerScript,
      `
import assert from "node:assert/strict"
import { register } from "node:module"

register(${JSON.stringify(aliasUrl)}, import.meta.url)
const root = ${JSON.stringify(repoUrl)}
const store = await import(new URL("lib/store.ts", root).href)
const backup = await import(new URL("lib/backup.ts", root).href)

const proj = store.createProject({ name: "定时器备份项目" }).project
store.inProject(proj.id, () => {
  store.say({ as: "human", text: "定时器触发的自动备份消息" })
})

backup.resetBackupRuntimeForTest(Date.now())
backup.ensureBackup()
await new Promise((r) => setTimeout(r, 220))
const list = backup.listVerifiedBackups()
assert.equal(list.length, 1, "ensureBackup 到点后应自动留下一份好备份")
assert.equal(list[0].messages >= 1, true)
backup.resetBackupRuntimeForTest(Date.now())
`,
    )
    {
      const p3 = spawnSync(process.execPath, [timerScript], {
        cwd: repoDir,
        env: cleanChildEnv({
          BENCH_DATA_DIR: timerDir,
          XDG_STATE_HOME: stateDir,
          BENCH_BACKUP_BOOT_MS: "50",
          BENCH_BACKUP_TICK_MS: "80",
        }),
        encoding: "utf8",
      })
      if (p3.stdout) process.stdout.write(p3.stdout)
      if (p3.status !== 0) {
        throw new Error((p3.stderr || p3.stdout || "phase3 failed").trim())
      }
    }

    console.log("backup ok")
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true })
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err instanceof Error ? err.stack || err.message : String(err))
    process.exit(1)
  })
