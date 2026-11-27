#!/usr/bin/env bash
# Usage: agy-wake.sh CONVERSATION_ID [AGY ARGS...]
# Wake an Antigravity conversation with the agy CLI. agy only reads its own
# store (~/.gemini/antigravity-cli); a conversation started in the Antigravity
# desktop app lives in ~/.gemini/antigravity. For one of those, clone it into
# agy's store under the same id first (same file format, so it resumes with
# its whole history), and clone it again whenever the desktop side has grown
# since the last clone. Turns the room woke in the clone are lost then; the
# room's catch-up covers what was said in the room.
set -euo pipefail

id="${1:?缺少 conversation id}"
shift

desk="$HOME/.gemini/antigravity"
cli="$HOME/.gemini/antigravity-cli"
src="$desk/conversations/$id.db"

py=""
for candidate in python3 python; do
  if command -v "$candidate" >/dev/null 2>&1 && "$candidate" -c "import sys; sys.exit(0)" >/dev/null 2>&1; then
    py="$candidate"
    break
  fi
done

py_path() {
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -m "$1"
  else
    printf '%s' "$1"
  fi
}

export MSYS_NO_PATHCONV=1
agy_bin="$(command -v agy || true)"
[[ -n "$agy_bin" ]] || { echo "找不到 agy 命令" >&2; exit 127; }

# Desktop bridge (agy.mjs) talks directly to ~/.gemini/antigravity, so cloning
# into ~/.gemini/antigravity-cli is unnecessary and risks SQLite locking on Windows.
desktop_bridge=0
if [[ -f "${agy_bin}.mjs" ]] && grep -q "agentapi" "${agy_bin}.mjs" 2>/dev/null; then
  desktop_bridge=1
fi

cloned_now=""
if [[ $desktop_bridge -eq 0 && -f "$src" && -n "$py" ]]; then
  mkdir -p "$cli/conversations" "$cli/brain"
  py_src="$(py_path "$src")"
  py_dst="$(py_path "$cli/conversations/$id.db")"
  py_mark="$(py_path "$cli/conversations/$id.bench-clone")"
  cloned_now="$("$py" -I - "$py_src" "$py_dst" "$py_mark" <<'PY'
import os, sqlite3, sys

src, dst, mark = sys.argv[1:4]
source = sqlite3.connect(f"file:{src}?mode=ro", uri=True)
steps = source.execute("select count(*) from steps").fetchone()[0]
try:
    cloned = int(open(mark).read().strip() or -1)
except (OSError, ValueError):
    cloned = -1
# Only when it's missing or the desktop conversation has new steps.
if os.path.exists(dst) and cloned == steps:
    sys.exit(0)
for leftover in (dst + "-wal", dst + "-shm"):
    try:
        os.remove(leftover)
    except FileNotFoundError:
        pass
target = sqlite3.connect(dst)
source.backup(target)
target.close()
source.close()
with open(mark, "w") as out:
    out.write(str(steps))
print("CLONED")
PY
)"
  if [[ "$cloned_now" == "CLONED" && -d "$desk/brain/$id" ]]; then
    rm -rf "$cli/brain/$id"
    cp -r "$desk/brain/$id" "$cli/brain/$id"
  fi
fi

# Wake it with the permissions it has in the desktop app, so a woken turn can
# do what it does there. agy doesn't read the desktop's preset itself (its log
# says "no shared config permissions"), and in print mode a denied tool ends
# the whole turn ("The stream was interrupted") instead of letting it answer.
perm=()
preset=""
if [[ -n "$py" ]]; then
  preset="$("$py" -I -c 'import json, os, sys
try:
    print(json.load(open(os.path.expanduser("~/.gemini/config/config.json"))).get("userSettings", {}).get("permissionPreset", ""))
except Exception:
    pass' 2>/dev/null || true)"
fi
if [[ "$preset" == "AGENT_PERMISSION_PRESET_TURBO" ]]; then
  perm=(--dangerously-skip-permissions)
fi

# Honor the seat's bench workdir when woken from the room's process cwd.
if [[ -n "${BENCH_NEW_DIR:-}" && -d "$BENCH_NEW_DIR" ]]; then
  cd "$BENCH_NEW_DIR"
fi

# Only pass BENCH_PROMPT_FILE verbatim when the resolved agy CLI supports it;
# standalone Linux CLIs that don't read BENCH_PROMPT_FILE still get file contents.
if [[ -n "${BENCH_PROMPT_FILE:-}" && -f "$BENCH_PROMPT_FILE" ]] && ! grep -q "BENCH_PROMPT_FILE" "$agy_bin" "${agy_bin}.mjs" 2>/dev/null; then
  prompt_text="$(cat "$BENCH_PROMPT_FILE")"
  replaced=()
  for arg in "$@"; do
    if [[ "$arg" == "@BENCH_PROMPT_FILE" ]]; then
      replaced+=("$prompt_text")
    else
      replaced+=("$arg")
    fi
  done
  exec "$agy_bin" --conversation "$id" "${perm[@]}" "${replaced[@]}"
fi
exec "$agy_bin" --conversation "$id" "${perm[@]}" "$@"
