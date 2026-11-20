#!/usr/bin/env node
// Stop the running bench server (either started by start.sh / npm run dev or
// inside the `bench-dev` tmux session started by scripts/start-bench.sh).
// Refuses to interrupt working AI seats unless --force is given, refuses to
// guess when the room's status cannot be read, leaves tmux sessions for other
// ports untouched, and spares detached user windows while stopping detached AI
// children marked with BENCH_RUN_KEY.
import { spawnSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync, readlinkSync } from "node:fs"

const argv = process.argv.slice(2)
const force = argv.includes("--force") || argv.includes("-f") || process.env.npm_config_force === "true"

if (process.platform === "win32") {
  console.log("Windows 上暂不支持 npm run stop 一键停服。")
  console.log("请切换到运行 start.bat 或 npm run dev 的命令行窗口按 Ctrl+C，或直接关闭该窗口。")
  process.exit(1)
}

const rawUrl = (process.env.BENCH_URL || "http://127.0.0.1:4399").replace(/\/$/, "")
let parsedUrl
try {
  parsedUrl = new URL(rawUrl)
} catch {
  console.error(`BENCH_URL 不是合法地址：${rawUrl}`)
  process.exit(2)
}
const port = Number(parsedUrl.port || (parsedUrl.protocol === "https:" ? 443 : 80))
const isDefaultTarget =
  port === 4399 && (parsedUrl.hostname === "127.0.0.1" || parsedUrl.hostname === "localhost")
const tmuxBin = process.env.BENCH_TMUX_BIN || "tmux"
const sessionName = process.env.BENCH_TMUX_SESSION || "bench-dev"

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function commandExists(bin) {
  const res = spawnSync(bin, ["-V"], { stdio: "ignore" })
  return !res.error
}

function hasTmuxSession() {
  if (!commandExists(tmuxBin)) return false
  const res = spawnSync(tmuxBin, ["has-session", "-t", `=${sessionName}`], { stdio: "ignore" })
  return res.status === 0
}

function currentTmuxSession() {
  if (!process.env.TMUX || !commandExists(tmuxBin)) return ""
  const res = spawnSync(tmuxBin, ["display-message", "-p", "#S"], { encoding: "utf8" })
  return res.status === 0 ? res.stdout.trim() : ""
}

function statInfoOf(pid) {
  if (process.platform === "linux" && existsSync(`/proc/${pid}/stat`)) {
    try {
      const raw = readFileSync(`/proc/${pid}/stat`, "utf8")
      const end = raw.lastIndexOf(")")
      if (end !== -1) {
        const fields = raw.slice(end + 2).trim().split(/\s+/)
        const ppid = Number(fields[1])
        const pgid = Number(fields[2])
        const startTime = fields[19] || ""
        if (Number.isInteger(ppid) && Number.isInteger(pgid)) return { ppid, pgid, startTime }
      }
    } catch {}
  }
  const ps = spawnSync("ps", ["-p", String(pid), "-o", "ppid=,pgid="], { encoding: "utf8" })
  if (ps.status === 0) {
    const parts = ps.stdout.trim().split(/\s+/)
    const ppid = Number(parts[0])
    const pgid = Number(parts[1])
    if (Number.isInteger(ppid) && Number.isInteger(pgid)) return { ppid, pgid, startTime: "" }
  }
  return null
}

function tmuxSessionPanePids() {
  const res = spawnSync(tmuxBin, ["list-panes", "-t", `=${sessionName}`, "-F", "#{pane_pid}"], {
    encoding: "utf8",
  })
  if (res.error || res.status !== 0) return new Set()
  const pids = new Set()
  for (const line of res.stdout.split("\n")) {
    const n = Number(line.trim())
    if (Number.isInteger(n) && n > 1) pids.add(n)
  }
  return pids
}

function pidInTmuxSession(pids, panePids) {
  if (panePids.size === 0 || pids.length === 0) return false
  for (const pid of pids) {
    let cur = pid
    const seen = new Set()
    for (let depth = 0; depth < 64 && cur > 1 && !seen.has(cur); depth++) {
      if (panePids.has(cur)) return true
      seen.add(cur)
      cur = statInfoOf(cur)?.ppid ?? 0
    }
  }
  return false
}

function pidsFromProc(targetPort) {
  if (process.platform !== "linux") return []
  const hexPort = targetPort.toString(16).toUpperCase().padStart(4, "0")
  const inodes = new Set()
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    if (!existsSync(file)) continue
    const lines = readFileSync(file, "utf8").split("\n").slice(1)
    for (const line of lines) {
      const cols = line.trim().split(/\s+/)
      if (cols.length < 10) continue
      const [, local, , state, , , , , , inode] = cols
      if (state === "0A" && local.endsWith(`:${hexPort}`) && inode && inode !== "0") {
        inodes.add(`socket:[${inode}]`)
      }
    }
  }
  if (inodes.size === 0) return []
  const pids = new Set()
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue
    const fdDir = `/proc/${entry}/fd`
    let fds
    try {
      fds = readdirSync(fdDir)
    } catch {
      continue
    }
    for (const fd of fds) {
      try {
        if (inodes.has(readlinkSync(`${fdDir}/${fd}`))) {
          pids.add(Number(entry))
          break
        }
      } catch {}
    }
  }
  return [...pids]
}

function listeningPids(targetPort) {
  const found = new Set()
  const ss = spawnSync("ss", ["-H", "-ltnp", `sport = :${targetPort}`], { encoding: "utf8" })
  if (!ss.error && ss.status === 0) {
    for (const m of ss.stdout.matchAll(/pid=(\d+)/g)) found.add(Number(m[1]))
    if (found.size > 0) return [...found]
  }
  const lsof = spawnSync("lsof", ["-nP", `-iTCP:${targetPort}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" })
  if (!lsof.error && lsof.status === 0) {
    for (const line of lsof.stdout.split("\n")) {
      const n = Number(line.trim())
      if (Number.isInteger(n) && n > 0) found.add(n)
    }
    if (found.size > 0) return [...found]
  }
  for (const pid of pidsFromProc(targetPort)) found.add(pid)
  return [...found]
}

function cmdlineOf(pid) {
  if (process.platform === "linux" && existsSync(`/proc/${pid}/cmdline`)) {
    try {
      return readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").trim()
    } catch {}
  }
  const ps = spawnSync("ps", ["-p", String(pid), "-o", "args="], { encoding: "utf8" })
  return ps.status === 0 ? ps.stdout.trim() : ""
}

function buildProcChildrenMap() {
  if (process.platform !== "linux") return null
  const childrenMap = new Map()
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue
    const pid = Number(entry)
    const info = statInfoOf(pid)
    if (!info) continue
    let list = childrenMap.get(info.ppid)
    if (!list) {
      list = []
      childrenMap.set(info.ppid, list)
    }
    list.push(pid)
  }
  return childrenMap
}

function descendantsOf(rootPids) {
  const rootSet = new Set(rootPids)
  const visited = new Set(rootPids)
  const queue = [...rootPids]
  const found = []
  const procMap = buildProcChildrenMap()
  while (queue.length > 0) {
    const pid = queue.shift()
    let kids = []
    if (procMap) {
      kids = procMap.get(pid) ?? []
    } else {
      const pg = spawnSync("pgrep", ["-P", String(pid)], { encoding: "utf8" })
      if (pg.status === 0) {
        kids = pg.stdout
          .split("\n")
          .map((s) => Number(s.trim()))
          .filter((n) => Number.isInteger(n) && n > 0)
      }
    }
    for (const child of kids) {
      if (visited.has(child)) continue
      visited.add(child)
      queue.push(child)
      if (!rootSet.has(child) && child !== process.pid && child !== process.ppid) {
        found.push(child)
      }
    }
  }
  return found
}

// On Linux, woken AI processes carry BENCH_RUN_KEY (lib/summon.ts); unrecognized
// detached processes (like user-opened editors or audio capture) are left alone.
function hasBenchRunKey(pid) {
  if (process.platform !== "linux") return false
  try {
    const raw = readFileSync(`/proc/${pid}/environ`, "utf8")
    return raw.split("\0").some((item) => item.startsWith("BENCH_RUN_KEY=") && item.length > "BENCH_RUN_KEY=".length)
  } catch {
    return false
  }
}

function collectAiTargets(rootPids, listenerPgids, myPgid) {
  const targets = []
  for (const pid of descendantsOf(rootPids)) {
    const info = statInfoOf(pid)
    if (!info) continue
    if (info.pgid === myPgid || listenerPgids.has(info.pgid)) continue
    if (hasBenchRunKey(pid)) {
      targets.push({ pid, pgid: info.pgid, startTime: info.startTime })
    }
  }
  return targets
}

function listenerGroupPlan(pids, myPgid) {
  const pgids = new Set()
  const soloPids = new Set()
  for (const pid of pids) {
    if (pid === process.pid || pid === process.ppid) continue
    const info = statInfoOf(pid)
    if (info && info.pgid > 1 && info.pgid !== myPgid) pgids.add(info.pgid)
    else soloPids.add(pid)
  }
  return { pgids, soloPids }
}

function signalListeners(plan, sig) {
  for (const pgid of plan.pgids) {
    try {
      process.kill(-pgid, sig)
    } catch {}
  }
  for (const pid of plan.soloPids) {
    try {
      process.kill(pid, sig)
    } catch {}
  }
}

function aiTargetStillMatches(target) {
  const cur = statInfoOf(target.pid)
  if (!cur) return false
  if (target.startTime && cur.startTime && cur.startTime !== target.startTime) return false
  return hasBenchRunKey(target.pid)
}

function signalAiTargets(aiTargets, myPgid, listenerPgids, sig) {
  const signaledPgids = new Set()
  for (const target of aiTargets) {
    if (!aiTargetStillMatches(target)) continue
    if (target.pgid > 1 && target.pgid === target.pid && target.pgid !== myPgid && !listenerPgids.has(target.pgid)) {
      if (signaledPgids.has(target.pgid)) continue
      signaledPgids.add(target.pgid)
      try {
        process.kill(-target.pgid, sig)
        continue
      } catch {}
    }
    try {
      process.kill(target.pid, sig)
    } catch {}
  }
}

function anyAiTargetAlive(aiTargets) {
  for (const target of aiTargets) {
    if (!aiTargetStillMatches(target)) continue
    try {
      process.kill(target.pid, 0)
      return true
    } catch {}
  }
  return false
}

function looksLikeBench(pids, roomConfirmed, tmuxOwns) {
  if (roomConfirmed || tmuxOwns) return true
  return pids.some((pid) => /\bnext\b|next-server|bench|start-bench/i.test(cmdlineOf(pid)))
}

async function queryRoomState() {
  try {
    const res = await fetch(`${rawUrl}/api/v1/projects`, { signal: AbortSignal.timeout(2500) })
    if (!res.ok) return { reachable: false, error: `接口返回 HTTP ${res.status}` }
    const data = await res.json().catch(() => null)
    if (!data || !Array.isArray(data.projects)) {
      return { reachable: false, error: "接口返回的不是有效的并坐项目列表" }
    }
    const working = []
    for (const proj of data.projects) {
      const rRes = await fetch(`${rawUrl}/api/v1/room?project=${encodeURIComponent(proj.id)}`, {
        signal: AbortSignal.timeout(2500),
      })
      if (!rRes.ok) {
        return { reachable: true, confirmed: true, partialError: `读取项目「${proj.name}」状态失败（HTTP ${rRes.status}）` }
      }
      const room = await rRes.json().catch(() => null)
      if (!room || !Array.isArray(room.agents)) {
        return { reachable: true, confirmed: true, partialError: `项目「${proj.name}」返回数据异常` }
      }
      for (const agent of room.agents) {
        if (agent.demo) continue
        if (agent.status === "working" || Boolean(agent.runId)) {
          working.push({ project: proj.name, seat: agent.name, what: agent.doing || "正在干活" })
        }
      }
    }
    return { reachable: true, confirmed: true, working }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    return { reachable: false, error: /abort|timeout/i.test(msg) ? "请求房间状态超时" : "连不上房间接口" }
  }
}

async function main() {
  const myPgid = statInfoOf(process.pid)?.pgid ?? 0
  const initialPids = listeningPids(port)
  const initialTmux = hasTmuxSession()
  const panePids = initialTmux && initialPids.length > 0 ? tmuxSessionPanePids() : new Set()
  const tmuxOwns = pidInTmuxSession(initialPids, panePids)
  const shouldManageTmux = initialTmux && (initialPids.length > 0 ? tmuxOwns : isDefaultTarget)
  const state = await queryRoomState()

  if (!state.reachable && initialPids.length === 0 && !shouldManageTmux) {
    console.log(`并坐当前没有在运行（端口 ${port} 空闲，也没有需要清理的会话）。`)
    process.exit(0)
  }

  if (initialPids.length > 0 && !looksLikeBench(initialPids, Boolean(state.confirmed), tmuxOwns)) {
    console.error(`端口 ${port} 正被其它程序（PID ${initialPids.join(", ")}）占用，但接口确认不是并坐，已停手免得误杀。`)
    process.exit(1)
  }

  if (state.confirmed && !state.partialError && state.working.length > 0 && !force) {
    console.error("以下 AI 正在干活，现在停掉并坐会打断它们：")
    for (const item of state.working) {
      console.error(`  - [${item.project}] ${item.seat}：${item.what}`)
    }
    console.error("如果确认要强行停止，请运行：npm run stop -- --force")
    process.exit(1)
  }

  const unknownReason = state.partialError || (!state.reachable && initialPids.length > 0 ? state.error : "")
  if (unknownReason) {
    if (!force) {
      console.error(`问不到房间当前状态（${unknownReason}），无法确认有没有 AI 正在干活。`)
      console.error("如果确认要强行停止，请运行：npm run stop -- --force")
      process.exit(1)
    }
    console.log(`问不到房间当前状态（${unknownReason}），已带 --force，继续停止…`)
  } else if (state.working?.length > 0 && force) {
    console.log(`已带 --force，强行停止正在干活的 ${state.working.length} 个席位所在房间…`)
  }

  // Discover listener groups and detached BENCH_RUN_KEY AI children before C-c
  // exits the listener and reparents any detached children to init.
  const initialPlan = listenerGroupPlan(initialPids, myPgid)
  const aiTargets = initialPids.length > 0 ? collectAiTargets(initialPids, initialPlan.pgids, myPgid) : []

  const insideTmux = currentTmuxSession() === sessionName
  let stoppedTmux = false

  if (shouldManageTmux) {
    spawnSync(tmuxBin, ["send-keys", "-t", `=${sessionName}`, "C-c"], { stdio: "ignore" })
    for (let i = 0; i < 15; i++) {
      await sleep(200)
      if (listeningPids(port).length === 0 && !hasTmuxSession()) break
    }
  }

  let remain = listeningPids(port)
  const allListenerPgids = new Set(initialPlan.pgids)
  if (remain.length > 0 || anyAiTargetAlive(aiTargets)) {
    const remainPlan = listenerGroupPlan(remain, myPgid)
    for (const pg of remainPlan.pgids) allListenerPgids.add(pg)
    for (const extraAi of collectAiTargets(remain, allListenerPgids, myPgid)) {
      if (!aiTargets.some((t) => t.pid === extraAi.pid)) aiTargets.push(extraAi)
    }
    signalListeners(remainPlan, "SIGTERM")
    signalAiTargets(aiTargets, myPgid, allListenerPgids, "SIGTERM")
    for (let i = 0; i < 20; i++) {
      await sleep(200)
      remain = listeningPids(port)
      if (remain.length === 0 && !anyAiTargetAlive(aiTargets)) break
    }
    if (remain.length > 0 || anyAiTargetAlive(aiTargets)) {
      const killPlan = listenerGroupPlan(remain, myPgid)
      signalListeners(killPlan, "SIGKILL")
      signalAiTargets(aiTargets, myPgid, allListenerPgids, "SIGKILL")
      await sleep(400)
      remain = listeningPids(port)
    }
  }

  if (shouldManageTmux) {
    if (hasTmuxSession()) {
      if (insideTmux) {
        console.log(`提示：当前命令正在 tmux 会话 ${sessionName} 内部运行，已为你保留会话窗口本身。`)
      } else {
        const killed = spawnSync(tmuxBin, ["kill-session", "-t", `=${sessionName}`], { stdio: "ignore" })
        if (killed.status === 0) stoppedTmux = true
      }
    } else {
      stoppedTmux = true
    }
  }

  if (remain.length > 0) {
    console.error(`没能彻底停掉端口 ${port} 上的进程（仍在运行：PID ${remain.join(", ")}），请检查权限后手动处理。`)
    process.exit(1)
  }

  const details = [`端口 ${port}`]
  if (stoppedTmux) details.push(`会话 ${sessionName}`)
  console.log(`✓ 已停止并坐（${details.join("、")}）。`)
}

main()
