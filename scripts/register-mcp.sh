#!/usr/bin/env bash
# Usage: register-mcp.sh <kind> [<kind>...]   (kinds: see lib/kinds.ts)
# Register the 并坐 MCP server (scripts/bench-mcp.mjs) with agent clients,
# for this user. Running it again replaces the old entry.
set -euo pipefail

# --force: point the clients here even though another copy of 并坐 is in use.
force=0
kinds=()
for arg in "$@"; do
  if [[ "$arg" == "--force" ]]; then force=1; else kinds+=("$arg"); fi
done

# Several kinds: one run each, and carry on past one that fails.
if [[ ${#kinds[@]} -gt 1 ]]; then
  failed=0
  for each in "${kinds[@]}"; do
    if [[ $force -eq 1 ]]; then "$0" "$each" --force || failed=1; else "$0" "$each" || failed=1; fi
  done
  exit "$failed"
fi

kind="${kinds[0]:-}"
root="$(cd "$(dirname "$0")/.." && pwd)"
script="$root/scripts/bench-mcp.mjs"
node="$(command -v node || true)"
[[ -n "$node" ]] || node=/usr/local/nodejs/bin/node
[[ -x "$node" ]] || { echo "找不到 node" >&2; exit 1; }
# Git Bash on Windows: what goes into a client's config must be a Windows path
# (C:/Program Files/nodejs/node.exe), not /c/Program Files/….
if command -v cygpath >/dev/null 2>&1; then
  script="$(cygpath -m "$script")"
  node="$(cygpath -m "$node")"
fi

# Another copy of 并坐 already in use? Clients that point at its bench-mcp.mjs
# are talking to the room the user has open. Registering from here would
# quietly repoint them at this checkout (a fresh clone an agent just pulled,
# say), so stop and say so. A path that no longer exists is fine to replace.
if [[ $force -eq 0 && "$kind" != "" ]]; then
  configs=(
    "$HOME/.claude.json" "${CODEX_HOME:-$HOME/.codex}/config.toml" "$HOME/.cursor/mcp.json"
    "$HOME/.gemini/settings.json" "$HOME/.gemini/antigravity/mcp_config.json"
    "${DSH_HOME:-$HOME/.dsh}/profiles/web/cordis.patch.yml" "${DSH_HOME:-$HOME/.dsh}/profiles/headless/cordis.patch.yml"
    "$HOME/.qoder/settings.json" "$HOME/.codebuddy/.mcp.json" "$HOME/.workbuddy/mcp.json" "$HOME/.qwen/settings.json"
    "$HOME/.kimi-code/mcp.json" "$HOME/.kiro/settings/mcp.json" "${COPILOT_HOME:-$HOME/.copilot}/mcp-config.json"
    "$HOME/.config/opencode/opencode.json" "$HOME/.config/kilo/kilo.json" "$HOME/.config/crush/crush.json" "$HOME/.factory/mcp.json"
  )
  others=()
  while IFS= read -r found; do
    [[ -n "$found" && "$found" != "$script" && -f "$found" ]] && others+=("$found")
  done < <(grep -hoE '[^"]*scripts/bench-mcp\.mjs' "${configs[@]}" 2>/dev/null | sed -E "s/^[[:space:],'[]*//; s/^(args|command)[[:space:]]*[:=][[:space:]]*[['\"]*//" | sort -u || true)
  if [[ ${#others[@]} -gt 0 ]]; then
    other_root="$(cd "$(dirname "${others[0]}")/.." && pwd)"
    echo "⚠ 没有注册：这台电脑上已经有一份并坐在用（$other_root），客户端的 MCP 指向它。" >&2
    echo "  从这里（$root）注册会把 $kind 的 MCP 悄悄改指到这份，用户正在用的那间房就收不到它了。" >&2
    echo "  要接入正在用的房间：在 $other_root 里运行 scripts/register-mcp.sh $kind，或者什么都不做（多半已经注册过了）。" >&2
    echo "  确定要改指到这里：加 --force 再运行。" >&2
    exit 3
  fi
fi

# What the user still has to do by hand after this, said once at the end.
todo=""

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
    todo="重启 DeepSeek Harness（网页端和 dsh-agent 都要）才会加载 bench。"
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
    # WorkBuddy reads MCP from ~/.workbuddy/mcp.json (or its 自定义连接器 page), but a
    # server it didn't add itself stays "trust-pending" and never starts until you
    # approve it in WorkBuddy's MCP panel (kept in ~/.workbuddy/mcp-approvals.json).
    merge_json "$HOME/.workbuddy/mcp.json"
    todo="重开 WorkBuddy 后，到它的 MCP 面板里批准 bench，不批准它不会启动 bench。"
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
    echo "⚠ 需要你做：goose 没有自动注册。运行 goose configure → Add Extension → Command-line Extension，命令填：" >&2
    echo "  $node $script --agent goose"
    exit 0
    ;;
  *)
    echo "用法：$0 <kind>，kind 见 lib/kinds.ts" >&2
    exit 2
    ;;
esac

room="${BENCH_URL:-http://127.0.0.1:4399}"
echo "并坐 MCP 已注册到 $kind。"
[[ -z "$todo" ]] || echo "⚠ 需要你做：$todo"
# Read by the agent that ran this as often as by a person.
echo "给 agent：bench_* 工具要在新开的 $kind 会话里才出现。现在这个会话里看不到它们是正常的，不是注册失败，不要重复注册。"
echo "  这个会话要入座，直接按 PROTOCOL.md 用 curl：POST $room/api/v1/join；之后的新会话说「接入并坐」即可。"
echo "  入座后跑一次 bench_selfcheck（或 POST $room/api/v1/selfcheck，带 agentId 和 token），把结果给用户看：它说明别人 @ 你时能不能真把你叫起来。"
