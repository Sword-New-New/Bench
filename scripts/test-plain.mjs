#!/usr/bin/env node
// 「说人话」: the rules in lib/plain.ts and the lines built on them (what a
// running tool and a failed wake say). No room, no server.
// node scripts/test-plain.mjs
import { register } from "node:module"
register("./ts-alias.mjs", import.meta.url)

const { plainFault, plainRefusal, firstLine, toolAction, toolWhy, liveToolLine, failureReason } = await import("../lib/plain.ts")
const { liveLine } = await import("../lib/events.ts")

let failed = 0
function check(ok, what) {
  console.log(`${ok ? "ok " : "FAIL"} ${what}`)
  if (!ok) failed++
}

// Said so for the user, in the words of the room: these read as code.
const CODE = [
  ["改 lib/store.ts 的 createTask", "文件名"],
  ["gist.tsx 加 summaryOf", "文件名"],
  ["把 `summaryOf` 换掉", "代码引号"],
  ["接着做 t_5de117f4", "待办编号"],
  ["bench_task 要检查标题", "带下划线的名字"],
  ["看 http://127.0.0.1:4399 的页面", "网址"],
  ["检查 keyFile 软链", "驼峰名字"],
  ["跑 tsc、eslint", "行话"],
  ["fix the race in the queue worker", "成串英文"],
  ["新增接口 /api/v1/tasks", "路径"],
]
for (const [text, kind] of CODE) {
  const fault = plainFault(text)
  check(fault?.kind === kind, `夹代码：「${text}」 → ${kind}（得到 ${fault?.kind ?? "放行"}）`)
}

// These pass: plain words, product names, numbers, a little English.
const PLAIN = [
  "聊天里长回复先只显示一句结论",
  "把 Claude 和 GPT 接进 App：Gemini、DeepSeek 也能用",
  "在单独分支上升级 Next.js，修掉已知安全漏洞",
  "选模型适配 Cursor、CodeBuddy、WorkBuddy、Copilot",
  "深色背景改成实时渲染的极光（WebGL，默认静止）",
  "第 3 步：撞到 5 小时额度后自动继续",
  "bench-shell 启动器：桌面 + 开始菜单",
  "iPhone 上也能收到推送",
  "SnowLuma 转私有后的保全",
]
for (const text of PLAIN) check(plainFault(text) === null, `放行：「${text}」（得到 ${JSON.stringify(plainFault(text))}）`)

check(firstLine("\n\n  第一句\n第二句") === "第一句", "验收说明只看第一行")
check(/用户怎么看到效果/.test(plainRefusal("验收说明", { kind: "路径", found: "lib/x" })), "验收说明被退回时提示第一句写怎么看到效果")
check(/别写改了哪个文件/.test(plainRefusal("标题", { kind: "路径", found: "lib/x" })), "标题被退回时有改法和例子")

// Tool lines: the client's own sentence first, else the kind of tool.
check(toolAction("Bash", { command: "npx tsc --noEmit -p ." }) === "运行一条命令", "命令 → 运行一条命令")
check(toolAction("Edit", { file_path: "/a/b/gist.tsx" }) === "改文件 gist.tsx", "改文件只留文件名")
check(toolAction("Read", { file_path: "/a/b/MAINTENANCE.md" }) === "读文件 MAINTENANCE.md", "读文件只留文件名")
check(toolAction("WebFetch", { url: "https://example.com/a?b=1" }) === "打开网页 example.com", "打开网页只留域名")
check(toolAction("mcp__bench__bench_say", {}) === "用一个外部工具", "外部工具不露名字")
check(toolAction("commandExecution", { command: "ls" }) === "运行一条命令", "Codex 的命令也认")
check(toolWhy({ command: "ls", description: "看一下目录" }) === "看一下目录", "取客户端自带的那句说明")
check(toolWhy({ command: "ls" }) === undefined, "没有说明就是没有")

const step = (title, args) => ({ id: "s", at: 0, kind: "tool", title, input: args ? JSON.stringify(args) : undefined, state: "running" })
check(liveLine(step("运行 npx tsc --noEmit -p . && npx eslint …", { command: "npx tsc", description: "检查类型和代码风格" })) === "正在检查类型和代码风格", "正在做：先用它自己写的中文说明")
check(liveLine(step("运行 npx tsc --noEmit -p . && npx eslint …", { command: "npx tsc", description: "Run type check" })) === "正在运行一条命令", "英文说明不用，退回种类说法，命令原文不露")
check(liveLine(step("运行 npm test", { command: "npm test" })) === "正在运行一条命令", "没有说明：正在运行一条命令")
check(liveLine(step("读 package.json", { file_path: "/x/package.json" })) === "正在读 package.json", "读文件本来就是人话，保持")
check(liveLine(step("搜 createTask|summaryOf", { pattern: "createTask|summaryOf" })) === "正在在文件里找东西", "搜索的正则不露")
check(liveLine(step("TodoWrite")) === "正在更新待办清单", "工具名只是英文标识时换成一句话")

// Failures: who, roughly why. Always a sentence, never the first eight letters.
check(failureReason("workbuddy", "Authentication required, run /login") === "没有登录，或登录过期了", "没登录")
check(failureReason("claude", "read ECONNRESET") === "网络断了", "网络断了")
check(failureReason("claude", "spawn claude ENOENT") === "找不到它要用的程序或文件", "找不到程序")
check(failureReason("claude", "something odd happened in the middle") === "出了没预料到的错", "认不出的原因照实说认不出")
check(!/[A-Za-z]{4,}/.test(failureReason("claude", "Error: kaboom in the engine room")), "原因里不带英文原文")

if (failed) {
  console.error(`${failed} 项没过`)
  process.exit(1)
}
console.log("plain ok")
