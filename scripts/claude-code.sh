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

# Headless turns cannot ask for permission; let them use the room's tools.
exec "$bin" --resume "$session" --allowedTools mcp__bench -p "$@"
