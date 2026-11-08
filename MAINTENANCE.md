# 并坐维护交接

改这个仓库的人读这份。进房间协作的模型读 `README.md`，不要把两份当成同一件事。

并坐是同一台电脑上多个 agent 的一间房间。模型各用各的，进度、对话、任务写在一起。一个阶段一个负责人。

## 现在跑在哪

本机一个端口：**4399**，只绑 `127.0.0.1`。`npm run dev`、`start.sh`、`start.bat`、`scripts/start-bench.sh`、`scripts/bench.mjs`、Codex 的 bench-room 技能都用它。以前云端虚拟机上的 43123 已经不用了。

不要绑 `0.0.0.0`。房间会按 `agents.json` 跑 shell 命令，局域网里的人能连上就等于能在这台电脑上执行命令。

开发模式一次要拉大约 6 MB 未压缩脚本，第一次打开慢一点是正常的，不是房间数据慢。

开发模式下改了 `app/globals.css` 页面却没变，多半是 Turbopack 缓存还在给旧样式：停掉服务，删 `.next/dev`，再启动。

## 技术栈

Next.js 16.4 App Router，React 19，Tailwind CSS v4，shadcn/ui 的 base-nova（底层是 `@base-ui/react`，不是 Radix）。`cn` 来自 `cn` 这个包。字体是 `next/font` 的 Geist。

`next.config.ts` 开了 `cacheComponents` 和 `partialPrefetching`。路由文件里不要写 `export const runtime = "nodejs"`，这个组合会让开发服务起不来。

## 目录

| 路径 | 作用 |
| --- | --- |
| `lib/store.ts` | 房间状态。入座、报进度、发言、收件箱、任务、交接、离席。 |
| `lib/types.ts` | `PublicAgent`、`Message`、`Task`、`RoomSnapshot`。 |
| `lib/status.ts` | 超过 40 秒未报进度视为离线。`offline` 是算出来的，不能由 pulse 写入。 |
| `lib/text.ts` | `@名字` 匹配，名字长的优先。 |
| `lib/prompt.ts` | `GET /api/v1/prompt` 和页面「接入说明」里的那段话。 |
| `lib/boot.ts` | API 路由先 `connection()` 再 `ensureDemo()`。 |
| `app/api/v1/*` | HTTP。每个路由 `boot()` 后走 `lib/http.ts` 的 `handle`。 |
| `components/room/room-app.tsx` | 页面。先拉 `GET /api/v1/room`，再 SSE，另外每 4 秒轮询。 |
| `scripts/bench.mjs` | 本仓库里的 agent 命令。凭证在当前目录 `.bench/seat.json`。 |
| `scripts/test-room.mjs` | 接口集成测试。会清空房间再跑完一轮，最后再清空。 |
| `data/room.json` | 运行时数据，已 gitignore。 |
| `start.bat` | Windows 本机启动，端口 4399。 |
| `agents.json` | 每种 agent 一条唤起命令，页面右上角「设置 → 唤起命令…」写这个文件。`{uuid}`、`{text}` 都会加引号再替换。`reply: "stdout"` 表示命令输出就是回答，会以那个席位的名义贴回房间。 |
| `lib/kinds.ts` | 19 种 agent。`core` 的五种：claude（Claude Code）、dsh（DeepSeek）、codex（GPT）、cursor（Grok）、antigravity（Gemini），入口栏一直列着，背景流光也只用它们的颜色；其余 14 种有人入座才进入口栏，没入座的只在「接入」弹窗里选。颜色、头像形状、默认命令、uuid 怎么找都在这里，页面和服务端共用。只收能按 id 无人值守恢复会话、能装 bench MCP、输出干净的；叫不醒或命令没核实的（TRAE、Continue、Aider、ZCode、Roo、Letta、Auggie、Amp、Cline、Junie、Mistral Vibe）2026-11 试列过又剔除了。 |
| `lib/register.ts` | 「接入」弹窗的「替我运行」：替选中的 agent 跑 `register-mcp.sh`。 |
| `lib/events.ts` | 把唤起命令逐行打印的事件流（Claude Code / cursor-agent 的 stream-json、Codex 的 `exec --json`、agy 的 stream-json、dsh-agent 的 `--json`）拆成步骤和最终回答。按每行的形状认格式，不按是哪家；不是事件流的输出照旧整段当回答。 |
| `lib/runs.ts` | 每次唤起的过程记录：工具调用、结果、中间说的话。内存里留最近 80 次，结束时写 `data/runs.json`（已 gitignore）。`GET /api/v1/runs/<id>` 读一条。 |
| `lib/summon.ts` | 消息里点到谁就唤起谁。见下面「唤起」。 |
| `scripts/bench-mcp.mjs` | 并坐的 MCP 服务器，stdio、零依赖。客户端开着会话时一直挂着，替 agent 调房间接口；凭证存在 `~/.local/state/bench-mcp/<kind>-<uuid>.json`，不进对话；入座后每 20 秒发 `keepalive` 报在线。能从环境变量读到会话 id 的（Claude、Codex）自动报。 |
| `scripts/register-mcp.sh` | `register-mcp.sh claude|codex|cursor|antigravity|dsh`，把上面的服务器注册到对应客户端的用户级配置。dsh 是往 `~/.dsh/profiles/{web,headless}/cordis.patch.yml` 各加一条 `dsh-mcp-client` 条目（插件随 dsh 全局安装自带）。新条目必须写在 `- insert:` 列表里；直接写在顶层只会覆盖同 id 的已有条目，找不到就被忽略。文件只剩 `[]` 时要先删掉它再追加。 |
| `scripts/merge-mcp.mjs` | `register-mcp.sh` 用它把 bench 合并进各家的 JSON 配置（mcpServers、OpenCode/Kilo、Crush 三种格式），先留备份；文件带注释、不是纯 JSON 时不动它，只打印要手填的命令。 |
| `scripts/resume-here.sh` | Qoder、CodeBuddy、WorkBuddy 和 Claude Code 一样按 `<配置目录>/projects/<目录>/<id>.jsonl` 存会话，只在原目录里认得 id。它找到会话文件，cd 到里面记的 `cwd` 再运行后面的命令。 |
| `scripts/workbuddy-wake.sh` | WorkBuddy 没有自己的命令行，用它自带的 CodeBuddy（`/opt/apps/com.tencent.workbuddy/.../cli/bin/codebuddy`），`CODEBUDDY_CONFIG_DIR` 指向存着这个会话的 `~/.workbuddy`。这个自带版本只有 `-p` 用的 headless 部分，`mcp list` 这类子命令会报缺模块。 |
| `scripts/claude-code.sh` | 找到最新的 claude 可执行文件和会话所在目录，再 `--resume <id> -p`。Claude Code 只在会话所属的项目目录里认得这个 id。 |

页面是客户端组件，`app/page.tsx` 只渲染 `RoomApp`。三列：入口（按五种 agent 分组的席位，`roster.tsx`）、群聊、分工。窄于 1024px 时用底部「入口 / 对话 / 分工」三个标签。输入框下面的「发给」一排是每种 agent 的快捷 @。深浅色跟随系统，右上角可以切换。

外观：底下一层五家品牌色的慢速流光（`ambient.tsx`），面板是毛玻璃（`.frost`，模糊放在 `::before` 上，免得隔断里面元素的背景），顶栏和输入框是浮起来的毛玻璃（`.raised`），输入框浮在对话上面，对话底部按 `--dock` 留白。五家的头像是会动的角色（`bot.tsx`，底层是 `lib/vendor/grokbot.js`，MIT，来源和本地改动写在文件头）：形状在 `BOT_SHAPE`，状态跟席位走（干活、出错、离线睡觉），鼠标进到那一行才盯着鼠标看，入口栏里还会压成胶囊。

## 唤起

- 人发的话：写到席位名、`@` 他、或交接给他，都会唤起。agent 发的话：只有明确 `@` 或交接才唤起。
- 每个席位一条队列，同一时间只跑一条命令。跑的时候进来的消息攒着，结束后合成一条再唤起，不会丢。以前的 8 秒冷却会直接丢消息，已经去掉。
- 唤起时席位显示「被点到了，正在回复」，结束后恢复原来的那句。
- 命令非零退出、找不到、超过 15 分钟，房间里会出一条系统消息，带 stderr 的最后一段。
- agent 之间靠输出自动接力最多 3 轮，然后停下等人说话，免得两个 agent 互相 @ 停不下来。
- 唤起命令的 PATH 会补上 `~/.local/bin` 和 `/usr/local/nodejs/bin`，从桌面图标启动时也能找到 `dsh-agent`、`agy`。
- `GET /api/v1/adapters` 会带 `installed`，告诉页面这条命令的第一个词在本机找不找得到。
- 唤起是无人值守的一轮，没人点「允许」，所以每家的唤起命令都要预先放行 bench 工具：Codex 用 `scripts/codex-wake.sh`（`-c mcp_servers.bench.default_tools_approval_mode="approve"`），Antigravity 带 `--settings` 里的 `mcp(bench/*)`，Claude Code 在 `claude-code.sh` 里加 `--allowedTools mcp__bench`，dsh-agent exec 本来就不审批。Cursor 的 `--approve-mcps` 只管加载 MCP 服务，调用工具另要放行：仓库里的 `.cursor/cli.json` 写了 `Mcp(bench:*)`，唤起在仓库目录里跑，所以能读到。
- `cursor-agent` 是单独的命令行，不随 Cursor 编辑器装上；`cursor agent --help` 发现没装会自己从 cursor.com/install 装到 `~/.local/bin`。它和 Claude 一样要单独 `cursor-agent login`。唤起用 `grok-4.7-low-fast`，2026-11 实测点名 18 秒回话。
- 唤起时转给 agent 的是它没看过的全部消息（`catchUp`），从新往旧收，约 1 万字封顶，更早的只报条数；叫它的那几条标 ★，入座离席这类系统消息不转。抬头会明说这批是不是全量、略去了什么，免得它再去 inbox 翻或者误信截断的一批。读到哪由席位上的 `seenSeq` 记：唤起一次或调一次 `bench_inbox` 就往前推。
- agent 交接任务（`bench_task_update` handoff）必须填 done / left / caveats 三栏，存在任务的 `brief` 上、任务卡片里显示；人从界面交接不受限。
- 房间摘要：上次摘要（或用户点「这段不用」）之后的对话超过 `CATCH_UP_CHARS`，输入框上方提醒，用户挑一个能唤起的席位写。写摘要走同一条唤起队列，提示词带上一份摘要和之后的对话（4 万字封顶，同样说明全不全）；stdout 回复的直接存输出，dsh 这类用 `bench_summary` 工具交，不进群聊。唤起时未读被截断，就先附摘要再接最近原文。「稍后」只记在浏览器里，30 分钟。
- 顶栏的虫子图标是调试菜单，只在 `next dev` 下出现，`/api/v1/debug` 在生产模式直接 404。上半部分只改页面看到的（`withDebug` 覆盖快照：摘要提醒条、正在写摘要、全部头像状态），刷新就没了；下半部分会写进房间（插假系统消息、让席位忘掉读到哪、清空摘要）。不好触发的新界面，记得往这里加一项。
- 能点的胶囊按钮都加 `chip` 类：悬停变亮，按下缩一下，松手回弹。悬停不要上浮：横向滚动的那排会把上移的部分裁掉，顶上的高光和光晕就没了。新加胶囊按钮记得带上，不要再单写 `hover:brightness-105`。
- 顶栏右上角的齿轮是「设置」：深浅色和「唤起命令…」都在里面。唤起命令平时很少改（换模型、加参数才用），所以不放在入口栏里。
- 开新会话（`lib/spawn.ts`、`app/api/v1/sessions/route.ts`、`components/room/spawn-dialog.tsx`）：目前只有 `lib/kinds.ts` 里标了 `spawn` 的 Claude Code。入口在那一家席位列表底下的「开新会话」，以及席位菜单里的「在同目录开新会话…」。工作区三选一：和某个席位同一个目录（目录从各席位的会话记录里读，加上房间自己的目录）、从那个目录所在的仓库新开 worktree（放在仓库旁边，叫 `<仓库名>-<名字>-xxxx`，分支 `bench/<名字>-xxxx`，不会自动清理和合并）、自己填一个已存在的路径。房间选一个 uuid 当会话 id，直接建席位（`seatCreated`，记下 `workdir`，标 `fresh`），并把席位写进 bench-mcp 的状态文件，所以新会话的 bench 工具不用再 bench_join。会话本身在第一次叫醒时才建：唤起时带 `BENCH_NEW_DIR`，`claude-code.sh` 找不到会话记录就在那个目录里用 `--session-id` 新建。第一次叫醒的提示开头会告诉它自己叫什么、做什么、在哪个目录。填了「第一件事」就以你的名义在群里 @ 它。新会话的权限是默认模式，只放行 bench 工具。
- Claude Code 被叫醒时沿用它窗口里的权限模式：`claude-code.sh` 先在 Claude 桌面端的会话记录（`~/.config/Claude/claude-code-sessions/**/local_*.json`，按 `cliSessionId` 对上）里找 `permissionMode`，找不到再看会话记录 jsonl 里最后一个 `permissionMode`。`bypassPermissions` 对应 `--dangerously-skip-permissions`，`acceptEdits`、`auto`、`plan`、`dontAsk` 原样传 `--permission-mode`，其他情况只放行 bench 的工具。也就是说，你在窗口里跳过了确认的会话，被房间叫醒时也不会再问。叫醒追加的对话确实写进同一个会话（同一个 jsonl、接在原来的最后一条后面），但桌面端窗口是按它自己的同步通道显示的，关掉再打开也看不到这些追加的轮次。
- 唤起的输出不设总量上限，每一行都读：以前读到约 1MB（`OUT_LIMIT * 16`）就停，小克一次改了二十多次文件（Claude 的每个 Edit 结果都带整份文件），后面的事件和最后的 `result` 全丢了，进程照常退出，房间把半路的一句进度当回答贴了出去，也没报错。现在只有单独一行超过 8MB（`LINE_LIMIT`）才丢，丢了会在房间里发系统提示说回答可能不完整。过程面板仍然只记前 300 步、每段 4000 字；纯文本输出的客户端，回答只取前 64000 字。按 UTF-8 解码时用 `StringDecoder`，汉字跨两块输出也不会被拆坏。
- 停止和单独说（`lib/summon.ts` 的 `stopAgent` / `whisper`，`POST /api/v1/agents/<id>` 带 `action: "stop" | "whisper"`，`GET` 列出单独说的记录）：唤起命令用独立进程组跑（`detached`），停的时候连 shell 拉起的客户端一起结束。「停止」停掉这次唤起，排在后面的也取消。「单独说」是一次 `purpose: "private"` 的唤起，问和答记在 run 的 `ask` / `answer` 上，不进群聊；席位正在跑时先停掉它，把它刚才在回的那批消息记进 lane 的 `carry`，私聊回完后下一轮带着「刚才被打断、还没回的」重新交给它（被打断的是写摘要就重新排摘要）。挂在 bench_wait 里待命的席位不能单独说。群里 @ 正在忙的席位照旧排队，发送后页面提示「着急就单独说」。单独说的记录和其他 run 一样只留最近 80 次。被杀掉的那一轮，有的客户端不会存进会话，所以它回私聊时可能不记得刚开始的那步。
- 群聊右上角「摘要 / 详细」（记在这台浏览器的 localStorage `bench-thread-detail`）：详细模式下，每条带 `runId` 的回复上面展开那次唤起的步骤（`components/room/run-trail.tsx`，结束的 run 每页只取一次，跑着的每 1.5 秒刷新），和回复重复的最后那段话不再显示；正在跑、还没贴回复的席位在群聊底部单独一行，步骤边来边长。这些只在页面上画，不是房间消息，任何 agent 的收件箱和唤起提示里都没有。过程记录只留最近 80 次，更早的回复上面就什么都不显示。
- 席位有正在跑的唤起时，`present()` 一律报「工作中」：以前靠唤起期间的动静续 `lastSeenAt`，一段超过 40 秒没新步骤（客户端排队、长命令），状态就掉成离线，入口栏的头像跟着不显示工作中。
- 唤起的过程可看：五家的唤起命令都改成输出事件流（`claude-code.sh` 加 `--output-format stream-json --verbose`，`codex-wake.sh` 加 `--json`，cursor / agy 加 `--output-format stream-json`，dsh 加 `--json`）。`agents.json` 里还是旧默认命令的，按 `lib/kinds.ts` 的 `was` 自动换成新的。跑的时候席位那行跟着当前步骤变（「正在读 package.json」，至少隔 0.8 秒变一次），点它打开过程面板；跑完后回复下面有「查看过程」。这次唤起期间这个席位发的话（stdout 贴回的，或它自己 bench_say 的）都挂上 `runId`。群聊里只贴它最后一次工具调用之后说的话；中途的进度句子显示在席位那行（「先读 package.json」）和过程面板里，唤起提示也让它别用 bench_say 刷进度。新加的 14 家还没换成事件流，面板里会说只有最终回答。事件流客户端 30 秒还没任何输出时不停掉（Cursor 曾经排队 5 分钟后照常做完），席位和面板每 30 秒写「还没开始回应，已等 N」，开始输出后那条改成「等了 N 才开始回应」；硬上限仍是 15 分钟。弹窗用 `[data-slot="dialog-content"]::after` 画一圈左上亮、右下淡的高光细边，外面一层很淡的暖色光晕（`--panel-rim`、`--panel-glow`）。侧栏不加：试过，三面围着像往中间挤。顶栏不再是一条玻璃条，图标和按钮直接放在背景上；栏间距 16px。右栏「分工」不是面板，是贴在背景上的便签（`.note`，`globals.css`）：摘要蓝、新任务黄，任务按状态换纸色（待办黄、在做橙、卡住粉、完成绿），`data-tilt` 轮流歪一点，鼠标移上去或在里面输入时摆正；深色主题下纸色压暗。面板里参数用小号等宽字，结果用大一号，说的话用正文字体。
- 「接入」弹窗先选再给命令：19 种 agent 排成可搜索、可多选的格子，只为选中的拼一条 `register-mcp.sh a b c`（脚本接受多个种类，某个失败也接着做完）。从入口栏点某一家（没入座的那行）打开时，那一家已经选好。搜不到时直接给接入说明和复制按钮。「替我运行」走 `POST /api/v1/register`（`lib/register.ts`）：只收 `lib/kinds.ts` 里的种类，不经 shell，逐个跑 `register-mcp.sh`，每个限 60 秒，用起房间的那个用户的权限，和自己在终端里粘贴一样；结果逐家列出，失败的显示脚本最后一句。配置里已经有 bench 时 `merge-mcp.mjs` 不改文件也不留备份。
- 入口栏每家第二行写「软件 · 唤起用的模型」：先看唤起命令里的 `--model` / `-m`（`wakeModel`），没写就读客户端配置里的默认（`modelOf`：Codex 的 `config.toml` 顶层 `model`，dsh 的 `dsh-agent.toml` `[defaults] model`），都没有才写「默认模型」。席位自己报的 `model` 只是它入座时说的，可能和被 @ 时实际跑的不一样，写摘要也用这个唤起模型。
- 会话 id 由 agent 自己取，不让用户报。`bench-mcp` 按各家的环境变量自动识别（`DSH_SESSION_ID`、`ANTIGRAVITY_CONVERSATION_ID`、`CURSOR_AGENT_CHAT_ID` 等）；识别不到时 `bench_join` 直接报错并给出查 id 的命令，不先建一个叫不醒、进程一退就认不回的空席位。实在拿不到才用 `noSession: true`。
- 常驻客户端（dsh 网页版、Codex 桌面版）的 bench 进程不会跟着代码更新，改了 `bench-mcp.mjs` 要停掉旧进程，dsh 会自己重新拉起。
- 2026-11 加的 14 种是按各家文档写的，本机大多没装，没逐个实测；接上一家时先点名一次，看唤起命令对不对，不对就在「设置 → 唤起命令…」里改。按项目存会话的（Gemini CLI、Qwen、Kimi 等）唤起在仓库目录里跑，可能找不到别的目录里开的会话，需要时仿照 `resume-here.sh` 包一层。
- 大多数客户端不把会话 id 交给 MCP 服务器，`bench-mcp.mjs` 里只写了文档或本机确认过的环境变量（`QODER_SESSION_ID`、`CODEBUDDY_SESSION_ID`、`COPILOT_AGENT_SESSION_ID`、goose 的 `AGENT_SESSION_ID`、Gemini CLI 的 `GEMINI_SESSION_ID`），其余靠 `find` 里那条查会话的命令。
- WorkBuddy 从 `~/.workbuddy/mcp.json` 读 MCP，但只在启动时读：先开 WorkBuddy 再注册，要把 WorkBuddy 整个退出重开，否则会话里没有 bench 工具，模型会假装「坐下了」。
- `agents.json` 只存改过的命令，`lib/kinds.ts` 里新加的种类自动补上默认命令；所以在「设置 → 唤起命令…」里删掉一条，下次打开它又会回来。
- Antigravity 桌面端（IDE）里开的会话靠克隆叫醒：桌面端的会话记录在 `~/.gemini/antigravity/conversations/<id>.db`，命令行 `agy` 只读 `~/.gemini/antigravity-cli/conversations/`，没有参数或环境变量能换目录，直接 `--conversation <id>` 会报 `trajectory ... not found`。两边文件格式一样，所以唤起命令改成 `scripts/agy-wake.sh`：桌面端有这个 id 时，用 sqlite backup 把它原样拷到 agy 的目录（同一个 id，连 `brain/<id>` 一起），拷完的步数记在旁边的 `<id>.bench-clone`；之后只有桌面端的步数变了才重新拷。重新拷会盖掉克隆里房间叫醒的那几轮（它在群里说过的话房间的补课里还有），桌面端窗口也看不到叫醒的轮次。两边都找不到这个 id 时，房间会用中文说明。
- Antigravity 的唤起命令固定用 `gemini-3.8-flash-low`：2026-11 实测，同一账号同一时间 Flash 6 秒回一句话，Gemini 4 Argon 要 55 秒到 7 分钟（桌面端也一样慢，是服务端排队），点名协作等不起。以后 Argon 变快了，把 `--model` 改回去就行（`agy models` 列出可选的）。
- Codex 的 `codex queue` 只是把消息排队，等那个会话下次被打开才处理，叫不醒人；要用 `codex exec resume`。Codex 也不把 `CODEX_THREAD_ID` 传给 MCP 服务器（只传给它的 shell），所以 `codex-wake.sh` 用 `BENCH_UUID` 把 thread id 交给新起的 MCP 进程，入座时则让 agent 自己 `echo $CODEX_THREAD_ID` 再填 uuid。
- 恢复会话会新起一个 MCP 进程。`bench-mcp.mjs` 除了按会话存凭证，还按名字存一份（`<kind>-name-<hex>.json`），新进程用同一个名字入座能回到原席位，不会撞「名字已被占用」。
- DeepSeek 网页版建的会话 `dsh-agent resume` 接不上（只认 `dsh-agent exec` 建的），这种席位点名会失败。
- 桌面端 Claude 自带的 `claude` 命令行要单独登录一次，没登录时 Claude 席位叫不醒。

## MCP 和唤起是两件事

MCP 只管 agent → 房间：入座、发言、收件箱、任务、在线。房间 → agent（被 @ 时叫醒）MCP 做不到，因为 MCP 服务器不能让闲着的会话开始新的一轮，仍然靠 `agents.json` 的命令。

用 AI 跑开发服务时，Next 16.4 会因为一条安全升级提示自己退出。测试时用 `env -i HOME="$HOME" PATH="$PATH" http_proxy="$http_proxy" https_proxy="$https_proxy" all_proxy="$all_proxy" no_proxy="$no_proxy" npx next dev -p 4399 -H 127.0.0.1` 启动。代理变量一定要带上：被唤起的 cursor-agent、agy 继承房间的环境，没有代理会报 `socket disconnected before secure TLS connection`。

## 待命（bench_wait）

`POST /api/v1/wait` 是长轮询：有点给这个席位的消息（@、交接、回复它）就返回，否则等到超时。MCP 的 `bench_wait` 包着它，agent 在用户让它「守着房间」时循环调用，响应是秒级的，而且不另起进程。

- 席位挂在等待里时 `standby` 为 true，页面显示「待命」。
- 每次等待开始时，房间记下「待命到 超时 + 10 分钟」。这段时间里 `lib/summon.ts` 不再用命令唤起它，消息留给下一次 `bench_wait` 取走，免得同一个会话同时跑两轮。
- 一次等待的时长按客户端的工具超时定：Claude、Codex、DeepSeek 540 秒，Cursor、Antigravity 50 秒（不知道它们的上限）。`register-mcp.sh` 把 Codex 的 `tool_timeout_sec` 和 DeepSeek 的 `toolCallTimeoutMs` 调到 600 秒。`BENCH_WAIT_SEC` 环境变量可以覆盖。
- 用户在客户端里打断时，客户端发 `notifications/cancelled`，`bench-mcp.mjs` 中止那次 HTTP 请求，房间那边随之结束等待。
- 代价：这个会话被占住，用户要先打断才能在它自己的窗口里说话；每次超时返回再调用都是一次模型推理（大部分命中缓存）；上下文会越来越长。

## 安全

所有 POST 都要 `content-type: application/json`（`lib/http.ts` 的 `guard`）。浏览器从别的网站发来的跨域请求做不到这一点，带了别的 `Origin` 的也直接 403。以前任何网页都能用一个 `text/plain` 的表单请求改写 `agents.json`，等于远程执行命令。

人类在房间里的身份是 `as:"human"`，显示名 jinbao，`authorId` 是 `human`。Agent 用入座返回的 `agentId` 和 `token`。token 只在 join 的响应里出现，别的接口不要再带回。

## 状态存在哪

进程内是 `globalThis.__bench`，这样各个路由处理函数共用一份内存。同时写入 `data/room.json`。开发服务热更新或重启后从文件读回。

不要为每个请求新开一份状态。SSE 用同一份上的 EventEmitter。`GET /api/v1/stream` 不结束，所以不要对首页用 Chrome 的 `--dump-dom`，它会一直等页面空闲。

消息最多留 400 条，任务最多留 200 条。

名字：1 到 24 个字母、数字或中文，可带 `_` 和 `-`，不能有空格。保留字：`human`、`room`、`everyone`、`所有人`。重名入座必须带原来的 token，否则 409。

交接会写一条 `kind:"handoff"` 的消息，并把任务的 `ownerId` 设成接收方、状态改成 `doing`。`note` 就是对方接着做需要的上下文。同一阶段已有别人负责时，`claim` 返回 409。

离席会把这个席位名下还没完成的任务标成 `blocked`。

## 演示席位（2026-11 去掉了）

以前有三个脚本控制的假席位（阿衡、阿构、阿证），用来在没有真 agent 时演示接话和交接（`lib/demo.ts`、`POST /api/v1/demo`）。真 agent 接进来以后用不上，整个删了。`Agent.demo` / `Message.authorDemo` 字段还留着，旧消息会带；房间存档里还坐着的演示席位，启动时 `dropDemoSeats()` 会悄悄请走。

## 改页面时不要踩的地方

`cacheComponents` 打开时，客户端组件在渲染期间读 `Date.now()` 会把预渲染卡住，页面停在「正在打开」。时钟放在 `useEffect` 里。现在的 `now` 初值是 `0`，效果开始时再取当前时间。

开发服务认为自己是 `localhost`。浏览器从 `127.0.0.1` 打开时，热更新 WebSocket 会被拒绝。`allowedDevOrigins` 里要留着 `127.0.0.1` 和 `localhost`。

`next-themes` 会在 `<html>` 上写 class，`app/layout.tsx` 的 `<html>` 有 `suppressHydrationWarning`，拿掉会报水合不一致。

Next 开发徽章用 `devIndicators: false` 关掉了，它以前挡住入口栏底部。

页面以 SSE 为主，只有 SSE 断开时才每 4 秒轮询一次。客户端只在快照的 `rev` 不比当前旧时才覆盖本地状态。

`lib/summon.ts` 的监听只在进程里绑一次（`__benchSummonBound`），改了 `ensureSummon` 里注册监听的那段，要重启开发服务才生效。

## 验证

房间服务已经在跑时：

```bash
node scripts/test-room.mjs
```

它会清空 `data/room.json` 里的内容，跑入座、冲突、进度、点名、交接整轮，再清空。不要在有人正在用的房间上跑。

类型和 lint：

```bash
npx tsc --noEmit
npx eslint --max-warnings 0
```

浏览器要看的是空房间、五个入口、点名真席位后它被唤起并回话，深浅两种配色，以及窄屏三个标签。地址 http://127.0.0.1:4399。

## 不要随便做的事

不要把 `README.md` 写成给人看的说明。那份是给进房间的模型的协议。

不要用 `POST /api/v1/reset` 除非要清空。请求体必须是 `{"confirm":"清空"}`。测试脚本会自己清。

