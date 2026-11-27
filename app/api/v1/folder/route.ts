import { execFile, type ChildProcess } from "node:child_process"
import { existsSync, readdirSync, statSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import { installed } from "@/lib/adapters"
import { boot } from "@/lib/boot"
import { ApiError, asRecord, asString, handle, json, readBody } from "@/lib/http"

// 「浏览…」 in the project dialog, spawn dialog, and composer's paperclip:
// the room opens the desktop's own picker (zenity on Unix, WinForms on Windows)
// and hands back the full paths chosen. When the server has no reachable
// interactive desktop (e.g. an isolated Win32 desktop like exebox-*, headless,
// or missing zenity), it returns 501 with `fallback: true` so the page opens
// its in-page directory browser instead of hanging invisibly until timeout.
//
// pick: "dir" (default) answers { dir }, "dirs" or "files" answer { paths }.
// action: "list" lists a directory on disk for the in-page fallback browser.

const PICK_LIMIT_MS = 10 * 60_000
const LIST_LIMIT = 500

type DesktopCheck = { ok: true } | { ok: false; reason: string }
type ActivePick = { child: ChildProcess | null; settled: boolean }

const state = globalThis as typeof globalThis & {
  __benchFolderPick?: ActivePick | null
  __benchWinDesktop?: DesktopCheck
  __benchWinDesktopPromise?: Promise<DesktopCheck>
}

// The room may run with a stripped environment (start scripts use env -i);
// the picker still needs the desktop session.
function desktopEnv() {
  const uid = os.userInfo().uid
  const xauth = path.join(os.homedir(), ".Xauthority")
  return {
    ...process.env,
    DISPLAY: process.env.DISPLAY || ":0",
    ...(process.env.XAUTHORITY || !existsSync(xauth) ? {} : { XAUTHORITY: xauth }),
    DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS || `unix:path=/run/user/${uid}/bus`,
  }
}

const WINDOWS_DESKTOP_CHECK = `
$ProgressPreference = 'SilentlyContinue'
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class BenchDesk {
  [DllImport("user32.dll")] public static extern IntPtr GetProcessWindowStation();
  [DllImport("user32.dll")] public static extern IntPtr GetThreadDesktop(uint tid);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern bool GetUserObjectInformation(IntPtr hObj, int nIndex, StringBuilder pvInfo, int nLength, out int needed);
  public static string NameOf(IntPtr h) {
    if (h == IntPtr.Zero) return "";
    var sb = new StringBuilder(256);
    int n = 0;
    return GetUserObjectInformation(h, 2, sb, sb.Capacity, out n) ? sb.ToString() : "";
  }
  public static string Info() {
    return string.Format("{0}|{1}|{2}", Environment.UserInteractive ? "1" : "0", NameOf(GetProcessWindowStation()), NameOf(GetThreadDesktop(GetCurrentThreadId())));
  }
}
"@
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Write-Output ([BenchDesk]::Info())
`

// Windows: a folder or file dialog from PowerShell. The start folder and the
// kind come in by environment, so nothing the user typed is part of the script.
// A folder dialog takes one folder, so "dirs" asks for one.
const WINDOWS_PICKER = `
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$title = switch ($env:BENCH_PICK) {
  'files' { '选要发的文件' }
  'dirs' { '选要发的文件夹' }
  default { '选项目目录' }
}
$owner = New-Object System.Windows.Forms.Form -Property @{
  TopMost = $true
  ShowInTaskbar = $true
  Text = $title
  StartPosition = 'CenterScreen'
  Size = New-Object System.Drawing.Size(1, 1)
  Opacity = 0
}
$owner.Show()
$owner.Activate()
[System.Windows.Forms.Application]::DoEvents()
try {
  if ($env:BENCH_PICK -eq 'files') {
    $d = New-Object System.Windows.Forms.OpenFileDialog
    $d.Multiselect = $true
    $d.Title = $title
    $d.InitialDirectory = $env:BENCH_START
    if ($d.ShowDialog($owner) -eq 'OK') { $d.FileNames | ForEach-Object { Write-Output $_ } }
  } else {
    $d = New-Object System.Windows.Forms.FolderBrowserDialog
    $d.Description = $title
    $d.SelectedPath = $env:BENCH_START
    $d.ShowNewFolderButton = $true
    if ($d.ShowDialog($owner) -eq 'OK') { Write-Output $d.SelectedPath }
  }
} finally {
  if ($d) { $d.Dispose() }
  $owner.Close()
  $owner.Dispose()
}
`

function expandHome(raw: string) {
  const expanded = raw.replace(/^~(?=[\\/]|$)/, os.homedir())
  // "D:" without trailing slash is drive-relative in Node on Windows; treat it as root "D:\".
  if (process.platform === "win32" && /^[A-Za-z]:$/.test(expanded)) return `${expanded}\\`
  return expanded
}

function isDir(dir: string) {
  return Boolean(statSync(dir, { throwIfNoEntry: false })?.isDirectory())
}

function startDir(raw: string | undefined) {
  const expanded = raw ? expandHome(raw) : ""
  if (expanded && path.isAbsolute(expanded)) {
    const resolved = path.resolve(expanded)
    if (isDir(resolved)) return resolved
    const parent = path.dirname(resolved)
    if (isDir(parent)) return parent
  }
  return os.homedir()
}

function killChild(child: ChildProcess | null) {
  if (!child || child.exitCode !== null || child.killed) return
  if (process.platform === "win32" && child.pid) {
    execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }, () => {})
    return
  }
  try {
    child.kill("SIGTERM")
  } catch {}
}

async function checkWinDesktop(): Promise<DesktopCheck> {
  if (state.__benchWinDesktop) return state.__benchWinDesktop
  if (state.__benchWinDesktopPromise) return state.__benchWinDesktopPromise
  const promise = new Promise<DesktopCheck>((resolve) => {
    const encoded = Buffer.from(WINDOWS_DESKTOP_CHECK, "utf16le").toString("base64")
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
      { timeout: 10_000, windowsHide: true },
      (error, stdout) => {
        if (error) {
          resolve({ ok: false, reason: "当前环境无法检查桌面窗口，已改用页内目录浏览" })
          return
        }
        const [interactive = "", winSta = "", desktop = ""] = stdout.replace(/\r/g, "").trim().split("|")
        if (interactive === "1" && winSta.toLowerCase() === "winsta0" && desktop.toLowerCase() === "default") {
          const ok: DesktopCheck = { ok: true }
          state.__benchWinDesktop = ok
          resolve(ok)
          return
        }
        const where = desktop ? `${winSta || "?"}\\${desktop}` : "非交互式会话"
        const bad: DesktopCheck = {
          ok: false,
          reason: `当前服务运行在隔离桌面（${where}），系统选目录窗口无法显示到你的屏幕，已改用页内目录浏览`,
        }
        state.__benchWinDesktop = bad
        resolve(bad)
      },
    )
  }).finally(() => {
    state.__benchWinDesktopPromise = undefined
  })
  state.__benchWinDesktopPromise = promise
  return promise
}

async function desktopPickerAvailable(): Promise<DesktopCheck> {
  if (process.platform === "win32") return checkWinDesktop()
  if (!installed("zenity")) {
    return { ok: false, reason: "没找到 zenity（sudo apt install zenity），已改用页内目录浏览" }
  }
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY && !existsSync("/tmp/.X11-unix/X0")) {
    return { ok: false, reason: "当前环境没有桌面显示服务，已改用页内目录浏览" }
  }
  return { ok: true }
}

function listDrives() {
  if (process.platform !== "win32") return ["/"]
  const drives: string[] = []
  for (let code = 67; code <= 90; code++) {
    const root = `${String.fromCharCode(code)}:\\`
    if (isDir(root)) drives.push(root)
  }
  return drives
}

function listDirectory(body: Record<string, unknown>) {
  const includeFiles = body.includeFiles === true
  const query = (asString(body.query) ?? "").toLowerCase()
  const raw = asString(body.path)
  let target: string
  if (raw) {
    const expanded = expandHome(raw)
    if (!path.isAbsolute(expanded)) throw new ApiError(400, "请填写完整路径")
    target = path.resolve(expanded)
    const st = statSync(target, { throwIfNoEntry: false })
    if (!st) throw new ApiError(404, "目录不存在")
    if (!st.isDirectory()) throw new ApiError(400, "这不是一个目录")
  } else {
    target = startDir(asString(body.start))
  }

  let rawEntries
  try {
    rawEntries = readdirSync(target, { withFileTypes: true })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code
    if (code === "EACCES" || code === "EPERM") throw new ApiError(403, "没有权限打开这个目录")
    throw new ApiError(500, "读取目录失败")
  }

  type Entry = { name: string; path: string; kind: "dir" | "file"; size?: number }
  const items: Entry[] = []
  for (const entry of rawEntries) {
    const full = path.join(target, entry.name)
    let isDirectory = entry.isDirectory()
    let isFile = entry.isFile()
    let size: number | undefined
    if (entry.isSymbolicLink() || (!isDirectory && !isFile)) {
      const st = statSync(full, { throwIfNoEntry: false })
      if (!st) continue
      isDirectory = st.isDirectory()
      isFile = st.isFile()
      if (isFile) size = st.size
    } else if (isFile && includeFiles) {
      size = statSync(full, { throwIfNoEntry: false })?.size
    }
    if (!isDirectory && (!includeFiles || !isFile)) continue
    if (query && !entry.name.toLowerCase().includes(query)) continue
    items.push({
      name: entry.name,
      path: full,
      kind: isDirectory ? "dir" : "file",
      ...(size !== undefined ? { size } : {}),
    })
  }

  items.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1
    const aHidden = a.name.startsWith(".") || a.name.startsWith("$")
    const bHidden = b.name.startsWith(".") || b.name.startsWith("$")
    if (aHidden !== bHidden) return aHidden ? 1 : -1
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
  })

  const parentRaw = path.dirname(target)
  const parent = parentRaw !== target ? parentRaw : null
  const home = os.homedir()
  const cwd = process.cwd()
  const shortcuts = [
    { label: "主目录", path: home },
    ...(path.resolve(cwd) !== path.resolve(home) ? [{ label: "当前项目", path: cwd }] : []),
  ]

  return {
    dir: target,
    parent,
    drives: listDrives(),
    shortcuts,
    entries: items.slice(0, LIST_LIMIT),
    truncated: items.length > LIST_LIMIT,
  }
}

export async function POST(request: Request) {
  try {
    await boot()
    const body = asRecord(await readBody(request))
    if (body.as !== "human") throw new ApiError(400, "只有这台电脑上的人能选目录")

    if (body.action === "list") {
      return json(listDirectory(body))
    }

    const desktop = await desktopPickerAvailable()
    if (!desktop.ok) {
      return json({ error: desktop.reason, fallback: true }, 501)
    }

    const existing = state.__benchFolderPick
    if (existing && !existing.settled && existing.child && existing.child.exitCode === null && !existing.child.killed) {
      throw new ApiError(409, "选目录的窗口已经开着了，看看任务栏")
    }

    const from = startDir(asString(body.start))
    const pick = body.pick === "files" || body.pick === "dirs" ? body.pick : "dir"
    if (request.signal.aborted) {
      return json(pick === "dir" ? { dir: null } : { paths: [] })
    }

    const windows = process.platform === "win32"
    const args = {
      dir: ["--directory", "--title=选项目目录"],
      dirs: ["--directory", "--multiple", "--separator=\n", "--title=选要发的文件夹"],
      files: ["--multiple", "--separator=\n", "--title=选要发的文件"],
    }[pick]

    const chosen = await new Promise<string | null>((resolve, reject) => {
      const [program, programArgs, env] = windows
        ? ([
            "powershell.exe",
            ["-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand", Buffer.from(WINDOWS_PICKER, "utf16le").toString("base64")],
            { ...process.env, BENCH_START: from, BENCH_PICK: pick },
          ] as const)
        : (["zenity", ["--file-selection", ...args, `--filename=${from.replace(/\/?$/, "/")}`], desktopEnv()] as const)

      const entry: ActivePick = { child: null, settled: false }
      const onAbort = () => {
        if (entry.settled) return
        entry.settled = true
        if (state.__benchFolderPick === entry) state.__benchFolderPick = null
        killChild(entry.child)
        resolve(null)
      }

      entry.child = execFile(
        program,
        [...programArgs],
        { env, timeout: PICK_LIMIT_MS, windowsHide: true },
        (error, stdout) => {
          request.signal.removeEventListener("abort", onAbort)
          if (entry.settled) return
          entry.settled = true
          if (state.__benchFolderPick === entry) state.__benchFolderPick = null
          // Zenity exits 1 when the user presses Cancel or closes the dialog.
          if (!windows && error && (error as { code?: number }).code === 1) return resolve(null)
          if (error) {
            if ((error as { killed?: boolean }).killed) {
              return reject(new ApiError(500, "选目录超时了，请重试或直接填路径"))
            }
            return reject(new ApiError(500, `选目录的窗口没打开：${error.message.split("\n")[0]}`))
          }
          resolve(stdout.replace(/\r/g, "").trim() || null)
        },
      )

      state.__benchFolderPick = entry
      request.signal.addEventListener("abort", onAbort, { once: true })
    })

    if (pick === "dir") return json({ dir: chosen })
    return json({ paths: chosen ? chosen.split("\n").filter(Boolean) : [] })
  } catch (error) {
    return handle(error)
  }
}
