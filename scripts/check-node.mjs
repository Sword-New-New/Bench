// Run before the room starts (start.sh, start.bat, `npm run dev` / `start`):
// the store uses node:sqlite, which Node 20 doesn't have at all and Node
// 22.5–22.12 / 23.0–23.3 only have behind --experimental-sqlite. Say so in a
// sentence instead of letting it die on an import error.
// (nodejs.org/api/sqlite.html: added v22.5.0; no flag from v22.13.0 and v23.4.0.)
// Keep this file to syntax every Node since 14 can parse.

const [major, minor] = process.versions.node.split(".").map(Number)
const ok = major > 23 || (major === 23 && minor >= 4) || (major === 22 && minor >= 13)

if (!ok) {
  console.error(
    `\n当前 Node 是 ${process.versions.node}，并坐要 22.13 或更新。\n` +
      "原因：房间的存储用了 Node 自带的 node:sqlite，Node 20 里没有，22.5 到 22.12 要另加开关。\n" +
      "到 https://nodejs.org 装 LTS 版（或用 nvm install --lts），装好再运行一次。\n",
  )
  process.exit(1)
}
