#!/usr/bin/env bash
# Open the shared room. Start the dev server first when nothing is listening.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
URL="http://127.0.0.1:43123"
SESSION="bench-dev"

if ! command -v npm >/dev/null 2>&1; then
  nvm_node="$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | sort -V | tail -1 || true)"
  if [[ -n "${nvm_node}" ]]; then
    export PATH="${nvm_node}:$PATH"
  fi
fi

up() {
  curl -sf -o /dev/null --max-time 2 "$URL/"
}

open_room() {
  if command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$URL" >/dev/null 2>&1 || true
  elif command -v google-chrome >/dev/null 2>&1; then
    google-chrome "$URL" >/dev/null 2>&1 || true
  fi
}

if up; then
  open_room
  exit 0
fi

tmux_cmd=(tmux)
if [[ -f /exec-daemon/tmux.portal.conf ]]; then
  tmux_cmd=(tmux -f /exec-daemon/tmux.portal.conf)
fi

if "${tmux_cmd[@]}" has-session -t "=$SESSION" 2>/dev/null; then
  "${tmux_cmd[@]}" send-keys -t "$SESSION:0.0" "cd $(printf '%q' "$ROOT") && npm run dev" C-m
else
  "${tmux_cmd[@]}" new-session -d -s "$SESSION" -c "$ROOT" -- npm run dev
fi

for _ in $(seq 1 40); do
  if up; then
    open_room
    exit 0
  fi
  sleep 0.5
done

if command -v notify-send >/dev/null 2>&1; then
  notify-send "并坐" "房间没有打开。在项目目录里运行 npm run dev 看看报错。" || true
fi
exit 1
