#!/usr/bin/env node
// Send a client's usage to the room, for clients the room can't read itself.
// A plugin, hook or cron job runs this after it has found out the numbers.
//
//   node scripts/quota-push.mjs --kind codebuddy --source "CodeBuddy 插件" \
//     --window "本月|month|35|2026-12-01T00:00:00+08:00" \
//     --window "5 小时|5h|used=120,limit=600|2026-11-10T03:00:00Z"
//
// --window "label|span|amount|resetsAt", amount being a percent used ("35"),
// a percent left ("left=65"), or used and limit ("used=120,limit=600");
// span is 5h, day, week, month or other; resetsAt may be left empty.
// --ttl seconds (default 6 hours): after that the room drops the report.
// --clear takes the kind's report down. --room sets the address
// (default BENCH_URL or http://127.0.0.1:4399).
// Or pipe a whole report in as JSON: echo '{"kind":…,"windows":[…]}' | node scripts/quota-push.mjs -

const args = process.argv.slice(2)
const room = (process.env.BENCH_URL || "http://127.0.0.1:4399").replace(/\/$/, "")

function fail(message) {
  console.error(message)
  process.exit(1)
}

async function stdin() {
  let text = ""
  for await (const chunk of process.stdin) text += chunk
  return JSON.parse(text)
}

function parseWindow(spec) {
  const [label, span, amount, resetsAt] = spec.split("|").map((part) => part.trim())
  if (!label || !amount) fail(`--window 要写成 "标签|span|数量|重置时间"：${spec}`)
  const window = { label, span: span || "other" }
  if (resetsAt) window.resetsAt = resetsAt
  if (/^left=/.test(amount)) window.percentLeft = Number(amount.slice(5))
  else if (/used=/.test(amount)) {
    for (const pair of amount.split(",")) {
      const [key, value] = pair.split("=")
      window[key.trim()] = Number(value)
    }
  } else window.percent = Number(amount)
  return window
}

let body
let base = room
if (args[0] === "-") body = await stdin()
else {
  body = { windows: [] }
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]
    const value = () => args[++i] ?? fail(`${flag} 后面要跟值`)
    if (flag === "--kind") body.kind = value()
    else if (flag === "--source") body.source = value()
    else if (flag === "--plan") body.plan = value()
    else if (flag === "--ttl") body.ttl = Number(value())
    else if (flag === "--window") body.windows.push(parseWindow(value()))
    else if (flag === "--clear") body.windows = []
    else if (flag === "--room") base = value().replace(/\/$/, "")
    else fail(`不认识的参数：${flag}`)
  }
  if (!body.kind) fail("缺少 --kind（claude、codex、cursor、qoder、codebuddy、workbuddy、copilot…）")
}

const response = await fetch(`${base}/api/v1/quota`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
}).catch((error) => fail(`连不上房间 ${base}：${error.message}`))
const data = await response.json().catch(() => ({}))
if (!response.ok) fail(`房间没收：${data.error ?? response.status}`)
console.log(data.report ? `收到了：${data.report.kind} ${data.report.windows.length} 条` : "已撤下")
