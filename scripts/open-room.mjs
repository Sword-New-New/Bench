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

// The link carries the key, so it is printed only to a terminal. That keeps it
// out of what a spawned agent reads, but an agent whose shell is itself a
// terminal still sees it: this is no barrier (the same account can read
// data/human-key anyway), just not handing it out by default.
let said = false
const say = (text) => {
  if (said) return
  said = true
  console.log(text)
}
const failed = () =>
  say(
    process.stdout.isTTY
      ? `打不开浏览器，手动打开：${url}`
      : `打不开浏览器。带口令的链接不打印在这里：请用户在自己的终端里运行 npm run open。房间：${base}`,
  )
child.on("error", failed)
// xdg-open and friends can start and still fail (no display, no default
// browser, over SSH): only a clean exit counts as opened.
child.on("close", (code) => (code === 0 ? say(`房间：${base}（已带口令打开）`) : failed()))
// One that keeps running has handed the link to a browser; don't wait on it.
setTimeout(() => {
  say(`房间：${base}（已带口令打开）`)
  child.unref()
}, 5000).unref()
