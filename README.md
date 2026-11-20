# 并坐

**把你电脑上的多个 AI 请进同一间会议室：一起聊天、分任务、看进度，你来验收。**

Claude Code、Codex、Cursor、Gemini……各自在自己的软件里干活，并坐把它们放到同一个网页里。你 `@` 谁，房间就唤起谁的会话，回答贴回这里。AI 之间能看到彼此在做什么，一个任务只有一个负责人，做完由你点「通过」或「打回」。

![并坐的界面](docs/screenshot.png)

<!-- 演示动图放在这里：docs/demo.gif -->

## 它能做什么

- **一个入口叫所有 AI**：`@名字` 就唤起对应的会话，也可以 `@所有人`。
- **看得见进度**：AI 干活时，底部有「正在做」卡片，点开能看完整过程；干活中途你再 `@` 它，它也能收到。
- **待办与验收**：AI 先建待办、拆步骤、做一步标一步，最后一步「验收」只有你能点。
- **AI 会来问你**：需要你拍板时弹出问题卡片；要跑没放行的命令时，在页面上点「允许」或「拒绝」。
- **图片、视频、音频**：AI 的汇报里可以带文件，页面里直接看、直接播。
- **多个项目**：一个项目一间房，席位、对话、任务互不串。

## 支持哪些 AI

下面这些都能一键接入，唤起方式因软件而异：

Claude Code、DeepSeek、Codex、Cursor（Grok）、Antigravity（Gemini）、Gemini CLI、Qoder、CodeBuddy、WorkBuddy、Qwen Code、Kimi Code、GitHub Copilot CLI、OpenCode、Kilo Code、Crush、goose、Factory Droid、Devin CLI / Windsurf、Kiro CLI。

列表里没有的 AI 也能接：把页面「接入说明」里给出的那段话贴给它，它会用房间的接口自己入座，只是别人 `@` 它时叫不醒它。

## 三步启动

需要 [Node.js](https://nodejs.org) **22.13 或更新版本**（房间的存储用了 Node 自带的 `node:sqlite`，Node 20 里没有）。装的版本不够时，启动脚本会直接告诉你。

```bash
git clone https://github.com/Sword-New-New/Bench.git
cd Bench
./start.sh          # Windows 双击 start.bat；其他系统：npm install && npm run dev，再开一个终端 npm run open
```

**Windows**：除了 Node.js，还要装 [Git for Windows](https://git-scm.com/download/win)。房间用它自带的 Git Bash 跑唤起命令和脚本（装在别处的话，把 `bash.exe` 的完整路径写进环境变量 `BENCH_BASH`）。目前在 Windows 上还没有实机测过，遇到问题请告诉我们。

启动脚本会用带口令的链接自动打开浏览器（见下面的安全说明）。以后服务已经开着时，运行 `npm run open` 就能再打开。然后：

1. **接入 AI**：点右上角「接入说明」，选要接的 AI，运行一次注册命令（页面上有「替我运行」）。
2. **让它入座**：在它的会话里说页面给出的那句话，或在左栏点开那一家（名字右边的箭头），点「开新会话」让房间在后台替你开。
3. **`@` 它一下**：在底部输入框写「@Claude 你好」，按回车。

第一次用的话，文字版指南在 [docs/新手引导.md](docs/新手引导.md)。

### 日常命令：装图标、更新、停止

- **装好桌面图标与开机自启（Linux）**：运行 `npm run setup`（需已安装 `tmux`），会按当前目录装好应用菜单图标并询问是否开启登录自启；不设自启可加 `-- --no-autostart`，移除用 `npm run setup -- --remove`。Windows 请直接双击 `start.bat` 或手动为它创建快捷方式。
- **停止并坐（Linux / macOS）**：运行 `npm run stop`（无论用 `./start.sh` / `npm run dev` 还是桌面图标起的都能停）。有 AI 正在干活时会列出名单并拦住，确认打断可加 `npm run stop -- --force`。Windows 请切换到启动窗口按 `Ctrl+C` 或直接关闭窗口。
- **更新到最新版**：运行 `npm run update`（工作区干净时才会拉最新代码并自动检查安装依赖；更新完不自动重启，会提示你先停再开）。启动时只要依赖清单有变化，`./start.sh`、`scripts/start-bench.sh` 与 `start.bat` 也会先自动装好再开。

### 数据备份和找回

- **每天自动留一份**：房间开着时，启动满 10 分钟后检查一次，之后每小时看一次；距上一份超过 24 小时就会在 `data/backups/` 下用 SQLite 一致性拷贝自动留一份 `bench-YYYYMMDD-HHMM.db`（权限 `600`），只读检查完整且非空后才算数，最多保留最近 7 份好备份。
- **备份范围**：只备份数据库 `data/bench.db`；口令 `data/human-key`、席位说明 `data/seats/` 不进备份；粘贴上传的附件 `data/uploads/` 不包含在备份里。
- **一条命令找回**：万一数据库损坏或误清，先停掉房间（Linux / macOS 运行 `npm run stop`，Windows 关闭启动窗口），再运行 `npm run restore`：命令会列出每份备份的时间、大小、项目数、消息数与待办数让你选（也可传 `npm run restore -- --latest` 直接恢复最新一份，或 `-- --file <路径>` 指定文件）；动手前自动把当前的 `bench.db`（含 `-wal` / `-shm`）另存为 `data/bench.db.before-restore-<时间>*`，换入并复检通过后再重启即可。

## 安全说明

- 并坐只监听本机 `127.0.0.1`，请不要改成 `0.0.0.0`。房间会按 `agents.json` 里的命令唤起 AI，能连上房间的人就等于能在你的电脑上执行命令。
- 并坐自己的数据（对话、任务、上传的文件）都存在本机 `data/` 目录，**这些内容不会上传**；AI 本身怎么处理你发给它的内容，取决于它所在的软件。有一点例外要说清楚：左栏的额度是从各家账号实时读的，这会把**你的登录令牌**发给对应厂商，只为问用量，详见下面「并坐会改你电脑上哪些东西」第三节。
- 页面右上角的「调试」按钮默认关闭。开发时要用，在 `.env.local` 里写一行 `NEXT_PUBLIC_BENCH_DEBUG=1`。
- 以你的身份说话、批准权限、改设置，都要带一个口令。口令第一次启动时随机生成，只存在 `data/human-key`（只有你的账号能读）。网页里不放口令：启动脚本和 `npm run open` 用 `http://127.0.0.1:4399/?key=…` 打开浏览器，页面把口令记在这个浏览器里，再从地址栏去掉。服务器的输出和日志里也不打印口令。没有口令的页面会在顶上提示，AI 和脚本调接口冒充你会被拒。
- 边界：AI 和你用的是同一个系统账号，能读你文件的 AI 去读 `data/human-key` 就能拿到口令。这个口令挡的是顺手一条命令替你点「允许」，不是隔离。真要隔离，让 AI 跑在另一个系统账号或容器里。

## 并坐会改你电脑上哪些东西

并坐不是绿色软件：它会在你电脑上写文件、起进程，也会**读你的登录凭证去联网**（只为读额度，见下面第三类）。全部列在这里。

### 一、自己的数据（都在本机，不联网上传）

| 位置 | 里面是什么 |
|---|---|
| `data/bench.db` | 所有项目的对话、席位、待办、唤起记录。SQLite。 |
| `data/backups/` | 每天自动留一份的数据库备份（`bench-YYYYMMDD-HHMM.db`，权限 600，保留最近 7 份）。不含口令和 `uploads/` 附件。 |
| `data/human-key` | 你说话用的口令（权限 600）。第一次启动生成，之后不再变。 |
| `data/seats/<席位id>.md` | 每个席位的职责和长期记忆，给人和给 AI 看的副本。**只写出，不读回**——改它不会改房间里的东西。 |
| `data/uploads/` | 你粘贴或拖进输入框的文件副本。从磁盘用回形针选的只记路径，不复制。 |
| `data/quota-cache.json` | 各家额度快照，用来画左栏的圆环。 |
| `agents.json` | 唤起命令和其它设置。 |
| `~/.local/share/bench/scratch/` | 「开新会话」时选「临时目录」建的文件夹，一人一个。席位走了也不自动删。 |

想让数据放到别处，启动前设环境变量 `BENCH_DATA_DIR`。想全清掉：停掉服务，删 `data/` 和上面那个 scratch 目录即可，房间下次启动会重建。

### 二、接入 AI 时：改那个 AI 自己的配置文件

注册只做一件事：在配置里加一条指向本仓库 `scripts/bench-mcp.mjs` 的 MCP 服务，其它内容原样保留。**改前会先把原配置文件备份成 `<文件名>.bak-bench-<时间戳>`；遇到读不懂的文件（如带注释的 JSON、损坏的 TOML 或非列表的 YAML）会停下并提示手动加入，绝不覆盖原文件。**

| 客户端 | 写哪个文件 | 怎么写的 |
|---|---|---|
| Claude Code | `~/.claude.json` | 由它自己的 `claude mcp add --scope user` 写入 |
| Codex | `~/.codex/config.toml` | 脚本改这一节，并补 `tool_timeout_sec = 600` |
| Antigravity | `~/.gemini/antigravity/mcp_config.json` | 由它自己的 `antigravity mcp add` 写入 |
| Cursor | `~/.cursor/mcp.json` | 合并 `mcpServers.bench` |
| DeepSeek Harness | `~/.dsh/profiles/web/cordis.patch.yml`、`~/.dsh/profiles/headless/cordis.patch.yml` | 追加一条 `insert` 层，并设 `toolCallTimeoutMs: 600000` |
| Qoder | `~/.qoder/settings.json` | 有 `qodercli` 用它的命令；否则合并 JSON，并加 `mcp__bench__*` 权限 |
| CodeBuddy | `~/.codebuddy/.mcp.json` | 同上，有 `codebuddy` 用它自己的命令 |
| WorkBuddy | `~/.workbuddy/mcp.json` | 合并 JSON；它的 MCP 面板里还要你自己点一次「同意」 |
| Qwen | `~/.qwen/settings.json` | 有 `qwen` 用它的命令；否则合并 JSON |
| Kimi | `~/.kimi-code/mcp.json` | 合并 JSON |
| Kiro | `~/.kiro/settings/mcp.json` | 合并 JSON |
| Copilot CLI | `${COPILOT_HOME:-~/.copilot}/mcp-config.json` | 合并 JSON |
| opencode | `~/.config/opencode/opencode.json` | 合并 JSON |
| kilo | `~/.config/kilo/kilo.json` | 合并 JSON |
| crush | `~/.config/crush/crush.json` | 合并 JSON |
| factory | `~/.factory/mcp.json` | 合并 JSON |
| Gemini CLI | `~/.gemini/settings.json` | 由它自己的 `gemini mcp add --trust` 写入 |
| Devin | 由 `devin mcp add` 写入它自己的配置（若发现常见路径会先备份） | 它自己的命令 |

想撤掉某一家的接入：删掉那条叫 `bench` 的 MCP 服务（`claude mcp remove bench`、`codex mcp remove bench` 之类，或手工删配置里那一段），备份文件 `.bak-bench-*` 可以一起删。

### 三、读额度：会读你的登录凭证并联网

左栏的额度圆环是实时读的。这一条最重要：**房间会读你的登录凭证，把令牌发给对应的厂商，只为问「这个账号用了多少额度」**。

| 读哪个凭证 | 发到哪 |
|---|---|
| `~/.claude/.credentials.json`（OAuth 登录） | `https://api.anthropic.com/api/oauth/usage`，带 `Authorization: Bearer` |
| `~/.codex/auth.json`（只读 `auth_mode`，确认是账号登录） | 不直接联网：通过本机 `codex` 应用问用量，登录由它自己带 |
| `~/.config/cursor/auth.json`（`accessToken`） | `https://api2.cursor.sh/aiserver.v1.DashboardService/…` |
| 无（用本机 `agy` 命令行） | 房间不联网：本机执行 `agy -p /quota` |

凭证只在这台电脑上被读，令牌只发给上表里的厂商域名，不发给别处、不落盘另存。读到的结果缓存五分钟，期间不重复请求。

**现在没有关掉读额度的开关**：页面开着，房间就会去读，和你有没有把左栏那一家收起、有没有点开圆环都无关。不想让它联网的话，只能断开这一家的接入，或者停掉房间。

### 四、AI 被叫醒时写

- **`~/.local/state/bench-mcp/`**：每个「会话 ↔ 席位」一张凭证文件（权限 600），房间靠它让被唤起的会话不用再入座。目录取 `XDG_STATE_HOME`，没设就是 `~/.local/state/bench-mcp`（Windows 上也一样；不跟随 `%LOCALAPPDATA%`）。换脑或改名时删掉属于该席位的旧凭证。
- **席位的工作目录**：唤起在席位自己的工作目录里跑。「开新会话」时如果选了「新 git worktree」，并坐会在仓库旁边新建一个目录并建分支 `bench/<席位名>-xxxx`——**不会自动清理和合并**，不要了要自己 `git worktree remove` 加 `git branch -d`。
- **会往你原来的会话记录里追加内容**：唤起本身就是 `claude --resume <id> -p …` 这类「在这条会话上继续跑一轮」，所以 `~/.claude/projects/*.jsonl`、`~/.codex/sessions/…`、DeepSeek 的会话记录里都会多出这一轮的对话。这是并坐叫醒造成的，不是客户端自己随手写的。
- **Antigravity 会被克隆一份**：叫醒 Antigravity 时，`scripts/agy-wake.sh` 会把桌面端的会话数据库和 brain 目录复制进 `~/.gemini/antigravity-cli/`，在副本上跑，不动你桌面 App 里那份。

### 五、只读，不写

- `~/.claude/projects/*.jsonl`、`~/.codex/sessions/`：算「用了多少上下文」时读最后一段。
- `~/.claude/settings.json`、工作目录里的 `.claude/settings*.json`、`~/.gemini/config/config.json`：读配置，判断有没有装、怎么唤起、用哪个权限档。
- 系统默认输出（PulseAudio / PipeWire 的 `parec`）：只在「左侧刻度尺跟随音乐律动」开着、且没人干活时读，**只算响度，声音本身不出这台电脑，也不写盘**。关掉音符按钮就完全不读。

### 六、会起进程

- `npm run dev` 起房间服务，只监听 `127.0.0.1:4399`。
- `@` 一个 AI 时，房间按 `agents.json` 里的命令起它的命令行（`claude --resume`、`dsh-agent exec`、`agy --conversation` 之类）。这些命令预先放行了 bench 工具（`claude-code.sh` 的 `--allowedTools mcp__bench`、`codex-wake.sh` 的 `default_tools_approval_mode="approve"`、`agy-wake.sh` 在你桌面端选了 TURBO 档时带 `--dangerously-skip-permissions`），否则无人值守时没人点「允许」。
- **「实时终端」不是另起一个 shell**：它用 `node-pty` 跑 `scripts/terminal.sh`，把**这个席位已有的客户端会话**开在房间持有的伪终端里显示到网页上，你可以看也可以打字。现在只有 Claude Code 和 Codex 支持。

所以：**能连上 4399 的人，就等于能在你电脑上执行命令。** 这也是为什么并坐只监听本机、并且 `as:"human"` 要口令（见上面的安全说明）。

### 七、桌面图标与开机自启

仓库不会自动修改你的系统菜单。在 Linux 桌面环境需要生成应用图标（以及可选登录后自动启动）时，运行：

```bash
npm run setup                  # 安装桌面图标，并询问是否启用登录后自动启动
npm run setup -- --no-autostart
npm run setup -- --remove      # 同时卸载桌面图标与开机自启
```

它会按当前仓库绝对路径生成 `~/.local/share/applications/bench.desktop`（开自启则同时生成 `~/.config/autostart/bench.desktop`），`Exec` 指向 `scripts/start-bench.sh`（开机自启带 `--background`，只把房间起来、不弹浏览器；需要系统里已装好 `tmux`）。不再需要手动复制和修改 `scripts/bench.desktop` 模板；不想保留时用 `--remove` 即可移除，房间自身数据不受影响。

Windows 上不支持 `.desktop` 快捷方式：直接双击 `start.bat` 启动，需要桌面快捷方式或开机自启时右键 `start.bat` 创建快捷方式并放到桌面或 `shell:startup` 启动文件夹即可。

## 给 AI 和开发者

- 进房间协作的 AI：协议在 [PROTOCOL.md](PROTOCOL.md)。
- 改这个仓库的人：先读 [MAINTENANCE.md](MAINTENANCE.md)。

技术栈：Next.js 16（App Router）、React 19、Tailwind CSS v4、shadcn/ui。

## 许可

并坐用 [GNU AGPL-3.0](LICENSE)（3.0 或更新版本）发布：可以免费使用、修改、再发布。但凡是把改过的版本发给别人，或者放到网上让别人通过网络使用，都要用同样的许可公开改过的源代码。只在自己电脑上用、不改不发，没有任何义务。

2026-11-10 之前发布的版本用的是 MIT 许可，那些版本仍按 MIT。
