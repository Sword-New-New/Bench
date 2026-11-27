// Runs real storage and routing on a throwaway database; never calls a model.
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { register } from "node:module"
import os from "node:os"
import path from "node:path"

register("./ts-alias.mjs", import.meta.url)
const tmp = mkdtempSync(path.join(os.tmpdir(), "bench-workflows-"))
writeFileSync(path.join(tmp, "example.txt"), "example")
process.env.BENCH_DATA_DIR = tmp
process.on("exit", () => {
  try { globalThis.__benchSqlite?.db?.close() } catch {}
  try { rmSync(tmp, { recursive: true, force: true }) } catch {}
})
const db = await import("../lib/db.ts")
const flows = await import("../lib/workflows.ts")
const { parseSlash, slashCommands } = await import("../lib/commands.ts")

const pid = "p_test_workflows"
db.dbSaveProject({ id: pid, name: "测试项目", createdAt: Date.now() }, 0, { rev: 0, seq: 0 })
assert.equal(flows.listWorkflows(pid).length, 0, "新项目默认没有硬编码预置工作流")

const seats = ["主控席", "执行席", "规划甲", "汇总席", "搭档乙"].map((name, index) => ({ id: `a_${index}`, name, demo: false }))

// Builtin /plan works with explicit @ overrides, and gives a clear hint when neither configured nor @'d.
const builtinPlan = flows.findWorkflow(pid, { command: "plan" })
assert.throws(() => flows.renderWorkflow(builtinPlan, "制定改造计划", seats), /还没有配置混合计划席位/)
assert.deepEqual(
  flows.renderWorkflow(builtinPlan, "制定改造计划", seats, { planners: ["规划甲", "搭档乙"] }).targets,
  ["a_2", "a_4"],
)

const work = flows.saveWorkflow(pid, {
  name: "主控派活与汇总",
  kind: "orchestrate",
  command: "work",
  lead: "主控席",
  workers: ["执行席"],
  summarizer: "汇总席",
})
const plan = flows.saveWorkflow(pid, {
  name: "混合计划模式",
  kind: "plan",
  command: "plan",
  planners: ["规划甲", "执行席"],
})
const savedList = flows.listWorkflows(pid)
assert.equal(savedList.length, 2)
assert.equal(work.summarizer, "汇总席")

let rendered = flows.renderWorkflow(work, "修改首页，参考 @汇总席 的建议", seats)
assert.deepEqual(rendered.targets, ["a_0"], "主控启动只唤起主控")
assert.match(rendered.text, /最终汇总只由.*汇总席/)
rendered = flows.renderWorkflow(plan, "制定页面改造计划", seats)
assert.deepEqual(rendered.targets, ["a_2", "a_1"])
assert.match(rendered.text, /不修改代码.*文件/)
assert.deepEqual(flows.renderWorkflow(plan, "计划", seats, { planners: ["执行席", "搭档乙", "规划甲"] }).targets, ["a_1", "a_4", "a_2"])
assert.throws(() => flows.renderWorkflow(work, "需求", seats.filter((item) => item.name !== "主控席")), /主控席.*未入座/)
assert.throws(() => flows.renderWorkflow(plan, "需求", seats, { planners: ["执行席"] }), /至少.*两/)
assert.throws(() => flows.saveWorkflow(pid, { ...work, command: "stop" }), /占用|冲突/)
assert.throws(() => flows.saveWorkflow(pid, { ...work, id: undefined, command: "work" }), /已存在|重复/)
assert.throws(() => flows.saveWorkflow(pid, { ...work, name: " " }), /名称/)

const custom = flows.saveWorkflow(pid, { name: "结对设计", kind: "plan", command: "design", planners: ["执行席", "搭档乙"] })
assert.equal(flows.listWorkflows(pid).length, 3)
assert.equal(flows.saveWorkflow(pid, { ...custom, name: "双人设计" }).name, "双人设计")
assert.equal(flows.listWorkflows("other-project").length, 0)
assert.throws(() => flows.deleteWorkflow("other-project", custom.id), /不存在|没有/)

// Multi-AI explore mode: builtin /explore, CRUD, command guard, multi-seat parallel wake
const builtinExplore = flows.findWorkflow(pid, { command: "explore" })
assert.throws(() => flows.renderWorkflow(builtinExplore, "探索缓存方案", seats), /还没有配置探索席位/)
assert.deepEqual(
  flows.renderWorkflow(builtinExplore, "探索缓存方案", seats, { explorers: ["主控席", "执行席", "汇总席"] }).targets,
  ["a_0", "a_1", "a_3"],
)
assert.throws(() => flows.saveWorkflow(pid, { ...work, id: undefined, command: "explore" }), /explore 命令只用于/)
const exploreFlow = flows.saveWorkflow(pid, {
  name: "多 AI 架构探索",
  kind: "explore",
  command: "explore",
  explorers: ["主控席", "执行席", "汇总席"],
})
const renderedExplore = flows.renderWorkflow(exploreFlow, "对比三种状态同步方案", seats)
assert.deepEqual(renderedExplore.targets, ["a_0", "a_1", "a_3"])
assert.match(renderedExplore.text, /多 AI 联合探索.*不修改代码或文件/)
assert.match(renderedExplore.text, /探索主题：\n对比三种状态同步方案/)
const parsedExplore = parseSlash("/explore 探索渲染性能 @汇总席 @主控席 @执行席", seats.map((s) => s.name), [...savedList, exploreFlow])
assert.equal(parsedExplore.command.mode, "workflow")
assert.equal(parsedExplore.command.workflowId, exploreFlow.id)
assert.deepEqual(parsedExplore.targets, ["汇总席", "主控席", "执行席"])
assert.equal(slashCommands([...savedList, exploreFlow]).filter((c) => c.name === "explore").length, 1)

const parsed = parseSlash("/plan 做改版 @搭档乙 @执行席", seats.map((s) => s.name), savedList)
assert.equal(parsed.command.mode, "workflow")
assert.deepEqual(parsed.targets, ["搭档乙", "执行席"], "点名按输入顺序，首位负责统稿")
assert.equal(parseSlash("/design 画页面", [], [custom]).command.workflowId, custom.id)
assert.equal(parseSlash("/goal clear @执行席", ["执行席"]).command.mode, "seat")
assert.equal(parseSlash("C:/Program Files/Git/goal clear", []), null)
assert.equal(slashCommands(savedList).filter((c) => c.name === "plan").length, 1)
assert.equal(parseSlash("/plan 安排\n1. 首页\n2. 文章", []).text, "安排\n1. 首页\n2. 文章")

// Simulate the existing dev server connection surviving a module reload.
const connection = db.getDb()
connection.exec("DROP TABLE workflows")
delete globalThis.__benchSqlite.schemaVer
assert.doesNotThrow(() => db.dbListWorkflows(pid))
assert.equal(db.getDb(), connection, "迁移沿用现有连接")
assert.equal(globalThis.__benchSqlite.schemaVer, 2)

// Persistence after a fresh connection and deleting stays deleted.
db.dbSaveWorkflow(work)
flows.deleteWorkflow(pid, work.id)
assert(!flows.listWorkflows(pid).some((f) => f.id === work.id))
connection.close()
assert(!flows.listWorkflows(pid).some((f) => f.id === work.id))

// Actual store path: reply to a different seat and @ inside a requirement
// must not accidentally wake that seat when the workflow only calls its lead.
const store = await import("../lib/store.ts")
store.inProject(pid, () => {
  const joined = seats.map((s) => store.join({ name: s.name, model: "test", role: "test" }))
  const original = store.say({ agentId: joined[3].agent.id, token: joined[3].token, text: "参考建议" }).message
  const saved = store.workflowAction({ as: "human", action: "save", workflow: { ...work, id: undefined } }).workflow
  const result = store.workflowAction({
    as: "human",
    action: "run",
    id: saved.id,
    text: "参考 @汇总席 的意见",
    replyTo: original.id,
    attachments: [{ kind: "file", name: "example", path: path.join(tmp, "example.txt") }],
  })
  assert.deepEqual(store.summonCandidates(result.message).map((a) => a.name), ["主控席"])
  assert.equal(result.message.replyTo, original.id)
  assert.equal(result.message.attachments[0].name, "example")
  assert(store.snapshot().workflows.some((f) => f.id === saved.id))
  assert.throws(() => store.workflowAction({ agentId: joined[0].agent.id, token: joined[0].token, action: "delete", id: saved.id }), /只有.*用户/)
  const planned = store.workflowAction({ as: "human", action: "run", command: "plan", targets: ["搭档乙", "执行席"], text: "规划" })
  assert.deepEqual(store.summonCandidates(planned.message).map((a) => a.name).sort(), ["执行席", "搭档乙"].sort())
  const explored = store.workflowAction({ as: "human", action: "run", command: "explore", targets: ["主控席", "汇总席", "执行席"], text: "多角度探索" })
  assert.deepEqual(store.summonCandidates(explored.message).map((a) => a.name).sort(), ["主控席", "执行席", "汇总席"].sort())
})
console.log("PASS workflows: CRUD, hot reload, persistence, slash parsing, planning and exact wake targets")
