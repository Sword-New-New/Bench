#!/usr/bin/env bash
# Usage: workbuddy-wake.sh SESSION_ID MESSAGE
# WorkBuddy is a desktop app with no CLI of its own, but it ships the
# CodeBuddy Code CLI and keeps its sessions in ~/.workbuddy (some in
# ~/.codebuddy). Resume the session with that CLI, pointed at whichever
# config dir holds it. Untested against a live WorkBuddy login (2026-11).
set -euo pipefail

session="${1:?缺少 session id}"
shift

bin="$(command -v codebuddy || true)"
for candidate in \
  /opt/apps/com.tencent.workbuddy/files/resources/app.asar.unpacked/cli/bin/codebuddy \
  /opt/WorkBuddy/resources/app.asar.unpacked/cli/bin/codebuddy; do
  [[ -n "$bin" ]] && break
  [[ -x "$candidate" ]] && bin="$candidate"
done
[[ -n "$bin" ]] || { echo "找不到 WorkBuddy 自带的 codebuddy" >&2; exit 127; }

here="$(cd "$(dirname "$0")" && pwd)"
exec "$here/resume-here.sh" "$session" "$HOME/.workbuddy:$HOME/.codebuddy" -- \
  bash -c 'CODEBUDDY_CONFIG_DIR="$BENCH_CONFIG_DIR" exec "$0" "$@"' \
  "$bin" -r "$session" --allowedTools mcp__bench --output-format text -p "$@"
