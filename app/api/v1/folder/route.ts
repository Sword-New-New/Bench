import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import { boot } from "@/lib/boot"
import { ApiError, asRecord, asString, handle, json, readBody } from "@/lib/http"
import { installed } from "@/lib/adapters"

// 「浏览…」 in the project dialog and the composer's paperclip: the room opens
// the desktop's own picker (zenity) and hands back the full paths chosen. A
// page can't do this itself; browsers never give out a file's full path.
// pick: "dir" (default) answers { dir }, "dirs" or "files" answer { paths }.
// Windows: the same through PowerShell's own dialogs (WinForms).

const PICK_LIMIT_MS = 10 * 60_000

let picking = false

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

// Windows: a folder or file dialog from PowerShell. The start folder and the
// kind come in by environment, so nothing the user typed is part of the script.
// A folder dialog takes one folder, so "dirs" asks for one.
const WINDOWS_PICKER = `
Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true }
if ($env:BENCH_PICK -eq 'files') {
  $d = New-Object System.Windows.Forms.OpenFileDialog
  $d.Multiselect = $true
  $d.Title = '选要发的文件'
  $d.InitialDirectory = $env:BENCH_START
  if ($d.ShowDialog($owner) -eq 'OK') { $d.FileNames | ForEach-Object { Write-Output $_ } }
} else {
  $d = New-Object System.Windows.Forms.FolderBrowserDialog
  $d.Description = if ($env:BENCH_PICK -eq 'dirs') { '选要发的文件夹' } else { '选项目目录' }
  $d.SelectedPath = $env:BENCH_START
  $d.ShowNewFolderButton = $true
  if ($d.ShowDialog($owner) -eq 'OK') { Write-Output $d.SelectedPath }
}
`

export async function POST(request: Request) {
  try {
    await boot()
    const body = asRecord(await readBody(request))
    if (body.as !== "human") throw new ApiError(400, "只有这台电脑上的人能选目录")
    const windows = process.platform === "win32"
    if (!windows && !installed("zenity")) throw new ApiError(501, "没找到选目录的窗口：装一下 zenity（sudo apt install zenity），或者直接填路径")
    if (picking) throw new ApiError(409, "选目录的窗口已经开着了，看看任务栏")
    const start = (asString(body.start) ?? "").replace(/^~(?=[\\/]|$)/, os.homedir())
    const from = start && path.isAbsolute(start) && existsSync(start) ? start : os.homedir()
    const pick = body.pick === "files" || body.pick === "dirs" ? body.pick : "dir"
    const args = {
      dir: ["--directory", "--title=选项目目录"],
      dirs: ["--directory", "--multiple", "--separator=\n", "--title=选要发的文件夹"],
      files: ["--multiple", "--separator=\n", "--title=选要发的文件"],
    }[pick]
    picking = true
    try {
      const chosen = await new Promise<string | null>((resolve, reject) => {
        const [program, programArgs, env] = windows
          ? ([
              "powershell.exe",
              ["-NoProfile", "-NonInteractive", "-STA", "-Command", WINDOWS_PICKER],
              { ...process.env, BENCH_START: from, BENCH_PICK: pick },
            ] as const)
          : (["zenity", ["--file-selection", ...args, `--filename=${from.replace(/\/?$/, "/")}`], desktopEnv()] as const)
        execFile(
          program,
          [...programArgs],
          { env, timeout: PICK_LIMIT_MS, windowsHide: false },
          (error, stdout) => {
            // Exit 1 is the user closing it or pressing cancel.
            if (error && (error as { code?: number }).code === 1) return resolve(null)
            if (error) return reject(new ApiError(500, `选目录的窗口没打开：${error.message.split("\n")[0]}`))
            resolve(stdout.replace(/\r/g, "").trim() || null)
          },
        )
      })
      if (pick === "dir") return json({ dir: chosen })
      return json({ paths: chosen ? chosen.split("\n").filter(Boolean) : [] })
    } finally {
      picking = false
    }
  } catch (error) {
    return handle(error)
  }
}
