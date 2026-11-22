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
if [[ -n "${BENCH_PROMPT_FILE:-}" && -f "$BENCH_PROMPT_FILE" ]]; then
  text="$(cat "$BENCH_PROMPT_FILE")"
fi
[[ "$id" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "thread id 不对：$id" >&2; exit 2; }
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
here_node="$here"
if command -v cygpath >/dev/null 2>&1; then
  here_node="$(cygpath -m "$here")"
fi
node_bin="$(command -v node || true)"
[[ -n "$node_bin" ]] || node_bin=/usr/local/nodejs/bin/node
bin="${CODEX_BIN:-}"
if [[ -z "$bin" ]]; then
  bin="$(command -v codex || true)"
fi
# No codex on PATH: the Codex desktop app bundles one.
if [[ -z "$bin" && -x "$node_bin" ]]; then
  bin="$("$node_bin" "$here_node/codex-bin.mjs" --bundled 2>/dev/null || true)"
fi
if [[ -n "$bin" ]] && command -v cygpath >/dev/null 2>&1 && [[ -e "$bin" ]]; then
  bin="$(cygpath -m "$bin")"
fi

# The turn runs through `codex app-server` (codex-app.mjs), so messages that
# call the seat while it works go into the same turn with turn/steer. It prints
# the same events as `codex exec --json`. BENCH_CODEX_EXEC=1 goes back to
# plain `codex exec`, which only hears them after the turn.
if [[ "${BENCH_CODEX_EXEC:-}" != "1" ]] && [[ -x "$node_bin" ]]; then
  if [[ -n "${BENCH_PROMPT_FILE:-}" && -f "$BENCH_PROMPT_FILE" ]]; then
    CODEX_BIN="${bin:-${CODEX_BIN:-}}" exec "$node_bin" "$here_node/codex-app.mjs" "$id" </dev/null
  else
    CODEX_BIN="${bin:-${CODEX_BIN:-}}" exec "$node_bin" "$here_node/codex-app.mjs" "$id" "$text" </dev/null
  fi
fi

# Plain `codex exec` would send "/compact" as a message; only the app-server
# path above can compact (scripts/codex-app.mjs).
if [[ "$text" == "/compact" ]]; then
  echo "压缩上下文要走 codex app-server，BENCH_CODEX_EXEC=1 时不行" >&2
  exit 2
fi
if [[ "$text" == "/goal" || "$text" == "/goal "* ]]; then
  echo "设目标要走 codex app-server，BENCH_CODEX_EXEC=1 时不行" >&2
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
# Nobody can be asked on this path (only codex-app.mjs puts approvals on the
# page), so it may write in its workspace and nothing more.
pick+=(-c 'sandbox_mode="workspace-write"' -c 'approval_policy="never"')
[[ -n "$bin" ]] || { echo "没找到 codex，先装 Codex 的命令行或桌面端" >&2; exit 127; }
export MSYS_NO_PATHCONV=1
if [[ -n "${BENCH_PROMPT_FILE:-}" && -f "$BENCH_PROMPT_FILE" && ${#text} -gt 24000 ]]; then
  exec "$bin" exec resume --skip-git-repo-check --json "${pick[@]}" \
    -c "mcp_servers.bench.env.BENCH_UUID=\"$id\"" \
    -c 'mcp_servers.bench.default_tools_approval_mode="approve"' \
    "$id" - < "$BENCH_PROMPT_FILE"
fi
exec "$bin" exec resume --skip-git-repo-check --json "${pick[@]}" \
  -c "mcp_servers.bench.env.BENCH_UUID=\"$id\"" \
  -c 'mcp_servers.bench.default_tools_approval_mode="approve"' \
  "$id" "$text" < /dev/null
