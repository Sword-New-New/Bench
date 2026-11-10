#!/usr/bin/env bash
# Usage: terminal.sh KIND SESSION_ID
# Open a seat's session in its client's own interactive screen, from the folder
# the session belongs to. The room runs this in a pseudo-terminal
# (lib/terminal.ts) and shows it on the page, where the user can watch and type.
# Unlike the wake scripts nothing is passed in: what the room has to say is
# typed into the screen as if the user typed it.
set -euo pipefail

kind="${1:?缺少客户端种类}"
session="${2:?缺少 session id}"
[[ "$session" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "session id 不对：$session" >&2; exit 2; }

model=()
case "$kind" in
  claude)
    bin="$(command -v claude || true)"
    if [[ -z "$bin" ]]; then
      bin="$(ls -d "$HOME"/.config/Claude/claude-code/*/*/claude 2>/dev/null | sort -V | tail -1 || true)"
    fi
    [[ -n "$bin" && -x "$bin" ]] || { echo "找不到 claude 可执行文件" >&2; exit 127; }
    [[ -n "${BENCH_MODEL:-}" ]] && model=(--model "$BENCH_MODEL")
    [[ -n "${BENCH_EFFORT:-}" ]] && model+=(--effort "$BENCH_EFFORT")
    # Where its context compacts by itself, if the user set one; beats settings files.
    [[ "${BENCH_COMPACT_WINDOW:-}" =~ ^[0-9]+$ ]] && export CLAUDE_CODE_AUTO_COMPACT_WINDOW="$BENCH_COMPACT_WINDOW"
    file="$(ls "$HOME"/.claude/projects/*/"$session".jsonl 2>/dev/null | head -1 || true)"
    if [[ -z "$file" ]]; then
      # A session the room created and never woke: start it under that id.
      [[ -n "${BENCH_NEW_DIR:-}" ]] || { echo "找不到 Claude Code 会话 $session" >&2; exit 2; }
      cd "$BENCH_NEW_DIR"
      exec "$bin" --session-id "$session" "${model[@]}"
    fi
    dir="$(grep -m1 -o '"cwd":"[^"]*"' "$file" | head -1 | sed 's/^"cwd":"//; s/"$//' || true)"
    [[ -n "$dir" && -d "$dir" ]] && cd "$dir"
    # Its own window's permission prompts show up right here, so nothing is
    # routed to the page the way woken turns do.
    exec "$bin" --resume "$session" "${model[@]}"
    ;;
  codex)
    bin="$(command -v codex || echo /usr/lib/chatgpt/resources/codex)"
    [[ -x "$bin" ]] || { echo "找不到 codex 可执行文件" >&2; exit 127; }
    [[ -n "${BENCH_MODEL:-}" ]] && model=(-m "$BENCH_MODEL")
    [[ -n "${BENCH_EFFORT:-}" ]] && model+=(-c "model_reasoning_effort=\"$BENCH_EFFORT\"")
    [[ "${BENCH_COMPACT_WINDOW:-}" =~ ^[0-9]+$ ]] && model+=(-c "model_auto_compact_token_limit=$BENCH_COMPACT_WINDOW")
    file="$(find "$HOME/.codex/sessions" -name "rollout-*-$session.jsonl" 2>/dev/null | head -1 || true)"
    if [[ -n "$file" ]]; then
      dir="$(head -1 "$file" | grep -o '"cwd":"[^"]*"' | head -1 | sed 's/^"cwd":"//; s/"$//' || true)"
      [[ -n "$dir" && -d "$dir" ]] && cd "$dir"
    elif [[ -n "${BENCH_NEW_DIR:-}" ]]; then
      cd "$BENCH_NEW_DIR"
    fi
    # Codex doesn't tell its MCP server the thread id; the bench tools need it.
    exec "$bin" resume "${model[@]}" -c "mcp_servers.bench.env.BENCH_UUID=\"$session\"" "$session"
    ;;
  *)
    echo "$kind 还不能在房间里开终端" >&2
    exit 2
    ;;
esac
