import { existsSync, readdirSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import { adapterFor, installed } from "@/lib/adapters"
import { sessionRecord } from "@/lib/context"
import { lastRunOf } from "@/lib/runs"
import { agentState, isStandby } from "@/lib/store"

// "If someone @s me, will something actually start?" A seat that joined can't
// tell: a wake that can't start (the client's command not on the room's PATH,
// a wrong session id, a kind the room has no command for) fails the same way
// as one nobody sent, with silence. This checks each of those without waking
// anything (a wake now would run on the very session that is asking, beside
// it), and shows the seat's latest wake as it went, which is the proof once
// someone has called it.

type Check = { name: string; ok: boolean | null; detail: string }

// The clients the room's own wake scripts look for (scripts/*.sh): the script
// itself is always there, the client may not be.
const UNDER: Record<string, { bin: string; also: () => string | null }> = {
  claude: {
    bin: "claude",
    also: () => {
      const root = path.join(os.homedir(), ".config", "Claude", "claude-code")
      try {
        for (const version of readdirSync(root)) {
          for (const build of readdirSync(path.join(root, version))) {
            const file = path.join(root, version, build, "claude")
            if (existsSync(file)) return file
          }
        }
      } catch {}
      return null
    },
  },
  codex: { bin: "codex", also: () => (existsSync("/usr/lib/chatgpt/resources/codex") ? "/usr/lib/chatgpt/resources/codex" : null) },
}

function seconds(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${s % 60} 秒`
}

// Called inside the seat's project, after its token was checked.
export function selfcheck(agentId: string) {
  const agent = agentState(agentId)
  if (!agent) return null
  const checks: Check[] = []
  const kind = agent.agentName ?? ""
  const session = agent.session ?? ""

  checks.push(
    kind && session
      ? { name: "报了客户端和会话", ok: true, detail: `${kind} · ${session}` }
      : {
          name: "报了客户端和会话",
          ok: false,
          detail: "入座时没带 agent_name 和 uuid（会话 id），房间不知道叫醒谁。重新 bench_join，或 POST /api/v1/join 时带上这两项",
        },
  )

  const adapter = kind ? adapterFor(kind) : null
  checks.push(
    adapter
      ? { name: "房间有它的唤起命令", ok: true, detail: adapter.command }
      : {
          name: "房间有它的唤起命令",
          ok: false,
          detail: kind
            ? `agents.json 里没有 ${kind} 的唤起命令：别人 @ 你时房间叫不醒你。要收到点名，就循环调用 bench_wait 守着`
            : "没报客户端种类，找不到唤起命令",
        },
  )

  if (adapter) {
    const runnable = installed(adapter.command)
    checks.push({
      name: "唤起命令能找到",
      ok: runnable,
      detail: runnable ? "房间的 PATH 上找得到它" : `房间的 PATH 上找不到「${adapter.command.split(/\s+/)[0]}」，叫醒时会报找不到命令`,
    })
    const under = UNDER[kind]
    if (under) {
      const found = installed(under.bin) || under.also() !== null
      checks.push({
        name: `${under.bin} 程序找得到`,
        ok: found,
        detail: found
          ? "唤起脚本会用到它，找得到"
          : `唤起脚本要用 ${under.bin}，房间的 PATH 上没有（从桌面图标起的房间，PATH 比终端里短）`,
      })
    }
  }

  const record = sessionRecord(kind, session)
  checks.push(
    record === undefined
      ? { name: "会话记录存在", ok: null, detail: `${kind || "这种客户端"}的会话记录房间读不到，没法核对 id 对不对` }
      : record
        ? { name: "会话记录存在", ok: true, detail: record }
        : agent.workdir
          ? { name: "会话记录存在", ok: true, detail: "房间开的新会话，第一次叫醒时才建记录" }
          : { name: "会话记录存在", ok: false, detail: `本机没有会话 ${session} 的记录：多半是 uuid 报错了，叫醒会失败` },
  )

  const run = lastRunOf(agentId)
  const end = run?.steps.findLast((step) => step.id === "end")?.title
  const lastRun = run
    ? {
        id: run.id,
        purpose: run.purpose,
        state: run.state,
        startedAt: run.startedAt,
        took: seconds((run.endedAt ?? Date.now()) - run.startedAt),
        note: end ?? (run.state === "done" ? "做完了" : run.state === "running" ? "还在跑" : "没成功"),
      }
    : null

  const failed = checks.some((check) => check.ok === false)
  const standby = isStandby(agentId)
  const summary = failed
    ? "有一项没过：照上面的说明修好前，别人 @ 你多半收不到。"
    : standby
      ? "检查都过了。你正挂在 bench_wait 里，点名会直接送到你这里，不用唤起。"
      : lastRun?.state === "done"
        ? `检查都过了，最近一次唤起（${lastRun.took}）成功：点名你确实能把你叫起来。`
        : lastRun?.state === "running"
          ? `检查都过了。房间此刻正唤起着你（这一轮已跑 ${lastRun.took}），点名确实能把你叫起来。`
          : lastRun
            ? `检查都过了，但最近一次唤起没成功：${lastRun.note}。`
          : "检查都过了，但还没被叫醒过。请用户在群里 @ 你一次，回完再跑一次自检，最近一次唤起那一栏就是叫得醒的证据。"

  return { seat: agent.name, ok: !failed, checks, lastRun, standby, summary }
}
