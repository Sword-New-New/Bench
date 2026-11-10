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

# Plain `codex exec` would send "/compact" as a message; only the app-server
# path above can compact (scripts/codex-app.mjs).
if [[ "$text" == "/compact" ]]; then
  echo "压缩上下文要走 codex app-server，BENCH_CODEX_EXEC=1 时不行" >&2
  exit 2
fi

# --json: one event per line, which the room turns into the 「过程」 panel.
pick=()
if [[ -n "${BENCH_MODEL:-}" ]]; then
  pick=(-m "$BENCH_MODEL")
fi
if [[ -n "${BENCH_EFFORT:-}" ]]; then
  pick+=(-c "model_reasoning_effort=\"$BENCH_EFFORT\"")
fi
# Where its context compacts by itself, if the user set one (lib/context.ts).
if [[ "${BENCH_COMPACT_WINDOW:-}" =~ ^[0-9]+$ ]]; then
  pick+=(-c "model_auto_compact_token_limit=$BENCH_COMPACT_WINDOW")
fi
exec "$bin" exec resume --skip-git-repo-check --json "${pick[@]}" \
  -c "mcp_servers.bench.env.BENCH_UUID=\"$id\"" \
  -c 'mcp_servers.bench.default_tools_approval_mode="approve"' \
  "$id" "$text" < /dev/null
