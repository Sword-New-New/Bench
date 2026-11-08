#!/usr/bin/env bash
# Usage: register-mcp.sh claude|codex|cursor|antigravity
# Register the 并坐 MCP server (scripts/bench-mcp.mjs) with one agent client,
# for this user. Running it again replaces the old entry.
set -euo pipefail

kind="${1:-}"
root="$(cd "$(dirname "$0")/.." && pwd)"
script="$root/scripts/bench-mcp.mjs"
node="$(command -v node || true)"
[[ -n "$node" ]] || node=/usr/local/nodejs/bin/node
[[ -x "$node" ]] || { echo "找不到 node" >&2; exit 1; }

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
EOF
      echo "已写入 $patch"
    done
    ;;
  *)
    echo "用法：$0 claude|codex|cursor|antigravity|dsh" >&2
    exit 2
    ;;
esac

echo "并坐 MCP 已注册到 $kind。重开一个会话后，让它「接入并坐」即可。"
