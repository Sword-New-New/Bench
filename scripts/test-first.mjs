#!/usr/bin/env node
// 「第一次打开」 (lib/first-open.ts): what a fresh room offers, and what 「开始」
// sets up. Runs the room's code in this process on a throwaway data folder,
// with a stand-in desktop and a stand-in list of installed clients, so it
// needs no server and never touches a real room, desktop or client config:
//   node scripts/test-first.mjs
// BENCH_ROOT=<a copy of the repo> runs that copy's code instead.
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { register } from "node:module"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = process.env.BENCH_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
register(pathToFileURL(path.join(root, "scripts/ts-alias.mjs")).href, import.meta.url)
const tmp = mkdtempSync(path.join(os.tmpdir(), "bench-first-"))
const desktop = path.join(tmp, "desktop")
process.env.BENCH_DATA_DIR = path.join(tmp, "data")
process.env.XDG_STATE_HOME = path.join(tmp, "state")
process.env.BENCH_FIRST_PARENT = desktop
process.env.BENCH_FIRST_KINDS = process.env.FIRST_PART ? "claude" : "none"
process.on("exit", () => {
  try { globalThis.__benchSqlite?.db?.close() } catch {}
  try { rmSync(tmp, { recursive: true, force: true }) } catch {}
})

const lib = (name) => import(pathToFileURL(path.join(root, "lib", `${name}.ts`)).href)
const store = await lib("store")
const first = await lib("first-open")
const { folderNameOf } = await lib("first-name")

let failed = 0
function check(ok, what) {
  console.log(`${ok ? "ok " : "FAIL"} ${what}`)
  if (!ok) failed++
}
async function refusal(fn) {
  try {
    await fn()
    return null
  } catch (error) {
    return { status: error.status, message: error.message }
  }
}
const human = { as: "human" }
const want = "给我的小店做一个网站，要有商品列表和购物车"

// ---- 「换一个」: an existing folder (run in a child, as a second fresh room) ----
if (process.env.FIRST_PART === "dir") {
  const mine = path.join(tmp, "我的旧项目")
  mkdirSync(mine)
  const made = await first.startFirst({ ...human, text: want, dir: mine })
  const seat = store.inProject(made.project, () => store.snapshot().agents.find((agent) => !agent.demo))
  check(made.dir === mine && !existsSync(desktop), "选了已有的文件夹：就用它，桌面上不新建")
  check(store.inProject(made.project, () => store.agentState(seat.id))?.workdir === mine && store.listProjects().find((item) => item.id === made.project)?.dir === mine, "项目和席位都在这个文件夹里")
  console.log(failed ? `first(dir): ${failed} failed` : "first(dir) ok")
  process.exit(failed ? 1 : 0)
}

// ---- failed half-way (run in a child, as a fresh room) ----
// The seat is made, then its sign-in file can't be written: the room must
// stay fresh so 「开始」 works again, in the same folder.
if (process.env.FIRST_PART === "fail") {
  const stateDir = path.join(tmp, "state")
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(path.join(stateDir, "bench-mcp"), "挡住入座文件夹")
  const broke = await refusal(() => first.startFirst({ ...human, text: want }))
  const project = store.listProjects().find((item) => !item.front)
  const snap = store.inProject(project.id, () => store.snapshot())
  check(broke?.status === 500, `中途失败报出来（${broke?.status}）`)
  check(
    snap.agents.filter((agent) => !agent.demo).length === 0 && !snap.messages.some((message) => message.authorId === "human") && first.isFresh(),
    "中途失败后席位收回，房间还是全新的，第一屏还在",
  )
  rmSync(path.join(stateDir, "bench-mcp"))
  const made = await first.startFirst({ ...human, text: want })
  const seats = store.inProject(made.project, () => store.snapshot().agents.filter((agent) => !agent.demo))
  check(seats.length === 1 && readdirSync(desktop).length === 1, `再点开始能接着建好，只有一个席位、一个文件夹（${seats.length}，${readdirSync(desktop).join("、")}）`)
  console.log(failed ? `first(fail): ${failed} failed` : "first(fail) ok")
  process.exit(failed ? 1 : 0)
}

// ---- the folder's name ----
check(folderNameOf(want) === "给我的小店做一个网站", `取第一句的前几个字（${folderNameOf(want)}）`)
check(folderNameOf("  /做个 *小游戏*?!  ") === "做个小游戏", "去掉标点和不能当文件名的字")
check(folderNameOf("！？") === "新项目" && folderNameOf("") === "新项目", "什么字都不剩时叫「新项目」")
check([...folderNameOf("一二三四五六七八九十十一十二")].length === 10, "最多十个字")

// ---- nothing installed ----
const none = first.firstOpenInfo()
check(none.fresh === true && none.kinds.length === 0 && none.pick === null, "一家都没装：没有可选的")
check(none.install?.text.includes("npm install") && none.install.url.startsWith("https://"), "一家都没装：告诉用户最省事的一家怎么装")
check(/还没装/.test((await refusal(() => first.startFirst({ ...human, text: want })))?.message ?? ""), "一家都没装时点开始：说清楚")

// ---- what a fresh room offers ----
process.env.BENCH_FIRST_KINDS = "dsh,claude"
const info = first.firstOpenInfo()
check(info.fresh === true, "全新的房间")
check(info.pick === "claude" && info.kinds.map((item) => item.id).join() === "claude,dsh", `按 Claude → GPT → Gemini → DeepSeek → Grok 的顺序推荐（${info.kinds.map((item) => item.label)}）`)
check(info.kinds[0].label === "Claude" && info.parent === desktop, "谁来做、放在哪都给了")

// ---- refusals ----
check((await refusal(() => first.startFirst({ text: want })))?.status === 403, "不是用户本人点的被拒")
check((await refusal(() => first.startFirst({ ...human, text: "  " })))?.status === 400, "没写想做什么被拒")
check((await refusal(() => first.startFirst({ ...human, text: want, kind: "codex" })))?.status === 400, "选了没装的被拒")
check((await refusal(() => first.startFirst({ ...human, text: want, dir: path.join(tmp, "没有这个") })))?.status === 400, "选了不存在的文件夹被拒")
check(!existsSync(desktop) && first.isFresh(), "被拒的都没建任何东西")

// ---- 「开始」 ----
// The name is taken: the new folder gets a number.
mkdirSync(path.join(desktop, "给我的小店做一个网站"), { recursive: true })
const [one, two] = await Promise.allSettled([first.startFirst({ ...human, text: want }), first.startFirst({ ...human, text: want })])
check(one.status === "fulfilled" && two.status === "rejected" && two.reason.status === 409 && /正在准备/.test(two.reason.message), "同时点两次：第二次说正在准备，只建一份")
const made = one.value
const dir = path.join(desktop, "给我的小店做一个网站2")
check(made?.dir === dir && existsSync(dir), `在桌面新建了文件夹，重名加序号（${made?.dir}）`)
const project = store.listProjects().find((item) => item.id === made?.project)
check(project?.name === "给我的小店做一个网站" && project.dir === dir && store.listProjects().filter((item) => !item.front).length === 1, "用的是默认项目，改了名、设好文件夹")
const snap = store.inProject(made.project, () => store.snapshot())
const seats = snap.agents.filter((agent) => !agent.demo)
const seat = seats[0]
check(seats.length === 1 && seat.name === "Claude" && seat.agentName === "claude", `建了一个席位，就叫 Claude，不带数字（${seat?.name}）`)
check(store.inProject(made.project, () => store.agentState(seat.id))?.workdir === dir && !seat.autoFull, "席位在这个文件夹里干活，没有悄悄给全权")
const said = snap.messages.filter((message) => message.authorId === "human")
check(said.length === 1 && said[0].text === `@Claude ${want}` && said[0].mentions.includes(seat.id), `那句话作为用户的第一条消息发出、点名它（${said[0]?.text}）`)
check(existsSync(path.join(tmp, "state", "bench-mcp")) && readdirSync(path.join(tmp, "state", "bench-mcp")).length > 0, "席位的入座信息写好了，它不用自己入座")

// ---- after that ----
check(first.isFresh() === false && first.firstOpenInfo().fresh === false, "开始之后不再是全新的房间")
const again = await refusal(() => first.startFirst({ ...human, text: want }))
check(again?.status === 409, "再点开始不重复建")
check(store.inProject(made.project, () => store.snapshot().agents.filter((agent) => !agent.demo).length) === 1 && readdirSync(desktop).length === 2, "席位和文件夹都没多出来")

const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], { env: { ...process.env, FIRST_PART: "dir" }, encoding: "utf8" })
process.stdout.write(child.stdout)
check(child.status === 0, "「换一个」选已有文件夹那一段")
const failChild = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], { env: { ...process.env, FIRST_PART: "fail" }, encoding: "utf8" })
process.stdout.write(failChild.stdout)
check(failChild.status === 0, "中途失败再点开始那一段")

if (failed) {
  console.log(`first: ${failed} failed`)
  process.exit(1)
}
console.log("first ok")
process.exit(0)
