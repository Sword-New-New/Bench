#!/usr/bin/env bash
# Usage: register-mcp.sh <kind> [<kind>...]   (kinds: see lib/kinds.ts)
# Register the 并坐 MCP server (scripts/bench-mcp.mjs) with agent clients,
# for this user. Running it again replaces the old entry.
set -euo pipefail

# Several kinds: one run each, and carry on past one that fails.
if [[ $# -gt 1 ]]; then
  failed=0
  for each in "$@"; do "$0" "$each" || failed=1; done
  exit "$failed"
fi

kind="${1:-}"
root="$(cd "$(dirname "$0")/.." && pwd)"
script="$root/scripts/bench-mcp.mjs"
node="$(command -v node || true)"
[[ -n "$node" ]] || node=/usr/local/nodejs/bin/node
[[ -x "$node" ]] || { echo "找不到 node" >&2; exit 1; }

# Merge the bench entry into a JSON config: merge_json FILE [TOP_JSON] [STYLE] [SERVER_JSON].
merge_json() {
  "$node" "$root/scripts/merge-mcp.mjs" "$1" "${3:-mcpServers}" "$kind" "${2:-{\}}" "${4:-{\}}"
}

case "$kind" in
  claude)
    bin="$(command -v claude || ls -d "$HOME"/.config/Claude/claude-code/*/*/claude 2>/dev/null | sort -V | tail -1 || true)"
    [[ -n "$bin" ]] || { echo "找不到 claude 可执行文件" >&2; exit 1; }
    "$bin" mcp remove --scope user bench >/dev/null 2>&1 || true
    "$bin" mcp add --scope user bench -- "$node" "$script" --agent claude
    ;;
  codex)
    bin="$(command -v codex || echo /usr/lib/chatgpt/resources/codex)"
    "$bin" mcp remove bench >/dev/null 2>&1 || true
    "$bin" mcp add bench -- "$node" "$script" --agent codex
    # bench_wait blocks up to ~9 minutes; Codex's default tool timeout is 60 s.
    "$node" -e '
      const fs = require("node:fs")
      const file = process.argv[1]
      const text = fs.readFileSync(file, "utf8")
      const next = text.replace(/(\[mcp_servers\.bench\]\n(?:(?!\[)[^\n]*\n)*)/, (block) =>
        /tool_timeout_sec/.test(block) ? block : block.replace(/\n*$/, "\ntool_timeout_sec = 600\n\n"))
      fs.writeFileSync(file, next)
    ' "${CODEX_HOME:-$HOME/.codex}/config.toml"
    ;;
  antigravity)
    bin="$(command -v agy || echo "$HOME/.local/bin/agy")"
    "$bin" mcp add bench "$node" "$script" --agent antigravity
    ;;
  cursor)
    # Cursor reads ~/.cursor/mcp.json; merge our entry, keep everything else.
    "$node" -e '
      const fs = require("node:fs")
      const [file, node, script] = process.argv.slice(1)
      let config = {}
      try { config = JSON.parse(fs.readFileSync(file, "utf8")) } catch {}
      config.mcpServers = { ...(config.mcpServers || {}), bench: { command: node, args: [script, "--agent", "cursor"] } }
      fs.mkdirSync(require("node:path").dirname(file), { recursive: true })
      fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n")
      console.log("已写入 " + file)
    ' "$HOME/.cursor/mcp.json" "$node" "$script"
    ;;
  dsh)
    # DeepSeek Harness loads MCP servers through its dsh-mcp-client plugin,
    # one patch entry per profile: web for the app, headless for dsh-agent.
    dsh_home="${DSH_HOME:-$HOME/.dsh}"
    for profile in web headless; do
      patch="$dsh_home/profiles/$profile/cordis.patch.yml"
      [[ -f "$patch" ]] || { echo "跳过 $profile：没有 $patch"; continue; }
      if grep -q "id: mcp-bench$" "$patch"; then
        echo "$profile 已经有 bench，跳过"
        continue
      fi
      cp "$patch" "$patch.bak-bench-$(date +%Y%m%d%H%M%S)"
      # An empty layer is written as a literal `[]`; a list item can't follow it.
      sed -i '/^\[\][[:space:]]*$/d' "$patch"
      [[ -z "$(tail -c1 "$patch")" ]] || echo >> "$patch"
      # A top-level row only overrides an existing id; a new row goes in an insert list.
      cat >> "$patch" <<EOF
- insert:
    - id: mcp-bench
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: bench
        transport: stdio
        command: "$node"
        args: ["$script", "--agent", "dsh"]
        toolCallTimeoutMs: 600000
EOF
      echo "已写入 $patch"
    done
    ;;
  qoder)
    # The `qoder` on PATH may be the desktop app; only qodercli is surely the CLI.
    if command -v qodercli >/dev/null; then
      qodercli mcp remove -s user bench >/dev/null 2>&1 || true
      qodercli mcp add -s user bench -- "$node" "$script" --agent qoder
    else
      merge_json "$HOME/.qoder/settings.json" '{"permissions":{"allow":["mcp__bench__*"]}}'
    fi
    ;;
  codebuddy)
    if command -v codebuddy >/dev/null; then
      codebuddy mcp remove -s user bench >/dev/null 2>&1 || true
      codebuddy mcp add -s user bench -- "$node" "$script" --agent codebuddy
    else
      merge_json "$HOME/.codebuddy/.mcp.json"
    fi
    ;;
  workbuddy)
    # WorkBuddy reads MCP from ~/.workbuddy/mcp.json (or its 自定义连接器 page).
    merge_json "$HOME/.workbuddy/mcp.json"
    ;;
  qwen)
    if command -v qwen >/dev/null; then
      qwen mcp remove -s user bench >/dev/null 2>&1 || true
      qwen mcp add -s user bench "$node" "$script" --agent qwen
    else
      merge_json "$HOME/.qwen/settings.json"
    fi
    ;;
  kimi)
    merge_json "$HOME/.kimi-code/mcp.json"
    ;;
  devin)
    command -v devin >/dev/null || { echo "找不到 devin" >&2; exit 1; }
    devin mcp remove bench -s user >/dev/null 2>&1 || true
    devin mcp add bench -s user -- "$node" "$script" --agent devin
    ;;
  kiro)
    merge_json "$HOME/.kiro/settings/mcp.json"
    ;;
  gemini)
    command -v gemini >/dev/null || { echo "找不到 gemini（npm i -g @google/gemini-cli）" >&2; exit 1; }
    gemini mcp remove -s user bench >/dev/null 2>&1 || true
    gemini mcp add -s user --trust bench "$node" "$script" --agent gemini
    ;;
  copilot)
    # /usr/bin/copilot can be a stub that only says the real CLI is missing.
    if copilot --version >/dev/null 2>&1; then
      copilot mcp remove bench >/dev/null 2>&1 || true
      copilot mcp add bench --tools '*' -- "$node" "$script" --agent copilot
    else
      merge_json "${COPILOT_HOME:-$HOME/.copilot}/mcp-config.json" '{}' mcpServers '{"tools":["*"]}'
    fi
    ;;
  opencode)
    merge_json "$HOME/.config/opencode/opencode.json" '{"permission":{"bench_*":"allow"}}' opencode
    ;;
  kilo)
    merge_json "$HOME/.config/kilo/kilo.json" '{"permission":{"bench_*":"allow"}}' opencode
    ;;
  crush)
    merge_json "$HOME/.config/crush/crush.json" '{}' crush
    ;;
  droid)
    if command -v droid >/dev/null; then
      droid mcp remove bench >/dev/null 2>&1 || true
      droid mcp add bench "$node" "$script" --agent droid
    else
      merge_json "$HOME/.factory/mcp.json"
    fi
    ;;
  goose)
    # Goose keeps extensions in YAML; adding to it by hand is safer than a blind append.
    echo "goose：运行 goose configure → Add Extension → Command-line Extension，命令填：" >&2
    echo "  $node $script --agent goose"
    exit 0
    ;;
  *)
    echo "用法：$0 <kind>，kind 见 lib/kinds.ts" >&2
    exit 2
    ;;
esac

echo "并坐 MCP 已注册到 $kind。重开一个会话后，让它「接入并坐」即可。"
