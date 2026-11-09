#!/usr/bin/env bash
# Usage: codex-wake.sh <thread-id> <text>
# Run one turn of a Codex session and print its answer.
# `codex queue` only queues the message until the session is next opened, so
# it never wakes anyone; `codex exec resume` runs the turn now. Codex starts a
# fresh MCP server for the turn and does not tell it the thread id, so pass it
# as BENCH_UUID, and pre-approve the bench tools since nobody is there to click.
set -euo pipefail

id="${1:-}"
text="${2:-}"
[[ "$id" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "thread id 不对：$id" >&2; exit 2; }
bin="$(command -v codex || echo /usr/lib/chatgpt/resources/codex)"

# The turn runs through `codex app-server` (codex-app.mjs), so messages that
# call the seat while it works go into the same turn with turn/steer. It prints
# the same events as `codex exec --json`. BENCH_CODEX_EXEC=1 goes back to
# plain `codex exec`, which only hears them after the turn.
if [[ "${BENCH_CODEX_EXEC:-}" != "1" ]] && command -v node >/dev/null; then
  CODEX_BIN="$bin" exec node "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/codex-app.mjs" "$id" "$text" < /dev/null
fi

# --json: one event per line, which the room turns into the 「过程」 panel.
exec "$bin" exec resume --skip-git-repo-check --json \
  -c "mcp_servers.bench.env.BENCH_UUID=\"$id\"" \
  -c 'mcp_servers.bench.default_tools_approval_mode="approve"' \
  "$id" "$text" < /dev/null
