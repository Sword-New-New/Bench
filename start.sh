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

if [[ ! -d node_modules ]]; then
  npm install || pause_exit
fi

echo "房间地址 $URL"
(sleep 4 && xdg-open "$URL" >/dev/null 2>&1) &
exec npx next dev -p 4399 -H 127.0.0.1
