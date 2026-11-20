#!/usr/bin/env bash
# Open the shared room. Start the dev server first when nothing is listening.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
URL="http://127.0.0.1:4399"
SESSION="bench-dev"
BACKGROUND=0
for arg in "$@"; do
  if [[ "$arg" == "--background" ]]; then
    BACKGROUND=1
  fi
done

# Launched from the app menu or desktop, PATH has none of ~/.bashrc's additions.
if ! command -v npm >/dev/null 2>&1 && [[ -x /usr/local/nodejs/bin/npm ]]; then
  export PATH="/usr/local/nodejs/bin:$PATH"
fi
if ! command -v npm >/dev/null 2>&1; then
  nvm_node="$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | sort -V | tail -1 || true)"
  if [[ -n "${nvm_node}" ]]; then
    export PATH="${nvm_node}:$PATH"
  fi
fi

up() {
  curl -sf -o /dev/null --max-time 2 "$URL/"
}

# With the user's key in the address (scripts/open-room.mjs, lib/human.ts).
open_room() {
  if [[ "$BACKGROUND" -eq 1 ]]; then
    return 0
  fi
  node "$ROOT/scripts/open-room.mjs" >/dev/null 2>&1 || true
}

if up; then
  open_room
  exit 0
fi

fail_notify() {
  echo "$1" >&2
  if command -v notify-send >/dev/null 2>&1; then
    notify-send "并坐" "$2" || true
  fi
  exit 1
}

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  fail_notify "找不到 Node.js 或 npm，请先安装 Node.js（22.13 或以上）：https://nodejs.org" "找不到 Node.js，请安装 22.13 或更新版本。"
fi

if ! node "$ROOT/scripts/check-node.mjs"; then
  fail_notify "Node.js 版本不够，请升级到 22.13 或以上。" "Node.js 版本太旧，需要 22.13 或更新版本。"
fi

if ! node "$ROOT/scripts/ensure-deps.mjs" --root "$ROOT"; then
  fail_notify "依赖安装失败，请打开终端在项目目录运行 npm install 查看具体报错。" "依赖安装失败，请在项目目录运行 npm install 看报错。"
fi

if ! command -v tmux >/dev/null 2>&1; then
  fail_notify "缺少 tmux，无法用桌面图标在后台启动并坐。请先安装 tmux（如 Ubuntu/Debian: sudo apt install tmux），或直接在终端运行 ./start.sh。" "缺少 tmux，请先安装 tmux 或在终端运行 ./start.sh。"
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
