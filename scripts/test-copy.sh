#!/usr/bin/env bash
# Linux: manage a disposable copy in the caller's network/PID namespace.
# Usage: test-copy.sh up NAME PORT [keep] | down NAME | list
set -euo pipefail
umask 077
command -v node >/dev/null || { echo "需要 Node 22.13+，请把 node 加入 PATH" >&2; exit 1; }
src=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
space=$(readlink /proc/self/ns/net | tr -cd '0-9')-$(readlink /proc/self/ns/pid | tr -cd '0-9')
root=${BENCH_COPY_ROOT:-$src/.bench/test-copies}
base=$(realpath -m "$root")
root=$base/$space
cmd=${1:-list}
name=${2:-}
start_time() { sed 's/.*) //' "/proc/$1/stat" 2>/dev/null | awk '{print $20}'; }
# Exited but not reaped counts as gone: in an isolated session PID 1 is the
# agent itself, which leaves its orphans as zombies, and kill -0 still finds them.
state() { sed 's/.*) //' "/proc/$1/stat" 2>/dev/null | awk '{print $1}'; }
alive() { [[ -f "$dir/process" ]] && read -r pid stamp < "$dir/process" && [[ "$stamp" == "$(start_time "$pid")" ]] && [[ "$(readlink "/proc/$pid/cwd")" == "$dir/copy" ]] && [[ "$(state "$pid")" != Z ]] && kill -0 "$pid" 2>/dev/null; }
case "$cmd" in
list)
  echo "当前空间 $space"
  for dir in "$root"/*; do
    [[ -d "$dir" ]] || continue
    status=stopped; if alive; then status=running; fi
    age=""; [[ $(($(date +%s) - $(stat -c %Y "$dir/process" 2>/dev/null || stat -c %Y "$dir"))) -lt 86400 ]] || age="一天未启动"
    echo "${dir##*/} $status $age $(cat "$dir/port") $dir"
  done
  for old in "$base"/*; do
    [[ -d "$old" && "$old" != "$root" ]] || continue
    echo "其他空间（可能已过期，不能在本空间按 PID 停止）：$old"
  done
  exit;;
up|down) [[ "$name" =~ ^[a-z0-9][a-z0-9-]*$ ]] || { echo '名字只用小写字母、数字、短横线' >&2; exit 2; };;
*) echo '用法：test-copy.sh up NAME PORT [keep] | down NAME | list' >&2; exit 2;;
esac
dir=$root/$name
mkdir -p "$root"
# Serialize operations on this name, including readiness checks.
exec 9>"$root/.$name.lock"
flock -n 9 || { echo '这份副本正在起停' >&2; exit 1; }
if [[ "$cmd" == down ]]; then
  [[ -d "$dir" ]] || { echo '副本不存在'; exit; }
  if alive; then
    kill -TERM -- "-$pid"
    for ((i=0;i<50;i++)); do alive || break; sleep .1; done
    if alive; then echo '服务还未退出，保留副本，请稍后重试' >&2; exit 1; fi
  fi
  rm -rf -- "$dir"
  echo "已停止并删除 $name"; exit
fi
port=${3:-}
[[ "$port" =~ ^44[0-9][0-9]$ ]] || { echo '测试端口只用 4400–4499，不能用正式房间的 4399' >&2; exit 2; }
keep=${4:-}
[[ -z "$keep" || "$keep" == keep ]] || { echo '第四个参数只能是 keep' >&2; exit 2; }
if [[ "$keep" == keep ]]; then
  [[ -d "$dir/copy" && "$(cat "$dir/port")" == "$port" ]] || { echo 'keep 需要同名同端口的已有副本' >&2; exit 1; }
  if alive; then
    kill -TERM -- "-$pid"
    for ((i=0;i<50;i++)); do alive || break; sleep .1; done
    if alive; then echo '服务还没退出，不能重启' >&2; exit 1; fi
  fi
else
  [[ ! -e "$dir" ]] || { echo '同名副本已存在；用 keep 重启，或先 down 删除' >&2; exit 1; }
fi
listeners=$(ss -H -ltn "sport = :$port") || { echo "无法查询当前网络空间的端口" >&2; exit 1; }
if [[ -n "$listeners" ]]; then echo '端口已占用' >&2; exit 1; fi
if [[ "$keep" != keep ]]; then
mkdir -p "$dir/copy" "$dir/data" "$dir/state"
printf '%s\n' "$port" > "$dir/port"
# No live data, credentials, local env files or inherited room identity.
for item in app components lib public scripts types agents.json instrumentation.ts next.config.ts package.json package-lock.json postcss.config.mjs tsconfig.json; do
  [[ ! -e "$src/$item" ]] || cp -a "$src/$item" "$dir/copy/"
done
cp -al "$src/node_modules" "$dir/copy/node_modules"
fi
# Check only the copy, never emit cache/type files into the live workspace.
if ! (cd "$dir/copy" && node node_modules/next/dist/bin/next typegen && node node_modules/typescript/bin/tsc --noEmit --incremental false) >"$dir/tsc.log" 2>&1; then
  echo "副本类型检查没过：$dir/tsc.log" >&2; exit 1
fi
(
  cd "$dir/copy"
  for key in $(compgen -e); do
    # BENCH_RETRY_MS / BENCH_GIST_MS / BENCH_CONTINUE_* / BENCH_WATCH_* / BENCH_CHECK_* only shorten test waits.
    # BENCH_FIRST_KINDS / BENCH_FIRST_PARENT stand in for the installed clients and the desktop (lib/first-open.ts).
    case "$key" in HOME|PATH|USER|LOGNAME|LANG|LC_*|TERM|http_proxy|https_proxy|all_proxy|no_proxy|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|BENCH_RETRY_MS|BENCH_GIST_MS|BENCH_FIRST_KINDS|BENCH_FIRST_PARENT|BENCH_CONTINUE_*|BENCH_WATCH_*|BENCH_CHECK_*|BENCH_BACKUP_*) ;;
      *) unset "$key";;
    esac
  done
  export BENCH_DATA_DIR="$dir/data" XDG_STATE_HOME="$dir/state" BENCH_URL="http://127.0.0.1:$port" NEXT_TELEMETRY_DISABLED=1
  # The desk hears of check verdicts after 3 quiet minutes in the real room;
  # test-room waits seconds for it.
  export BENCH_CHECK_QUIET_MS="${BENCH_CHECK_QUIET_MS:-300}"
  exec setsid node node_modules/next/dist/bin/next dev -p "$port" -H 127.0.0.1
) </dev/null >"$dir/dev.log" 2>&1 9>&- &
pid=$!
printf '%s %s\n' "$pid" "$(start_time "$pid")" > "$dir/process"
for ((i=0;i<90;i++)); do
  if ! alive; then echo "启动失败：$dir/dev.log" >&2; exit 1; fi
  if curl --noproxy '*' -fsS --max-time 2 "http://127.0.0.1:$port/api/v1/projects" >/dev/null 2>&1; then
    echo "副本：http://127.0.0.1:$port"
    echo "目录：$dir"
    echo "只用副本自己的口令 $dir/data/human-key，禁止使用正式房间口令。"
    echo "测试：BENCH_URL=http://127.0.0.1:$port BENCH_KEY_FILE=$dir/data/human-key node $dir/copy/scripts/test-room.mjs"
    exit
  fi
  sleep 1
done
echo "等待启动超时；日志 $dir/dev.log；用 down $name 停止并清理" >&2
exit 1
