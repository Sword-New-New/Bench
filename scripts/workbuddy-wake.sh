#!/usr/bin/env bash
# Usage: workbuddy-wake.sh SESSION_ID MESSAGE
# WorkBuddy is a desktop app with no CLI of its own, but it ships the
# CodeBuddy Code CLI and keeps its sessions in ~/.workbuddy (some in
# ~/.codebuddy). Resume the session with that CLI, pointed at whichever
# config dir holds it.
#
# The bundled CLI only gets a login when the desktop app starts it, so from
# here it says "Authentication required". The full CLI (npm i -g
# @tencent-ai/codebuddy-code, then `codebuddy` and /login once) keeps its own
# login in ~/.local/share/CodeBuddyExtension/Data/Public/auth, apart from the
# desktop's, and is used first when installed.
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

# The permissions the session has in the desktop app (its 权限 setting, kept
# per session in workbuddy.db). Without them a print-mode run can't ask, so
# every command needing approval is refused outright.
mode="$(python3 -I - "$HOME/.workbuddy/workbuddy.db" "$session" <<'PY' 2>/dev/null || true
import sqlite3, sys
db = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
row = db.execute("select permission_mode from sessions where id = ?", (sys.argv[2],)).fetchone()
print(row[0] if row and row[0] else "")
PY
)"
perm=()
case "$mode" in
  fullAccess | bypassPermissions | acceptEdits | plan | default) perm=(--permission-mode "$mode") ;;
esac

here="$(cd "$(dirname "$0")" && pwd)"
exec "$here/resume-here.sh" "$session" "$HOME/.workbuddy:$HOME/.codebuddy" -- \
  bash -c 'CODEBUDDY_CONFIG_DIR="$BENCH_CONFIG_DIR" exec "$0" "$@"' \
  "$bin" -r "$session" "${perm[@]}" --allowedTools mcp__bench --output-format text -p "$@"
