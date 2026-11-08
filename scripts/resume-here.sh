#!/usr/bin/env bash
# Usage: resume-here.sh SESSION_ID CONFIG_DIR[:CONFIG_DIR...] -- COMMAND [ARGS...]
# For agents that, like Claude Code, keep sessions as
# CONFIG_DIR/projects/<folder>/<id>.jsonl and only find a session from the
# folder it was started in (Qoder, CodeBuddy, WorkBuddy). Finds the session
# file, cds to the "cwd" it records, then runs COMMAND. The config dir that
# holds the session is exported as BENCH_CONFIG_DIR for the command to use.
set -euo pipefail

session="${1:?缺少 session id}"
dirs="${2:?缺少配置目录}"
shift 2
[[ "${1:-}" == "--" ]] && shift
[[ $# -gt 0 ]] || { echo "缺少要运行的命令" >&2; exit 2; }

file=""
IFS=: read -ra roots <<<"$dirs"
for root in "${roots[@]}"; do
  root="${root/#\~/$HOME}"
  file="$(ls "$root"/projects/*/"$session".jsonl 2>/dev/null | head -1 || true)"
  if [[ -n "$file" ]]; then
    export BENCH_CONFIG_DIR="$root"
    break
  fi
done
if [[ -z "$file" ]]; then
  echo "在 $dirs 里找不到会话 $session" >&2
  exit 2
fi

dir="$(grep -m1 -o '"cwd":"[^"]*"' "$file" | head -1 | sed 's/^"cwd":"//; s/"$//' || true)"
if [[ -n "$dir" && -d "$dir" ]]; then
  cd "$dir"
fi

exec "$@"
