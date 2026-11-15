// Unit cases for gistOf (lib/text.ts): node scripts/test-gist.mjs
// Node 22.13+ strips the TypeScript types itself; lib/text.ts has no imports.
// Quiet the one-line notice about reparsing lib/text.ts as a module.
process.removeAllListeners("warning")
const { gistOf, GIST_MAX } = await import("../lib/text.ts")

const cases = [
  ["【本轮结束】第 1、2 条都做好了，待办 t_d99a05b9 等你验收。\n\n**1. 点名**\n- 细节", "第 1、2 条都做好了，待办 t_d99a05b9 等你验收。"],
  ["做完了：气泡不再提前收起。", "做完了：气泡不再提前收起。"],
  ["## 原因\n很长的说明", undefined],
  ["| a | b |\n|---|---|\n| 1 | 2 |", undefined],
  ["- 第一点\n- 第二点", undefined],
  ["1. 第一步\n2. 第二步", undefined],
  ["```ts\nconst a = 1\n```", undefined],
  ["**原因**\n\n长说明", undefined],
  ["> 引用一段\n\n正文", undefined],
  // Long first paragraph: its first sentence.
  [`查到原因了，也修好了。${"细节".repeat(80)}`, "查到原因了，也修好了。"],
  // Long and no sentence end within reach: nothing.
  [`${"没有句号的长段落".repeat(30)}`, undefined],
  // A paragraph that runs into a list is cut before it.
  ["改了三处：\n- a\n- b", "改了三处："],
  ["   \n  ", undefined],
  [undefined, undefined],
  ["【本轮结束】", undefined],
  // Wrapped lines in the first paragraph join into one.
  ["第一行\n接着第一段。\n\n第二段", "第一行 接着第一段。"],
  ["What changed? The retry now waits.", "What changed? The retry now waits."],
]

let failed = 0
for (const [input, want] of cases) {
  const got = gistOf(input)
  if (got !== want) {
    failed++
    console.error(`✗ ${JSON.stringify(input)?.slice(0, 60)}\n  want ${JSON.stringify(want)}\n  got  ${JSON.stringify(got)}`)
  }
  if (got && got.length > GIST_MAX) {
    failed++
    console.error(`✗ longer than ${GIST_MAX}: ${got}`)
  }
}
if (failed) {
  console.error(`gist: ${failed} failed`)
  process.exit(1)
}
console.log(`gist ok (${cases.length} cases)`)
