#!/usr/bin/env node
// Open the room in the browser with the user's key in the address
// (?key=…, see lib/human.ts). The page keeps it and takes it out of the
// address bar. The server writes data/human-key when it starts, so this waits
// a little for it. start.sh, start.bat and scripts/start-bench.sh all call it.
import { spawn } from "node:child_process"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const base = (process.env.BENCH_URL || "http://127.0.0.1:4399").replace(/\/$/, "")
const file = path.join(root, "data", "human-key")

let key = ""
for (let i = 0; i < 60 && !key; i++) {
  try {
    key = readFileSync(file, "utf8").trim()
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}
if (!key) {
  console.error(`没找到 ${file}：房间服务启动过吗？先运行 npm run dev`)
  process.exit(1)
}

const url = `${base}/?key=${key}`
const [command, args] =
  process.platform === "win32"
    ? ["cmd", ["/c", "start", "", url]]
    : process.platform === "darwin"
      ? ["open", [url]]
      : ["xdg-open", [url]]
const child = spawn(command, args, { stdio: "ignore", detached: true })
child.on("error", () => console.log(`打不开浏览器，手动打开：${url}`))
child.unref()
console.log(`房间：${base}（已带口令打开）`)
