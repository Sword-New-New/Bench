// When the server starts, make sure data/human-key exists (lib/human.ts), so
// the launchers can open the room with it. The key itself is never printed:
// next dev's output is also written to .next/dev/logs, which agents read.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return
  const { humanKey } = await import("@/lib/human")
  humanKey()
  console.log("并坐：用带口令的链接打开房间：npm run open（或桌面上的「并坐」图标）")
}
