#!/usr/bin/env bash
cd "$(dirname "$0")" || exit 1

URL="http://127.0.0.1:4399"

pause_exit() {
  if [[ -t 0 ]]; then
    read -r -p "按回车退出..."
  fi
  exit 1
}

if ! command -v npm >/dev/null 2>&1; then
  for candidate in "${NODE_HOME:-}/bin" /usr/local/nodejs/bin; do
    if [[ -n "$candidate" && -x "$candidate/npm" ]]; then
      export PATH="$candidate:$PATH"
      break
    fi
  done
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "先安装 Node.js：https://nodejs.org"
  pause_exit
fi

# Too old a Node dies later on an import error; say it here in a sentence.
node scripts/check-node.mjs || pause_exit

# A room already running here: open it, don't start a second one. 4399 is
# fixed because every client's MCP bridge talks to it; a room on another port
# would be one nobody reaches.
if command -v curl >/dev/null 2>&1; then
  if curl -sf --max-time 2 "$URL/api/v1/user" 2>/dev/null | grep -q '"name"'; then
    echo "房间已经在运行（$URL），直接打开，不再启动第二个。"
    node scripts/open-room.mjs
    exit 0
  fi
  if curl -s -o /dev/null --max-time 2 "$URL/" 2>/dev/null; then
    echo "4399 端口被别的程序占着，不是并坐。先关掉它再运行 ./start.sh。"
    pause_exit
  fi
fi

if [[ ! -d node_modules ]]; then
  npm install || pause_exit
fi

echo "房间地址 $URL（用带口令的链接打开）"
(sleep 4 && node scripts/open-room.mjs) &
exec npx next dev -p 4399 -H 127.0.0.1
