#!/usr/bin/env node
// Isolated verification for t_eda97cfc:
//   - scripts/ensure-deps.mjs (+ start.sh / scripts/start-bench.sh failure & --background)
//   - scripts/stop-bench.mjs (idle, active AI, unreachable status, tmux ownership, PGID + BENCH_RUN_KEY, --force)
//   - scripts/setup-bench.mjs (--no-autostart, y/n prompt with --background, --remove, missing tmux)
//   - scripts/update-bench.mjs (dirty tree refused, clean pull + deps + notice, cwd outside repo)
//   - scripts/register-mcp.sh & scripts/merge-mcp.mjs (backup dedup, keep-5, mode preserve, unparseable guard)
// Everything runs inside temporary directories and ephemeral loopback ports;
// real HOME, real desktop entries, and port 4399 are never touched.
import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const tmp = mkdtempSync(path.join(os.tmpdir(), "bench-ops-test-"))
const children = new Set()
const extraPids = new Set()

const cleanup = () => {
  for (const child of children) {
    try {
      child.kill("SIGKILL")
    } catch {}
  }
  for (const pid of extraPids) {
    try {
      process.kill(pid, "SIGKILL")
    } catch {}
  }
  rmSync(tmp, { recursive: true, force: true })
}
process.on("exit", cleanup)

let passed = 0
function ok(what) {
  console.log(`ok  ${what}`)
  passed++
}

function makeFakeBin(dir, name, content) {
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, name)
  writeFileSync(file, content, "utf8")
  chmodSync(file, 0o755)
  return file
}

async function freePort() {
  const srv = net.createServer()
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve))
  const { port } = srv.address()
  await new Promise((resolve) => srv.close(resolve))
  return port
}

function isPidAlive(pid) {
  if (process.platform === "linux") {
    const statPath = `/proc/${pid}/stat`
    if (!existsSync(statPath)) return false
    try {
      const raw = readFileSync(statPath, "utf8")
      const end = raw.lastIndexOf(")")
      if (end !== -1 && raw.slice(end + 2).trim()[0] === "Z") return false
    } catch {
      return false
    }
  }
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitUntil(fn, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fn()) return true
    await new Promise((r) => setTimeout(r, 40))
  }
  return fn()
}

// ============================================================================
// 1. ensure-deps.mjs + start.sh / start-bench.sh dep failure & --background
// ============================================================================
{
  const proj = path.join(tmp, "deps-proj")
  const fakeBin = path.join(tmp, "deps-bin")
  const npmLog = path.join(tmp, "npm-calls.log")
  const failFlag = path.join(tmp, "npm-fail")
  const mutateLockFlag = path.join(tmp, "npm-mutate-lock")
  mkdirSync(proj, { recursive: true })
  writeFileSync(
    path.join(proj, "package.json"),
    JSON.stringify({ name: "t", version: "1.0.0", scripts: { dev: "next dev" }, dependencies: { a: "^1.0.0" } }, null, 2),
  )
  writeFileSync(path.join(proj, "package-lock.json"), '{"name":"t","lockfileVersion":3}\n')

  const fakeNpm = makeFakeBin(
    fakeBin,
    "npm",
    `#!/usr/bin/env bash
echo "npm $*" >> ${JSON.stringify(npmLog)}
if [[ -f ${JSON.stringify(failFlag)} ]]; then
  echo "simulated install failure" >&2
  exit 2
fi
mkdir -p node_modules
echo '{}' > node_modules/.package-lock.json
if [[ -f ${JSON.stringify(mutateLockFlag)} ]]; then
  echo '{"name":"t","lockfileVersion":3,"resolved":1}' > package-lock.json
fi
`,
  )

  const env = { ...process.env, BENCH_NPM_BIN: fakeNpm }
  const runEnsure = () =>
    spawnSync(process.execPath, [path.join(repoRoot, "scripts/ensure-deps.mjs"), "--root", proj], {
      cwd: proj,
      env,
      encoding: "utf8",
    })

  // Missing node_modules -> installs
  let r = runEnsure()
  assert.equal(r.status, 0, r.stderr)
  assert.equal(readFileSync(npmLog, "utf8").trim().split("\n").length, 1, "缺失 node_modules 应装一次")
  ok("ensure-deps：缺 node_modules 时自动安装")

  // Second run -> skips
  r = runEnsure()
  assert.equal(r.status, 0)
  assert.equal(readFileSync(npmLog, "utf8").trim().split("\n").length, 1, "依赖未变不应重装")
  ok("ensure-deps：未变化时不重复安装")

  // Modifying scripts/version AND bumping mtime -> still skips when stamp exists!
  writeFileSync(
    path.join(proj, "package.json"),
    JSON.stringify({ name: "t", version: "1.0.1", scripts: { dev: "next dev", stop: "node stop.mjs" }, dependencies: { a: "^1.0.0" } }, null, 2),
  )
  const future = new Date(Date.now() + 5000)
  utimesSync(path.join(proj, "package.json"), future, future)
  utimesSync(path.join(proj, "package-lock.json"), future, future)
  r = runEnsure()
  assert.equal(r.status, 0, r.stderr)
  assert.equal(readFileSync(npmLog, "utf8").trim().split("\n").length, 1, "只改 scripts 或时间戳时不应触发 npm install")
  ok("ensure-deps：只改 scripts 与时间戳时不误触发安装")

  // Changing dependencies where npm also mutates package-lock.json -> installs once, then post-install stamp skips next run
  writeFileSync(mutateLockFlag, "1")
  writeFileSync(
    path.join(proj, "package.json"),
    JSON.stringify({ name: "t", version: "1.0.1", scripts: { dev: "next dev" }, dependencies: { a: "^2.0.0" } }, null, 2),
  )
  r = runEnsure()
  assert.equal(r.status, 0, r.stderr)
  assert.equal(readFileSync(npmLog, "utf8").trim().split("\n").length, 2, "dependencies 变化应重装")
  rmSync(mutateLockFlag)
  r = runEnsure()
  assert.equal(r.status, 0, r.stderr)
  assert.equal(readFileSync(npmLog, "utf8").trim().split("\n").length, 2, "装完按装完的文件重算指纹，下次不得重复装")
  ok("ensure-deps：依赖变更重装并按装完后的文件写入 stamp")

  // Install failure -> refuses, does NOT overwrite stamp
  writeFileSync(
    path.join(proj, "package.json"),
    JSON.stringify({ name: "t", version: "2.0.0", dependencies: { a: "^2.0.0" }, overrides: { b: "1.0.0" } }, null, 2),
  )
  writeFileSync(failFlag, "1")
  r = runEnsure()
  assert.notEqual(r.status, 0, "安装失败必须非 0 退出")
  assert.match(r.stderr + r.stdout, /依赖安装失败/, "应输出清楚错误提示")
  rmSync(failFlag)
  // Recovery run -> sees failed previous install didn't update stamp, installs now
  r = runEnsure()
  assert.equal(r.status, 0)
  assert.equal(readFileSync(npmLog, "utf8").trim().split("\n").length, 4, "失败后下次启动仍应尝试补装")
  ok("ensure-deps：安装失败非 0 退出且不更新 stamp")

  // Verify start.sh refuses to boot `npx next` when ensure-deps fails
  const startTest = path.join(tmp, "start-sh-proj")
  mkdirSync(path.join(startTest, "scripts"), { recursive: true })
  cpSync(path.join(repoRoot, "start.sh"), path.join(startTest, "start.sh"))
  chmodSync(path.join(startTest, "start.sh"), 0o755)
  cpSync(path.join(repoRoot, "scripts/ensure-deps.mjs"), path.join(startTest, "scripts/ensure-deps.mjs"))
  cpSync(path.join(repoRoot, "scripts/check-node.mjs"), path.join(startTest, "scripts/check-node.mjs"))
  writeFileSync(path.join(startTest, "package.json"), '{"name":"t","version":"1.0.0"}\n')
  const startBin = path.join(tmp, "start-sh-bin")
  const npxLog = path.join(tmp, "npx-called.log")
  makeFakeBin(startBin, "npm", `#!/usr/bin/env bash\necho "npm fail" >&2\nexit 1\n`)
  makeFakeBin(startBin, "npx", `#!/usr/bin/env bash\necho "$*" > ${JSON.stringify(npxLog)}\n`)
  makeFakeBin(startBin, "curl", `#!/usr/bin/env bash\nexit 7\n`)
  const nodeDir = path.dirname(process.execPath)
  const sr = spawnSync("bash", [path.join(startTest, "start.sh")], {
    cwd: startTest,
    env: { PATH: `${startBin}:${nodeDir}:/bin:/usr/bin`, HOME: tmp },
    encoding: "utf8",
  })
  assert.notEqual(sr.status, 0, "start.sh 依赖失败应非 0 退出")
  assert.ok(!existsSync(npxLog), "start.sh 依赖失败后绝不能带着旧依赖启动 next")
  ok("start.sh：依赖安装失败时停止启动，不硬开 next")

  // Verify scripts/start-bench.sh refuses to spawn tmux when ensure-deps fails
  cpSync(path.join(repoRoot, "scripts/start-bench.sh"), path.join(startTest, "scripts/start-bench.sh"))
  chmodSync(path.join(startTest, "scripts/start-bench.sh"), 0o755)
  const tmuxCalled = path.join(tmp, "start-bench-tmux.log")
  makeFakeBin(startBin, "tmux", `#!/usr/bin/env bash\necho "$*" > ${JSON.stringify(tmuxCalled)}\n`)
  const sbr = spawnSync("bash", [path.join(startTest, "scripts/start-bench.sh")], {
    cwd: startTest,
    env: { PATH: `${startBin}:${nodeDir}:/bin:/usr/bin`, HOME: tmp },
    encoding: "utf8",
  })
  assert.notEqual(sbr.status, 0, "start-bench.sh 依赖失败应非 0 退出")
  assert.ok(!existsSync(tmuxCalled), "start-bench.sh 依赖失败后绝不能拉起 tmux 会话")
  ok("start-bench.sh：依赖安装失败时停止启动，不带旧依赖拉起 tmux")

  // Verify scripts/start-bench.sh --background starts/attaches without opening browser
  const openLog = path.join(tmp, "open-room.log")
  writeFileSync(
    path.join(startTest, "scripts/open-room.mjs"),
    `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(openLog)}, "opened\\n");\n`,
  )
  makeFakeBin(startBin, "curl", `#!/usr/bin/env bash\nexit 0\n`)
  const bgRes = spawnSync("bash", [path.join(startTest, "scripts/start-bench.sh"), "--background"], {
    cwd: startTest,
    env: { PATH: `${startBin}:${nodeDir}:/bin:/usr/bin`, HOME: tmp },
    encoding: "utf8",
  })
  assert.equal(bgRes.status, 0, bgRes.stderr)
  assert.ok(!existsSync(openLog), "start-bench.sh --background 不得弹出浏览器")
  const fgRes = spawnSync("bash", [path.join(startTest, "scripts/start-bench.sh")], {
    cwd: startTest,
    env: { PATH: `${startBin}:${nodeDir}:/bin:/usr/bin`, HOME: tmp },
    encoding: "utf8",
  })
  assert.equal(fgRes.status, 0, fgRes.stderr)
  assert.ok(existsSync(openLog), "正常图标启动应调 open-room.mjs 打开浏览器")
  ok("start-bench.sh：带 --background 不开浏览器，正常点击才开")
}

// ============================================================================
// 2. stop-bench.mjs
// ============================================================================
{
  const stopScript = path.join(repoRoot, "scripts/stop-bench.mjs")

  // Case A: nothing running on an allocated-then-freed ephemeral port
  const unusedPort = await freePort()
  const emptyRes = spawnSync(process.execPath, [stopScript], {
    env: { ...process.env, BENCH_URL: `http://127.0.0.1:${unusedPort}`, BENCH_TMUX_SESSION: "nonexistent-bench-test-sess" },
    encoding: "utf8",
  })
  assert.equal(emptyRes.status, 0, emptyRes.stderr)
  assert.match(emptyRes.stdout, /没有在运行/, "未运行时应友好提示")
  ok("stop-bench：未运行时退出 0 并提示（使用随机空闲端口）")

  // Helper to spawn an isolated server pretending to be bench (listening on port 0)
  const startStub = (modeFile, opts = {}) =>
    new Promise((resolve) => {
      const stubCode = `
        const http = require("node:http");
        const fs = require("node:fs");
        const { spawn } = require("node:child_process");
        const mode = () => fs.readFileSync(${JSON.stringify(modeFile)}, "utf8").trim();
        let info = "";
        if (${Boolean(opts.withChildren)}) {
          const cleanEnv = { ...process.env };
          delete cleanEnv.BENCH_RUN_KEY;
          const plain = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
            detached: true,
            stdio: "ignore",
            env: cleanEnv,
          });
          const ai = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
            detached: true,
            stdio: "ignore",
            env: { ...cleanEnv, BENCH_RUN_KEY: "test-ai-run-key" },
          });
          info = " PLAIN=" + plain.pid + " AI=" + ai.pid;
        }
        const server = http.createServer((req, res) => {
          const m = mode();
          if (m === "500") { res.statusCode = 500; res.end("err"); return; }
          res.setHeader("content-type", "application/json");
          if (req.url === "/api/v1/projects") {
            res.end(JSON.stringify({ projects: [{ id: "p_1", name: "测试项目" }] }));
          } else if (req.url.startsWith("/api/v1/room")) {
            const agents = m === "working"
              ? [{ id: "a_1", name: "小兰", status: "working", runId: "r_1", doing: "正在跑脚本", demo: false }]
              : [{ id: "a_1", name: "小兰", status: "idle", demo: false }];
            res.end(JSON.stringify({ agents }));
          } else {
            res.statusCode = 404; res.end("{}");
          }
        });
        server.listen(0, "127.0.0.1", () => {
          console.log("PORT=" + server.address().port + info);
        });
        setInterval(() => {}, 1000);
      `
      const child = spawn(process.execPath, ["-e", stubCode], { stdio: ["ignore", "pipe", "pipe"], detached: true })
      children.add(child)
      let buf = ""
      child.stdout.on("data", (d) => {
        buf += d.toString()
        const pm = buf.match(/PORT=(\d+)/)
        if (!pm) return
        if (opts.withChildren && (!buf.includes("PLAIN=") || !buf.includes("AI="))) return
        const plainPid = Number(buf.match(/PLAIN=(\d+)/)?.[1] ?? 0)
        const aiPid = Number(buf.match(/AI=(\d+)/)?.[1] ?? 0)
        if (plainPid) extraPids.add(plainPid)
        if (aiPid) extraPids.add(aiPid)
        resolve({ child, port: Number(pm[1]), plainPid, aiPid })
      })
    })

  // Shared mock tmux setup driven by panesFile + aliveTmuxFlag
  const tmuxLog = path.join(tmp, "tmux-stop.log")
  const stopBin = path.join(tmp, "stop-bin")
  const aliveTmuxFlag = path.join(tmp, "tmux-alive")
  const tmuxPanesFile = path.join(tmp, "tmux-panes.txt")
  const fakeTmux = makeFakeBin(
    stopBin,
    "tmux",
    `#!/usr/bin/env bash
echo "tmux $*" >> ${JSON.stringify(tmuxLog)}
if [[ "$1" == "-V" ]]; then exit 0; fi
if [[ "$1" == "has-session" ]]; then [[ -f ${JSON.stringify(aliveTmuxFlag)} ]]; exit $?; fi
if [[ "$1" == "list-panes" ]]; then [[ -f ${JSON.stringify(tmuxPanesFile)} ]] && cat ${JSON.stringify(tmuxPanesFile)}; exit 0; fi
if [[ "$1" == "kill-session" ]]; then rm -f ${JSON.stringify(aliveTmuxFlag)}; exit 0; fi
exit 0
`,
  )

  const modeFile = path.join(tmp, "stub-mode")
  writeFileSync(modeFile, "working")
  const stub1 = await startStub(modeFile)
  const stopEnv1 = { ...process.env, BENCH_URL: `http://127.0.0.1:${stub1.port}`, BENCH_TMUX_SESSION: "nonexistent-bench-test-sess" }

  // Busy AI without --force -> refused, process still alive
  const busyRefused = spawnSync(process.execPath, [stopScript], { env: stopEnv1, encoding: "utf8" })
  assert.notEqual(busyRefused.status, 0, "有 AI 在干活时没 --force 必须拦住")
  assert.match(busyRefused.stderr, /测试项目.*小兰.*正在跑脚本/, "应列出项目、席位和在做什么")
  assert.match(busyRefused.stderr, /--force/, "应提示加 --force")
  const ping1 = await fetch(`http://127.0.0.1:${stub1.port}/api/v1/projects`)
  assert.equal(ping1.status, 200, "被拦下后进程必须还在跑")
  ok("stop-bench：有 AI 干活时拦住并列出名字，不杀进程")

  // Different port + same-name tmux session alive (pane PID does not own target) -> NO send-keys / kill-session!
  writeFileSync(aliveTmuxFlag, "1")
  const unrelatedChild = spawn("sleep", ["60"], { stdio: "ignore", detached: true })
  children.add(unrelatedChild)
  writeFileSync(tmuxPanesFile, `${unrelatedChild.pid}\n`)
  writeFileSync(tmuxLog, "")
  // Subcase 1: free port on another port while mock-bench-dev exists
  const otherFreePort = await freePort()
  const otherFreeRes = spawnSync(process.execPath, [stopScript], {
    env: { ...process.env, BENCH_URL: `http://127.0.0.1:${otherFreePort}`, BENCH_TMUX_BIN: fakeTmux, BENCH_TMUX_SESSION: "mock-bench-dev" },
    encoding: "utf8",
  })
  assert.equal(otherFreeRes.status, 0, otherFreeRes.stderr)
  assert.equal(readFileSync(tmuxLog, "utf8").match(/send-keys|kill-session/), null, "别的空闲端口绝不能碰同名 tmux 会话")
  // Subcase 2: listening stub on another port NOT belonging to mock-bench-dev
  writeFileSync(modeFile, "idle")
  const stubOther = await startStub(modeFile)
  writeFileSync(tmuxLog, "")
  const otherStopRes = spawnSync(process.execPath, [stopScript], {
    env: { ...process.env, BENCH_URL: `http://127.0.0.1:${stubOther.port}`, BENCH_TMUX_BIN: fakeTmux, BENCH_TMUX_SESSION: "mock-bench-dev" },
    encoding: "utf8",
  })
  assert.equal(otherStopRes.status, 0, otherStopRes.stderr)
  const otherTmuxCalls = readFileSync(tmuxLog, "utf8")
  assert.equal(otherTmuxCalls.match(/send-keys|kill-session/), null, "端口监听进程不在同名 tmux 会话内时，不许出现 send-keys / kill-session")
  assert.ok(!otherStopRes.stdout.includes("mock-bench-dev"), "未操作 tmux 会话时不应声称停掉了该会话")
  assert.ok(existsSync(aliveTmuxFlag), "同名 tmux 会话必须仍存活")
  ok("stop-bench：目标在别的端口时即使同名 tmux 会话存在也绝不发 C-c 或杀会话")

  // Busy AI WITH --force where stub1 IS descended from mock-bench-dev pane PID (process.pid) -> stops process & tmux session
  writeFileSync(modeFile, "working")
  writeFileSync(tmuxPanesFile, `${process.pid}\n`)
  writeFileSync(tmuxLog, "")
  const busyForce = spawnSync(process.execPath, [stopScript, "--force"], {
    env: { ...stopEnv1, BENCH_TMUX_BIN: fakeTmux, BENCH_TMUX_SESSION: "mock-bench-dev" },
    encoding: "utf8",
  })
  assert.equal(busyForce.status, 0, busyForce.stderr)
  assert.match(busyForce.stdout, /已停止并坐/)
  const tmuxCalls = readFileSync(tmuxLog, "utf8")
  assert.match(tmuxCalls, /send-keys -t =mock-bench-dev C-c/, "确认监听进程属于该会话时应先发 Ctrl+C")
  assert.match(tmuxCalls, /kill-session -t =mock-bench-dev/, "会话未退时应清理 tmux 会话")
  let stillUp = true
  try {
    await fetch(`http://127.0.0.1:${stub1.port}/api/v1/projects`, { signal: AbortSignal.timeout(400) })
  } catch {
    stillUp = false
  }
  assert.equal(stillUp, false, "--force 后服务进程应已停掉")
  ok("stop-bench：确认属于该 tmux 会话且带 --force 时停掉服务并清理会话")

  // Detached normal child survives; detached BENCH_RUN_KEY AI child is stopped
  writeFileSync(modeFile, "idle")
  const stubKids = await startStub(modeFile, { withChildren: true })
  assert.ok(isPidAlive(stubKids.plainPid), "测试前提：普通 detached 子进程应在运行")
  assert.ok(isPidAlive(stubKids.aiPid), "测试前提：带 BENCH_RUN_KEY 子进程应在运行")
  const kidsStop = spawnSync(process.execPath, [stopScript], {
    env: { ...process.env, BENCH_URL: `http://127.0.0.1:${stubKids.port}`, BENCH_TMUX_SESSION: "nonexistent-bench-test-sess" },
    encoding: "utf8",
  })
  assert.equal(kidsStop.status, 0, kidsStop.stderr)
  const aiStopped = await waitUntil(() => !isPidAlive(stubKids.aiPid))
  assert.ok(aiStopped, "另开进程组且带 BENCH_RUN_KEY 的 AI 子进程必须被停掉")
  assert.ok(isPidAlive(stubKids.plainPid), "detached 的普通子进程（无 BENCH_RUN_KEY）必须继续活着且不成 defunct")
  try {
    process.kill(stubKids.plainPid, "SIGKILL")
  } catch {}
  ok("stop-bench：detached 普通子进程保活，带 BENCH_RUN_KEY 的 AI 子进程被停")

  // Same process-group guard: server + wrapper + stop share PGID -> stops server PID only, wrapper survives
  const samePgWrapper = `
    const http = require("node:http");
    const { spawn, spawnSync } = require("node:child_process");
    const srvCode = "const http=require('node:http');const s=http.createServer((q,r)=>{r.setHeader('content-type','application/json');if(q.url==='/api/v1/projects')r.end('{\\"projects\\":[{\\"id\\":\\"p_1\\",\\"name\\":\\"t\\"}]}');else r.end('{\\"agents\\":[]}');});s.listen(0,'127.0.0.1',()=>console.log('P='+s.address().port));setInterval(()=>{},1000);";
    const srv = spawn(process.execPath, ["-e", srvCode], { detached: false, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    srv.stdout.on("data", (d) => {
      out += d.toString();
      const m = out.match(/P=(\\d+)/);
      if (!m) return;
      const res = spawnSync(process.execPath, [${JSON.stringify(stopScript)}], {
        env: { ...process.env, BENCH_URL: "http://127.0.0.1:" + m[1], BENCH_TMUX_SESSION: "nonexistent-bench-test-sess" },
        encoding: "utf8",
      });
      console.log("WRAP_EXIT=" + res.status);
      process.exit(res.status || 0);
    });
  `
  const samePgRes = spawnSync(process.execPath, ["-e", samePgWrapper], { encoding: "utf8" })
  assert.equal(samePgRes.status, 0, samePgRes.stderr)
  assert.match(samePgRes.stdout, /WRAP_EXIT=0/, "与 stop 同组时只能按 PID 停监听进程，不能把同组调用者一起杀掉")
  ok("stop-bench：监听进程与 stop 同组时仅按 PID 停掉监听器，不误杀同组进程")

  // Unknown 500 -> refused without --force; Idle -> stopped without --force
  writeFileSync(modeFile, "500")
  const stub2 = await startStub(modeFile)
  const stopEnv2 = { ...process.env, BENCH_URL: `http://127.0.0.1:${stub2.port}`, BENCH_TMUX_SESSION: "nonexistent-bench-test-sess" }
  const unknownRefused = spawnSync(process.execPath, [stopScript], { env: stopEnv2, encoding: "utf8" })
  assert.notEqual(unknownRefused.status, 0, "问不到状态且无 --force 应拦住")
  assert.match(unknownRefused.stderr, /问不到房间当前状态/, "应照实说问不到状态")
  ok("stop-bench：问不到房间状态时照实说并拦住")

  writeFileSync(modeFile, "idle")
  const idleStopped = spawnSync(process.execPath, [stopScript], { env: stopEnv2, encoding: "utf8" })
  assert.equal(idleStopped.status, 0, idleStopped.stderr)
  assert.match(idleStopped.stdout, /已停止并坐/)
  ok("stop-bench：空闲时无需 --force 直接停止")
}

// ============================================================================
// 3. setup-bench.mjs (XDG isolation, never touches real desktop)
// ============================================================================
{
  const setupScript = path.join(repoRoot, "scripts/setup-bench.mjs")
  const startScript = path.join(repoRoot, "scripts/start-bench.sh")
  const fakeHome = path.join(tmp, "setup-home")
  const xdgData = path.join(fakeHome, "xdg-data")
  const xdgConfig = path.join(fakeHome, "xdg-config")
  const setupBin = path.join(tmp, "setup-bin")
  mkdirSync(fakeHome, { recursive: true })
  const fakeTmux = makeFakeBin(setupBin, "tmux", "#!/usr/bin/env bash\nexit 0\n")
  const noTmuxBin = path.join(tmp, "notmux-bin")
  mkdirSync(noTmuxBin, { recursive: true })

  // Missing tmux -> helpful message & non-zero
  const missingTmux = spawnSync(process.execPath, [setupScript, "--no-autostart"], {
    env: { PATH: noTmuxBin, HOME: fakeHome, XDG_DATA_HOME: xdgData, XDG_CONFIG_HOME: xdgConfig, BENCH_TMUX_BIN: "/nonexistent/tmux" },
    encoding: "utf8",
  })
  assert.notEqual(missingTmux.status, 0, "缺 tmux 应非 0 退出")
  assert.match(missingTmux.stderr, /缺少 tmux.*apt install tmux/s, "应说明缺 tmux 及安装命令")
  ok("setup-bench：缺少 tmux 时清楚提示怎么装")

  // --no-autostart -> desktop launcher only, correct repo path, NO --background
  const noAutoRes = spawnSync(process.execPath, [setupScript, "--no-autostart"], {
    env: { ...process.env, HOME: fakeHome, XDG_DATA_HOME: xdgData, XDG_CONFIG_HOME: xdgConfig, BENCH_TMUX_BIN: fakeTmux },
    encoding: "utf8",
  })
  assert.equal(noAutoRes.status, 0, noAutoRes.stderr)
  const appDesktop = path.join(xdgData, "applications/bench.desktop")
  const autoDesktop = path.join(xdgConfig, "autostart/bench.desktop")
  assert.ok(existsSync(appDesktop), "应生成 applications/bench.desktop")
  assert.ok(!existsSync(autoDesktop), "--no-autostart 不应生成自启文件")
  const desktopText = readFileSync(appDesktop, "utf8")
  assert.ok(desktopText.includes(`Exec=${startScript}\n`), "桌面图标 Exec 不带 --background")
  assert.ok(desktopText.includes(`Icon=${path.join(repoRoot, "public/bench.png")}`), "Icon 应指向当前仓库")
  ok("setup-bench：--no-autostart 按当前目录生成桌面图标且不设自启")

  // Interactive 'y\n' -> writes autostart WITH --background while app desktop keeps plain Exec
  const yesRes = spawnSync(process.execPath, [setupScript], {
    input: "y\n",
    env: { ...process.env, HOME: fakeHome, XDG_DATA_HOME: xdgData, XDG_CONFIG_HOME: xdgConfig, BENCH_TMUX_BIN: fakeTmux },
    encoding: "utf8",
  })
  assert.equal(yesRes.status, 0, yesRes.stderr)
  assert.ok(existsSync(autoDesktop), "输入 y 应生成 autostart/bench.desktop")
  const autoText = readFileSync(autoDesktop, "utf8")
  assert.ok(autoText.includes("X-GNOME-Autostart-enabled=true"))
  assert.ok(autoText.includes(`Exec=${startScript} --background\n`), "autostart Exec 必须带 --background")
  assert.ok(!readFileSync(appDesktop, "utf8").includes("--background"), "桌面图标 Exec 不应改动")
  ok("setup-bench：询问自启回答 y 时生成带 --background 的 autostart 文件")

  // --remove -> removes both
  const rmRes = spawnSync(process.execPath, [setupScript, "--remove"], {
    env: { ...process.env, HOME: fakeHome, XDG_DATA_HOME: xdgData, XDG_CONFIG_HOME: xdgConfig },
    encoding: "utf8",
  })
  assert.equal(rmRes.status, 0, rmRes.stderr)
  assert.ok(!existsSync(appDesktop) && !existsSync(autoDesktop), "--remove 应移除桌面图标和自启")
  ok("setup-bench：--remove 移除图标与开机自启")
}

// ============================================================================
// 4. update-bench.mjs (isolated bare remote + local clone + foreign cwd)
// ============================================================================
{
  const bare = path.join(tmp, "remote.git")
  const seed = path.join(tmp, "seed")
  const work = path.join(tmp, "work")
  const otherRepo = path.join(tmp, "other-repo")
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
  }
  const git = (cwd, args) => {
    const res = spawnSync("git", args, { cwd, env: gitEnv, encoding: "utf8" })
    assert.equal(res.status, 0, `git ${args.join(" ")} failed: ${res.stderr}`)
    return res.stdout.trim()
  }

  mkdirSync(bare, { recursive: true })
  git(bare, ["init", "--bare", "-b", "main"])
  mkdirSync(seed, { recursive: true })
  git(seed, ["init", "-b", "main"])
  mkdirSync(path.join(seed, "scripts"), { recursive: true })
  cpSync(path.join(repoRoot, "scripts/update-bench.mjs"), path.join(seed, "scripts/update-bench.mjs"))
  cpSync(path.join(repoRoot, "scripts/ensure-deps.mjs"), path.join(seed, "scripts/ensure-deps.mjs"))
  writeFileSync(path.join(seed, ".gitignore"), "node_modules/\n")
  writeFileSync(path.join(seed, "package.json"), '{"name":"up","version":"1.0.0","dependencies":{"x":"1.0.0"}}\n')
  writeFileSync(path.join(seed, "note.txt"), "v1\n")
  git(seed, ["add", "-A"])
  git(seed, ["commit", "-m", "init"])
  git(seed, ["remote", "add", "origin", bare])
  git(seed, ["push", "-u", "origin", "main"])

  git(tmp, ["clone", bare, work])
  mkdirSync(path.join(work, "node_modules"), { recursive: true })
  writeFileSync(path.join(work, "node_modules/.package-lock.json"), "{}\n")
  const ensureOk = spawnSync(process.execPath, [path.join(work, "scripts/ensure-deps.mjs"), "--root", work], { cwd: work, encoding: "utf8" })
  assert.equal(ensureOk.status, 0, ensureOk.stderr)

  // Push v2 modifying dependencies + note.txt
  writeFileSync(path.join(seed, "note.txt"), "v2\n")
  writeFileSync(path.join(seed, "package.json"), '{"name":"up","version":"1.1.0","dependencies":{"x":"2.0.0"}}\n')
  git(seed, ["add", "-A"])
  git(seed, ["commit", "-m", "v2"])
  git(seed, ["push"])

  // Dirty worktree -> refuses pull
  writeFileSync(path.join(work, "dirty.tmp"), "untracked")
  const dirtyUp = spawnSync(process.execPath, [path.join(work, "scripts/update-bench.mjs")], { cwd: work, encoding: "utf8" })
  assert.notEqual(dirtyUp.status, 0, "工作区不干净时禁止 update")
  assert.match(dirtyUp.stderr, /dirty\.tmp/)
  assert.equal(readFileSync(path.join(work, "note.txt"), "utf8"), "v1\n", "工作区不干净时绝不能拉代码")
  ok("update-bench：工作区不干净时停下并列出改动文件")

  // Clean worktree -> pulls v2, installs deps (using fake npm), prints restart notice
  rmSync(path.join(work, "dirty.tmp"))
  const upBin = path.join(tmp, "up-bin")
  const upNpmLog = path.join(tmp, "up-npm.log")
  const fakeNpm = makeFakeBin(
    upBin,
    "npm",
    `#!/usr/bin/env bash\necho "npm $*" >> ${JSON.stringify(upNpmLog)}\nmkdir -p node_modules\necho '{}' > node_modules/.package-lock.json\n`,
  )
  const cleanUp = spawnSync(process.execPath, [path.join(work, "scripts/update-bench.mjs")], {
    cwd: work,
    env: { ...process.env, BENCH_NPM_BIN: fakeNpm },
    encoding: "utf8",
  })
  assert.equal(cleanUp.status, 0, cleanUp.stderr)
  assert.equal(readFileSync(path.join(work, "note.txt"), "utf8"), "v2\n", "干净时应拉下远端最新代码")
  assert.ok(existsSync(upNpmLog), "远端更新 dependencies 后应自动装依赖")
  assert.match(cleanUp.stdout, /重启后生效/, "应明确提示重启后生效")
  assert.match(cleanUp.stdout, /npm run stop/, "应给出重启操作说明")
  ok("update-bench：工作区干净时拉取代码、重装依赖并提示重启生效")

  // Running `node <work>/scripts/update-bench.mjs` from another repo must update `work`, not `otherRepo`
  writeFileSync(path.join(seed, "note.txt"), "v3\n")
  git(seed, ["add", "-A"])
  git(seed, ["commit", "-m", "v3"])
  git(seed, ["push"])
  mkdirSync(otherRepo, { recursive: true })
  git(otherRepo, ["init", "-b", "main"])
  writeFileSync(path.join(otherRepo, "other.txt"), "keep\n")
  git(otherRepo, ["add", "-A"])
  git(otherRepo, ["commit", "-m", "other"])
  writeFileSync(path.join(otherRepo, "uncommitted.txt"), "dirty-other\n")
  const foreignUp = spawnSync(process.execPath, [path.join(work, "scripts/update-bench.mjs")], {
    cwd: otherRepo,
    env: { ...process.env, BENCH_NPM_BIN: fakeNpm },
    encoding: "utf8",
  })
  assert.equal(foreignUp.status, 0, foreignUp.stderr)
  assert.equal(readFileSync(path.join(work, "note.txt"), "utf8"), "v3\n", "在别的目录运行应按脚本所在仓库更新 work")
  assert.equal(readFileSync(path.join(otherRepo, "other.txt"), "utf8"), "keep\n")
  ok("update-bench：在别的仓库目录执行仍更新脚本所属仓库")
}

// ============================================================================
// 5. register-mcp.sh & merge-mcp.mjs (backup dedup, cap 5, permissions, unparseable)
// ============================================================================
{
  const regScript = path.join(repoRoot, "scripts/register-mcp.sh")
  const mergeScript = path.join(repoRoot, "scripts/merge-mcp.mjs")
  const regHome = path.join(tmp, "reg-home")
  const regBin = path.join(tmp, "reg-bin")
  mkdirSync(regHome, { recursive: true })

  // Mock CLIs (claude, codex, agy, gemini) writing into regHome configs
  makeFakeBin(
    regBin,
    "claude",
    `#!/usr/bin/env bash
if [[ "$1 $2" == "mcp remove" ]]; then exit 0; fi
if [[ "$1 $2" == "mcp add" ]]; then
  node -e '
    const fs=require("fs"), f=process.env.HOME+"/.claude.json";
    const c=fs.existsSync(f)?JSON.parse(fs.readFileSync(f,"utf8")):{};
    c.mcpServers={...(c.mcpServers||{}),bench:{command:process.argv[1]}};
    fs.writeFileSync(f, JSON.stringify(c,null,2));
  ' "$6"
fi
`,
  )
  makeFakeBin(
    regBin,
    "codex",
    `#!/usr/bin/env bash
cfg="\${CODEX_HOME:-$HOME/.codex}/config.toml"
mkdir -p "$(dirname "$cfg")"
if [[ "$1 $2" == "mcp remove" ]]; then exit 0; fi
if [[ "$1 $2" == "mcp add" ]]; then
  cat >> "$cfg" <<EOF

[mcp_servers.bench]
command = "$5"
EOF
fi
`,
  )
  makeFakeBin(
    regBin,
    "agy",
    `#!/usr/bin/env bash
if [[ "$1 $2" == "mcp add" ]]; then
  mkdir -p "$HOME/.gemini/antigravity"
  echo '{"mcpServers":{"bench":{"ok":true}}}' > "$HOME/.gemini/antigravity/mcp_config.json"
fi
`,
  )
  makeFakeBin(
    regBin,
    "gemini",
    `#!/usr/bin/env bash
if [[ "$1 $2" == "mcp remove" ]]; then exit 0; fi
if [[ "$1 $2" == "mcp add" ]]; then
  mkdir -p "$HOME/.gemini"
  echo '{"mcpServers":{"bench":{"ok":true}}}' > "$HOME/.gemini/settings.json"
fi
`,
  )

  const regEnv = {
    PATH: `${regBin}:${path.dirname(process.execPath)}:/bin:/usr/bin`,
    HOME: regHome,
    BENCH_URL: "http://127.0.0.1:4399",
  }

  mkdirSync(path.join(regHome, ".cursor"), { recursive: true })
  const cursorCfg = path.join(regHome, ".cursor/mcp.json")
  const origCursor = '{"mcpServers":{"keep":{"command":"x"}}}\n'
  writeFileSync(cursorCfg, origCursor)
  chmodSync(cursorCfg, 0o600)

  const claudeCfg = path.join(regHome, ".claude.json")
  const origClaude = '{"theme":"dark","mcpServers":{"keep":{"command":"y"}}}\n'
  writeFileSync(claudeCfg, origClaude)
  chmodSync(claudeCfg, 0o600)

  mkdirSync(path.join(regHome, ".codex"), { recursive: true })
  const codexCfg = path.join(regHome, ".codex/config.toml")
  const origCodex = 'model = "gpt-5"\n\n[projects."/tmp/a b"]\ntrust_level = "trusted"\n'
  writeFileSync(codexCfg, origCodex)

  mkdirSync(path.join(regHome, ".gemini/antigravity"), { recursive: true })
  const agyCfg = path.join(regHome, ".gemini/antigravity/mcp_config.json")
  const origAgy = '{"mcpServers":{"other":{}}}\n'
  writeFileSync(agyCfg, origAgy)

  mkdirSync(path.join(regHome, ".dsh/profiles/headless"), { recursive: true })
  const dshCfg = path.join(regHome, ".dsh/profiles/headless/cordis.patch.yml")
  const origDsh = "- insert:\n    - id: other\n"
  writeFileSync(dshCfg, origDsh)

  mkdirSync(path.join(regHome, ".kimi-code"), { recursive: true })
  const kimiCfg = path.join(regHome, ".kimi-code/mcp.json")
  const origKimi = '{"mcpServers":{"existing":{}}}\n'
  writeFileSync(kimiCfg, origKimi)

  const geminiCfg = path.join(regHome, ".gemini/settings.json")
  const origGemini = '{"selectedAuthType":"oauth"}\n'
  writeFileSync(geminiCfg, origGemini)

  const pairs = [
    ["cursor", cursorCfg, origCursor],
    ["claude", claudeCfg, origClaude],
    ["codex", codexCfg, origCodex],
    ["antigravity", agyCfg, origAgy],
    ["dsh", dshCfg, origDsh],
    ["kimi", kimiCfg, origKimi],
    ["gemini", geminiCfg, origGemini],
  ]

  for (const [kind, cfgPath, origContent] of pairs) {
    const res = spawnSync("bash", [regScript, kind, "--force"], { env: regEnv, encoding: "utf8" })
    assert.equal(res.status, 0, `${kind} 注册失败: ${res.stderr}\n${res.stdout}`)
    const dir = path.dirname(cfgPath)
    const base = path.basename(cfgPath)
    const baks = readdirSync(dir).filter((f) => f.startsWith(`${base}.bak-bench-`))
    assert.ok(baks.length >= 1, `${kind} 改前必须留下带时间戳的备份文件`)
    assert.equal(readFileSync(path.join(dir, baks[0]), "utf8"), origContent, `${kind} 备份内容必须与原文件一字不差`)
  }
  assert.ok(JSON.parse(readFileSync(cursorCfg, "utf8")).mcpServers.keep, "cursor 保留了原有的 mcpServers.keep")
  assert.ok(readFileSync(codexCfg, "utf8").includes("tool_timeout_sec = 600"), "codex 写入了 tool_timeout_sec")
  const cursorBak = readdirSync(path.dirname(cursorCfg)).find((f) => f.startsWith("mcp.json.bak-bench-"))
  assert.equal(statSync(path.join(path.dirname(cursorCfg), cursorBak)).mode & 0o777, 0o600, "merge-mcp 备份必须保留原文件 0600 权限")
  ok("register-mcp：7 家代表客户端均在改前生成精确备份且保留原权限与配置")

  // Backup deduplication & max-5 retention on repeated updates (claude + merge-mcp)
  const regRepeat2 = spawnSync("bash", [regScript, "claude", "--force"], { env: regEnv, encoding: "utf8" })
  assert.equal(regRepeat2.status, 0, regRepeat2.stderr)
  const regRepeat3 = spawnSync("bash", [regScript, "claude", "--force"], { env: regEnv, encoding: "utf8" })
  assert.equal(regRepeat3.status, 0, regRepeat3.stderr)
  const claudeBaksAfterRepeat = readdirSync(regHome).filter((f) => f.startsWith(".claude.json.bak-bench-"))
  assert.equal(claudeBaksAfterRepeat.length, 2, "与最新备份内容相同时不得再新增备份")

  const rotDir = path.join(tmp, "rotate-bak")
  mkdirSync(rotDir, { recursive: true })
  const rotFile = path.join(rotDir, "cfg.json")
  for (let i = 1; i <= 7; i++) {
    writeFileSync(rotFile, JSON.stringify({ v: i }))
    chmodSync(rotFile, 0o600)
    const br = spawnSync(process.execPath, [mergeScript, "--backup", rotFile], { encoding: "utf8" })
    assert.equal(br.status, 0, br.stderr)
    // Repeating backup with identical content must not add or evict
    const dupBr = spawnSync(process.execPath, [mergeScript, "--backup", rotFile], { encoding: "utf8" })
    assert.equal(dupBr.status, 0, dupBr.stderr)
  }
  const rotBaks = readdirSync(rotDir).filter((f) => f.startsWith("cfg.json.bak-bench-")).sort()
  assert.equal(rotBaks.length, 5, "每个文件最多只留最新 5 份备份")
  const keptVersions = rotBaks.map((f) => JSON.parse(readFileSync(path.join(rotDir, f), "utf8")).v).sort((a, b) => a - b)
  assert.deepEqual(keptVersions, [3, 4, 5, 6, 7], "留下的应是最新的 5 份内容")
  for (const f of rotBaks) {
    assert.equal(statSync(path.join(rotDir, f)).mode & 0o777, 0o600, "每份轮转备份都应保持原文件 0600 权限")
  }
  ok("register-mcp / merge-mcp：内容与最新备份一致不重备，每文件只留最新 5 份且保留权限")

  // Now test broken/unparseable configs are NEVER overwritten!
  const badHome = path.join(tmp, "bad-home")
  mkdirSync(badHome, { recursive: true })
  const badEnv = { ...regEnv, HOME: badHome }

  mkdirSync(path.join(badHome, ".cursor"), { recursive: true })
  const badCursor = path.join(badHome, ".cursor/mcp.json")
  const badCursorText = "// user comment\n{ not valid json"
  writeFileSync(badCursor, badCursorText)
  const badCursorRes = spawnSync("bash", [regScript, "cursor", "--force"], { env: badEnv, encoding: "utf8" })
  assert.notEqual(badCursorRes.status, 0, "cursor 遇带注释坏 JSON 必须停下")
  assert.equal(readFileSync(badCursor, "utf8"), badCursorText, "cursor 坏文件绝不能被覆盖")

  const badClaude = path.join(badHome, ".claude.json")
  const badClaudeText = "{ broken json"
  writeFileSync(badClaude, badClaudeText)
  const badClaudeRes = spawnSync("bash", [regScript, "claude", "--force"], { env: badEnv, encoding: "utf8" })
  assert.notEqual(badClaudeRes.status, 0, "claude 遇坏 JSON 必须停下")
  assert.equal(readFileSync(badClaude, "utf8"), badClaudeText, "claude 坏文件绝不能被覆盖")

  mkdirSync(path.join(badHome, ".codex"), { recursive: true })
  const badCodex = path.join(badHome, ".codex/config.toml")
  const badCodexText = '[broken\nmodel = "unclosed\n'
  writeFileSync(badCodex, badCodexText)
  const badCodexRes = spawnSync("bash", [regScript, "codex", "--force"], { env: badEnv, encoding: "utf8" })
  assert.notEqual(badCodexRes.status, 0, "codex 遇读不懂的 TOML 必须停下")
  assert.equal(readFileSync(badCodex, "utf8"), badCodexText, "codex 坏文件绝不能被覆盖")

  mkdirSync(path.join(badHome, ".dsh/profiles/web"), { recursive: true })
  const badDsh = path.join(badHome, ".dsh/profiles/web/cordis.patch.yml")
  const badDshText = "notAList: { a: 1 }\n"
  writeFileSync(badDsh, badDshText)
  const badDshRes = spawnSync("bash", [regScript, "dsh", "--force"], { env: badEnv, encoding: "utf8" })
  assert.notEqual(badDshRes.status, 0, "dsh 遇非列表 YAML 必须停下")
  assert.equal(readFileSync(badDsh, "utf8"), badDshText, "dsh 非列表配置绝不能被破坏")

  // Extra CLI + merge-mcp coverage: qodercli, opencode, array JSON rejection
  makeFakeBin(
    regBin,
    "qodercli",
    `#!/usr/bin/env bash
if [[ "$1" == "mcp" && "$2" == "add" ]]; then
  echo '{"mcpServers":{"bench":{"ok":true}}}' > "$HOME/.qoder/settings.json"
fi
`,
  )
  mkdirSync(path.join(regHome, ".qoder"), { recursive: true })
  const qoderCfg = path.join(regHome, ".qoder/settings.json")
  const origQoder = '{"custom":"yes"}\n'
  writeFileSync(qoderCfg, origQoder)
  const qoderRes = spawnSync("bash", [regScript, "qoder", "--force"], { env: regEnv, encoding: "utf8" })
  assert.equal(qoderRes.status, 0, qoderRes.stderr)
  assert.ok(readdirSync(path.join(regHome, ".qoder")).some((f) => f.startsWith("settings.json.bak-bench-")), "qodercli 分支改前必须备份")

  mkdirSync(path.join(regHome, ".config/opencode"), { recursive: true })
  const ocCfg = path.join(regHome, ".config/opencode/opencode.json")
  writeFileSync(ocCfg, '{"model":"x"}\n')
  const ocRes = spawnSync("bash", [regScript, "opencode", "--force"], { env: regEnv, encoding: "utf8" })
  assert.equal(ocRes.status, 0, ocRes.stderr)
  assert.ok(readdirSync(path.join(regHome, ".config/opencode")).some((f) => f.startsWith("opencode.json.bak-bench-")), "opencode 改前必须备份")

  mkdirSync(path.join(badHome, ".kimi-code"), { recursive: true })
  const badArrKimi = path.join(badHome, ".kimi-code/mcp.json")
  writeFileSync(badArrKimi, "[1, 2, 3]\n")
  const badArrRes = spawnSync("bash", [regScript, "kimi", "--force"], { env: badEnv, encoding: "utf8" })
  assert.notEqual(badArrRes.status, 0, "顶层非对象的 JSON 数组必须停下")
  assert.equal(readFileSync(badArrKimi, "utf8"), "[1, 2, 3]\n", "数组 JSON 不得被覆盖")

  ok("register-mcp：cursor/claude/codex/dsh/kimi 等读不懂原配置时一律停下不覆盖")
}

console.log(`ops ok (${passed} checks)`)
