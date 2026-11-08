#!/usr/bin/env bash
# Usage: claude-code.sh SESSION_ID MESSAGE
# Resume a Claude Code session headlessly, from the directory it was started in
# (Claude Code only finds a session under the project it belongs to). The
# answer goes to stdout; the room posts it back as that seat.
set -euo pipefail

session="${1:?缺少 session id}"
shift

bin="$(command -v claude || true)"
if [[ -z "$bin" ]]; then
  bin="$(ls -d "$HOME"/.config/Claude/claude-code/*/*/claude 2>/dev/null | sort -V | tail -1 || true)"
fi
if [[ -z "$bin" || ! -x "$bin" ]]; then
  echo "找不到 claude 可执行文件" >&2
  exit 127
fi

file="$(ls "$HOME"/.claude/projects/*/"$session".jsonl 2>/dev/null | head -1 || true)"
if [[ -z "$file" ]]; then
  echo "找不到 Claude Code 会话 $session" >&2
  exit 2
fi
dir="$(grep -m1 -o '"cwd":"[^"]*"' "$file" | head -1 | sed 's/^"cwd":"//; s/"$//' || true)"
if [[ -n "$dir" && -d "$dir" ]]; then
  cd "$dir"
fi

# Wake it with the permission mode its own window runs in, so a woken turn can
# do what the same session can do there. The Claude desktop app keeps that in
# its session record (by CLI session id); a terminal session records it in the
# transcript. Headless turns cannot ask, so in the default mode only the room's
# tools are allowed.
mode="$(node -e '
const fs = require("fs"), path = require("path")
const [session, file] = process.argv.slice(1)
const root = path.join(process.env.HOME, ".config/Claude/claude-code-sessions")
function find(dir, depth) {
  let entries = []
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return null }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory() && depth < 3) {
      const hit = find(full, depth + 1)
      if (hit) return hit
    } else if (entry.name.endsWith(".json")) {
      try {
        const record = JSON.parse(fs.readFileSync(full, "utf8"))
        if (record.cliSessionId === session && record.permissionMode) return record.permissionMode
      } catch {}
    }
  }
  return null
}
let mode = find(root, 0)
if (!mode) {
  const found = fs.readFileSync(file, "utf8").match(/"permissionMode":"([a-zA-Z]+)"/g) ?? []
  mode = found.length ? found[found.length - 1].split(":")[1].replaceAll("\"", "") : ""
}
process.stdout.write(mode)
' "$session" "$file" 2>/dev/null || true)"

perm=()
case "$mode" in
  bypassPermissions) perm=(--dangerously-skip-permissions) ;;
  acceptEdits|auto|plan|dontAsk) perm=(--permission-mode "$mode") ;;
esac

# stream-json: one event per line, which the room turns into the 「过程」 panel.
exec "$bin" --resume "$session" "${perm[@]}" --allowedTools mcp__bench --output-format stream-json --verbose -p "$@"
