import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import { boot } from "@/lib/boot"
import { ApiError, asRecord, asString, handle, json, readBody } from "@/lib/http"
import { installed } from "@/lib/adapters"

// 「浏览…」 in the project dialog: the room opens the desktop's own folder
// picker (zenity) and hands back the folder chosen. A page can't do this
// itself; browsers never give out a folder's full path.

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

export async function POST(request: Request) {
  try {
    await boot()
    const body = asRecord(await readBody(request))
    if (body.as !== "human") throw new ApiError(400, "只有这台电脑上的人能选目录")
    if (!installed("zenity")) throw new ApiError(501, "没找到选目录的窗口：装一下 zenity（sudo apt install zenity），或者直接填路径")
    if (picking) throw new ApiError(409, "选目录的窗口已经开着了，看看任务栏")
    const start = (asString(body.start) ?? "").replace(/^~(?=\/|$)/, os.homedir())
    const from = start && path.isAbsolute(start) && existsSync(start) ? start : os.homedir()
    picking = true
    try {
      const chosen = await new Promise<string | null>((resolve, reject) => {
        execFile(
          "zenity",
          ["--file-selection", "--directory", "--title=选项目目录", `--filename=${from.replace(/\/?$/, "/")}`],
          { env: desktopEnv(), timeout: PICK_LIMIT_MS },
          (error, stdout) => {
            // Exit 1 is the user closing it or pressing cancel.
            if (error && (error as { code?: number }).code === 1) return resolve(null)
            if (error) return reject(new ApiError(500, `选目录的窗口没打开：${error.message.split("\n")[0]}`))
            resolve(stdout.trim() || null)
          },
        )
      })
      return json({ dir: chosen })
    } finally {
      picking = false
    }
  } catch (error) {
    return handle(error)
  }
}
