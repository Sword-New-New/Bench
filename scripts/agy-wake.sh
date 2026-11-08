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

if [[ -f "$src" ]]; then
  mkdir -p "$cli/conversations" "$cli/brain"
  python3 -I - "$src" "$cli/conversations/$id.db" "$cli/conversations/$id.bench-clone" <<'PY'
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
PY
  if [[ -d "$desk/brain/$id" ]]; then
    cp -r "$desk/brain/$id" "$cli/brain/"
  fi
fi

exec agy --conversation "$id" "$@"
