import { execFile, spawn } from "node:child_process"
import { existsSync, statSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import { installed, summonPath } from "@/lib/adapters"
import { ApiError } from "@/lib/http"
import { agentState, currentProjectInfo } from "@/lib/store"

// Opening what a message points at (components/room/markdown.tsx): a file in
// the editor at its line, a commit's contents. Paths a seat writes are
// relative to its own folder, so that is tried first, then the project's.

function baseDirs(from: string | undefined) {
  const dirs: string[] = []
  const seat = from ? agentState(from)?.workdir : undefined
  if (seat) dirs.push(seat)
  const project = currentProjectInfo().dir
  if (project && !dirs.includes(project)) dirs.push(project)
  return dirs
}

export function resolveFile(given: string, from?: string) {
  const raw = given.trim().replace(/^~(?=\/|$)/, os.homedir())
  if (!raw || raw.includes("\0")) throw new ApiError(400, "路径是空的")
  const candidates = path.isAbsolute(raw) ? [raw] : baseDirs(from).map((dir) => path.resolve(dir, raw))
  const found = candidates.find((file) => existsSync(file))
  if (!found) {
    throw new ApiError(404, path.isAbsolute(raw) ? `这台电脑上没有 ${raw}` : `在席位和项目的文件夹里都没找到 ${raw}`)
  }
  return found
}

// The room runs from a terminal or a start script; the editor still needs the
// desktop session to show its window.
function desktopEnv(): NodeJS.ProcessEnv {
  const uid = os.userInfo().uid
  const xauth = path.join(os.homedir(), ".Xauthority")
  return {
    ...process.env,
    PATH: summonPath(),
    DISPLAY: process.env.DISPLAY || ":0",
    ...(process.env.XAUTHORITY || !existsSync(xauth) ? {} : { XAUTHORITY: xauth }),
    DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS || `unix:path=/run/user/${uid}/bus`,
  }
}

// Which editor: BENCH_EDITOR if set, else VS Code, else Cursor, else the
// desktop's default app for the file. VS Code-like ones jump to the line.
function editor(): { command: string; jumps: boolean; name: string } {
  const chosen = process.env.BENCH_EDITOR?.trim()
  if (chosen) return { command: chosen, jumps: /(^|\/)(code|cursor|codium|windsurf|code-insiders)(\.exe|\.cmd)?$/i.test(chosen) || process.env.BENCH_EDITOR_JUMPS === "1", name: path.basename(chosen) }
  if (installed("code")) return { command: "code", jumps: true, name: "VS Code" }
  if (installed("cursor")) return { command: "cursor", jumps: true, name: "Cursor" }
  if (process.platform === "darwin") return { command: "open", jumps: false, name: "默认程序" }
  if (process.platform === "win32") return { command: "explorer", jumps: false, name: "默认程序" }
  return { command: "xdg-open", jumps: false, name: "默认程序" }
}

export async function openFile(given: string, line: number | undefined, from?: string) {
  const file = resolveFile(given, from)
  const isDir = statSync(file).isDirectory()
  const tool = editor()
  const where = tool.jumps && line && !isDir ? `${file}:${line}` : file
  const args = tool.jumps && !isDir && line ? ["-g", where] : [file]
  await new Promise<void>((resolve, reject) => {
    const child = spawn(tool.command, args, { detached: true, stdio: "ignore", env: desktopEnv() })
    child.once("error", (error) => reject(new ApiError(500, `打不开编辑器（${tool.command}）：${error.message}`)))
    // It either fails to start right away or it's off on its own.
    setTimeout(() => {
      child.unref()
      resolve()
    }, 300)
  })
  return { file, line: tool.jumps && !isDir ? (line ?? null) : null, editor: tool.name }
}

function git(dir: string, args: string[], maxBuffer = 8 * 1024 * 1024) {
  return new Promise<string>((resolve, reject) =>
    execFile("git", ["-C", dir, ...args], { timeout: 15_000, maxBuffer, env: { ...process.env, PATH: summonPath(), GIT_PAGER: "cat" } }, (error, stdout) =>
      error ? reject(error) : resolve(stdout),
    ),
  )
}

const PATCH_LIMIT = 150_000

export async function showCommit(hash: string, from?: string) {
  if (!/^[0-9a-f]{7,40}$/i.test(hash)) throw new ApiError(400, "不是提交号")
  for (const dir of baseDirs(from)) {
    if (!existsSync(dir)) continue
    try {
      await git(dir, ["rev-parse", "--verify", "--quiet", `${hash}^{commit}`])
    } catch {
      continue
    }
    const head = await git(dir, ["show", "-s", "--no-color", "--format=%H%x00%an%x00%aI%x00%s%x00%b", hash])
    const [full, author, date, subject, body] = head.split("\0")
    const stat = await git(dir, ["show", "--no-color", "--stat=120", "--format=", hash])
    let patch = await git(dir, ["show", "--no-color", "--format=", hash], 32 * 1024 * 1024)
    const truncated = patch.length > PATCH_LIMIT
    if (truncated) patch = patch.slice(0, PATCH_LIMIT)
    return { hash: full.trim(), author, date, subject, body: body.trim(), dir, stat: stat.trim(), patch, truncated }
  }
  throw new ApiError(404, `在席位和项目的仓库里都没找到提交 ${hash}`)
}
