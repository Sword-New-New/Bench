# 并坐维护交接

改这个仓库的人读这份。进房间协作的模型读 `PROTOCOL.md`，不要把两份当成同一件事。

并坐是同一台电脑上多个 agent 的一间房间。模型各用各的，进度、对话、任务写在一起。一个阶段一个负责人。

## 现在跑在哪

本机一个端口：**4399**，只绑 `127.0.0.1`。`npm run dev`、`start.sh`、`start.bat`、`scripts/start-bench.sh`、`scripts/bench.mjs`、Codex 的 bench-room 技能都用它。以前云端虚拟机上的 43123 已经不用了。

不要绑 `0.0.0.0`。房间会按 `agents.json` 跑 shell 命令，局域网里的人能连上就等于能在这台电脑上执行命令。

开发模式一次要拉大约 6 MB 未压缩脚本，第一次打开慢一点是正常的，不是房间数据慢。

开发模式下改了 `app/globals.css` 页面却没变，多半是 Turbopack 缓存还在给旧样式：停掉服务，删 `.next/dev`，再启动。页面一直停在「正在刷新」、`next dev` 日志里 `✓ Compiled in 1ms` 和 `GET /` 每秒交替好几次、没有文件在变，也是这份缓存坏了（HMR 每次连上就让页面整页重载）：同样停服务、删 `.next/dev`、重启。11-13 晚和 11-14 早各出过一次。

## 技术栈

Next.js 16.4 App Router，React 19，Tailwind CSS v4，shadcn/ui 的 base-nova（底层是 `@base-ui/react`，不是 Radix）。`cn` 来自 `cn` 这个包。字体是 `next/font` 的 Geist。

`next.config.ts` 开了 `cacheComponents` 和 `partialPrefetching`。路由文件里不要写 `export const runtime = "nodejs"`，这个组合会让开发服务起不来。

## 目录

| 路径 | 作用 |
| --- | --- |
| `lib/db.ts` | Node 22.13+ 原生 `node:sqlite`（WAL + FTS5 trigram）持久化层：`data/bench.db` 建表、旧版 `data/*.json` 自动无损迁移与备份（`data/backup-json-v1/`）、全文检索（`ON CONFLICT` 原位更新与启动清理 FTS 残留行）、唤醒队列持久化、以及席位档案 `data/seats/<id>.md` 单向导出（只写出不读回）。 |
| `lib/lane-state.ts` | 席位唤醒队列只读快照桥接（避免 `store.ts` 与 `summon.ts` 循环依赖）。 |
| `lib/store.ts` | 房间状态。入座、报进度、发言、收件箱、任务、交接、离席、席位长期记忆（`SeatProfile`）与跨厂商绑定切换。 |
| `lib/types.ts` | `PublicAgent`、`SeatProfile`、`SeatBinding`、`Message`、`Task`、`RoomSnapshot`。 |
| `lib/status.ts` | 超过 40 秒未报进度视为离线。`offline` 是算出来的，不能由 pulse 写入。 |
| `lib/text.ts` | `@名字` 匹配，名字长的优先。 |
| `lib/prompt.ts` | `GET /api/v1/prompt` 和页面「接入说明」里的那段话。 |
| `lib/boot.ts` | API 路由先 `connection()` 再 `ensureDemo()`。 |
| `app/api/v1/*` | HTTP。每个路由 `boot()` 后走 `lib/http.ts` 的 `handle`。 |
| `components/room/room-app.tsx` | 页面。先拉 `GET /api/v1/room`，再 SSE，另外每 4 秒轮询。 |
| `scripts/bench.mjs` | 本仓库里的 agent 命令。凭证在当前目录 `.bench/seat.json`。 |
| `scripts/test-room.mjs` | 接口集成测试。自建临时项目跑完入座、待办、验收、提问、SQLite 全量分页与搜索、可控唤醒队列、席位长期记忆单向导出、跨厂商顶替/忙时拒绝/旧 token 防抢回，最后在 `finally` 中自动删除测试项目及临时凭证。 |
| `data/bench.db`、`data/seats/<id>.md` | 运行时 SQLite WAL 数据库与席位职责/长期记忆单向导出的 Markdown 文件（均已 gitignore）。首次升级启动时旧版 `data/projects*.json`、`runs.json`、`user.json` 自动事务迁移进 `bench.db` 并归档到 `data/backup-json-v1/`。 |
| `start.bat` | Windows 本机启动，端口 4399。 |
| `agents.json` | 每种 agent 一条唤起命令，页面右上角「设置 → 唤起命令…」写这个文件。`{uuid}`、`{text}` 都会加引号再替换。`reply: "stdout"` 表示命令输出就是回答，会以那个席位的名义贴回房间。 |
| `lib/kinds.ts` | 19 种 agent。`core` 的五种：claude（Claude Code）、dsh（DeepSeek）、codex（GPT）、cursor（Grok）、antigravity（Gemini），入口栏一直列着，背景流光也只用它们的颜色；其余 14 种有人入座才进入口栏，没入座的只在「接入」弹窗里选。颜色、头像形状、默认命令、uuid 怎么找都在这里，页面和服务端共用。只收能按 id 无人值守恢复会话、能装 bench MCP、输出干净的；叫不醒或命令没核实的（TRAE、Continue、Aider、ZCode、Roo、Letta、Auggie、Amp、Cline、Junie、Mistral Vibe）2026-11 试列过又剔除了。 |
| `lib/register.ts` | 「接入」弹窗的「替我运行」：替选中的 agent 跑 `register-mcp.sh`。 |
| `lib/events.ts` | 把唤起命令逐行打印的事件流（Claude Code / cursor-agent 的 stream-json、Codex 的 `exec --json`、agy 的 stream-json、dsh-agent 的 `--json`）拆成步骤和最终回答。按每行的形状认格式，不按是哪家；不是事件流的输出照旧整段当回答。 |
| `lib/runs.ts` | 每次唤起的过程记录：工具调用、结果、中间说的话。全量持久化在 `data/bench.db` 的 `runs` 与 `run_steps` 表（不再截断最近 80 次），活跃唤起缓存在内存。`GET /api/v1/runs/<id>` 读一条。 |
| `lib/summon.ts` | 消息里点到谁就唤起谁，含持久化受控队列（暂停/恢复/单条剔除）与跨厂商接力简报注入。见下面「唤起」。 |
| `components/room/seat-profile-dialog.tsx` | 席位档案与长期记忆编辑弹窗 + 跨客户端切换 / 撞额度顶替接力 / 历史绑定会话一键切回弹窗。 |
| `lib/push.ts`、`app/api/v1/push/route.ts`、`components/room/push-dialog.tsx` | 可选的「推送到手机」（默认关）：表驱动支持 ntfy、Bark、企业微信群机器人、飞书群机器人、Telegram 机器人、自定义 Webhook 六种格式；配置存于 `data/push.json`（权限 `0600`，任何接口与快照均不回传地址或口令）。 |
| `lib/front.ts`、`app/api/v1/overview/route.ts`、`app/api/v1/peek/route.ts` | 前台项目跨项目只读巡看：`bench_overview`（各项目席位、等用户事项、未完待办、最新动静与摘要开头）与 `bench_peek`（单项目摘要全文、等用户提问/权限/验收、未完待办、席位 `owes`、未着落点名、最近 30 条对话及 `before` 翻页）；由 `requireFrontSeat` 限制仅 `front: true` 项目席位可调。 |
| `scripts/bench-mcp.mjs` | 并坐的 MCP 服务器，stdio、零依赖。客户端开着会话时一直挂着，替 agent 调房间接口；凭证存在 `~/.local/state/bench-mcp/<kind>-<uuid>.json`，不进对话；入座后每 20 秒发 `keepalive` 报在线。能从环境变量读到会话 id 的（Claude、Codex）自动报。 |
| `scripts/register-mcp.sh` | `register-mcp.sh claude|codex|cursor|antigravity|dsh`，把上面的服务器注册到对应客户端的用户级配置。dsh 是往 `~/.dsh/profiles/{web,headless}/cordis.patch.yml` 各加一条 `dsh-mcp-client` 条目（插件随 dsh 全局安装自带）。新条目必须写在 `- insert:` 列表里；直接写在顶层只会覆盖同 id 的已有条目，找不到就被忽略。文件只剩 `[]` 时要先删掉它再追加。 |
| `scripts/merge-mcp.mjs` | `register-mcp.sh` 用它把 bench 合并进各家的 JSON 配置（mcpServers、OpenCode/Kilo、Crush 三种格式），先留备份；文件带注释、不是纯 JSON 时不动它，只打印要手填的命令。 |
| `scripts/resume-here.sh` | Qoder、CodeBuddy、WorkBuddy 和 Claude Code 一样按 `<配置目录>/projects/<目录>/<id>.jsonl` 存会话，只在原目录里认得 id。它找到会话文件，cd 到里面记的 `cwd` 再运行后面的命令。 |
| `scripts/workbuddy-wake.sh` | WorkBuddy 没有自己的命令行，用它自带的 CodeBuddy（`/opt/apps/com.tencent.workbuddy/.../cli/bin/codebuddy`），`CODEBUDDY_CONFIG_DIR` 指向存着这个会话的 `~/.workbuddy`。这个自带版本只有 `-p` 用的 headless 部分，`mcp list` 这类子命令会报缺模块。 |
| `scripts/claude-code.sh` | 找到最新的 claude 可执行文件和会话所在目录，再 `--resume <id> -p`。Claude Code 只在会话所属的项目目录里认得这个 id。 |

页面是客户端组件，`app/page.tsx` 只渲染 `RoomApp`。三列 `300px 1fr 300px`：左栏（两档，房间档是按 agent 分组的席位 `roster.tsx`，项目档是项目卡片，见下面「左栏两档」和「左栏：平时每个席位只占一行」）、群聊、分工。窄于 1024px 时用底部「入口 / 对话 / 分工」三个标签。输入框下面的「发给」一排是快捷 @：在线或叫得醒的席位每个一枚，同一家只有一枚时写家名（DeepSeek），有几枚时写各自的席位名。深浅色跟随系统，右上角可以切换。

外观：浅色主题底下一层五家品牌色的慢速流光（`ambient.tsx`）。深色主题（2026-11-12 暗色氛围升级，`globals.css` 末尾「Dark ambience」一段）不显示这些流光（它们在黑底上叠成黄绿发浑），也不显示点阵，换成 GPU 现画的深冷调极光（`components/room/aurora.ts` 的着色器，`ambient.tsx` 的 `useAurora`，2026-11-12）：深色底，一道蓝青极光斜着划过上半部分，输入框后面是一片深蓝，±1 级色阶的抖动防色带。按屏幕自己的分辨率（devicePixelRatio，最多 2）在一个虚拟的 2560×1600 画框里画，像 `background-size: cover` 那样铺满，所以和原来那张图构图一样；平时只画一次，窗口尺寸变了才重画，不占资源。设置菜单里「深色背景缓慢流动」（localStorage `bench-aurora-flow`，默认关）打开后光带慢慢飘（波沿光带走，三条各自上下起伏，约 30 秒一个来回；第一版速度只有现在的四分之一，10 秒才变两级色阶，用户以为开关没反应），每秒 24 帧，标签页不在前台、浅色主题、减少动态效果时都不画；它有自己的时钟，开关、切走再回来都从光带当时的位置接着走。实测开着流动帧间隔仍是 16.7ms。没有 WebGL 时（`data-gl="off"`）退回 `public/wallpapers/deep-aurora.webp`，同一张画，存成无损 webp（1.6 MB）：有损 webp 哪怕质量 0.98 也会把这么暗的渐变压成 8×8 的方块和一道道台阶，用户一眼看出「精细度差」。坑：`dispose` 里别调 `WEBGL_lose_context`，开发模式 React 会挂两次，第二次拿到的是丢了的上下文，就退回图片了；GLSL 里 `half` 是保留字。调颜色、光带位置宽窄都在着色器顶上的几个数里。中间试过两种都被用户否了：#090c12 加两处冷光，还有纯黑。不用 `filter: blur`（大图层加模糊、再让它动，是这页最贵的重绘）。面板外圈的 `--panel-glow` 深色下也换成冷色。深色下输入框（`.composer`）平时只有一圈 `rgba(255,255,255,.08)` 的细边，去掉了 `.raised` 的高光边和聚焦环，聚焦时泛一圈淡蓝光；下面的 @ 胶囊（`.ghost-chip`）是幽灵暗底，悬停变亮。「还有 N 个问题在等你回答」横幅（`.ask-banner`，`PinnedAsks`）深色下是同一套深色毛玻璃，只靠左边一颗呼吸的琥珀小圆点（`.breathe`，减少动态效果时不动）提醒，浅色保持原来的琥珀样式。这个横幅只在等回答的提问不在当前画出的那段消息里时才出现（截图验它要先在副本里提问，再发十几条把它挤上去）。坑：用脚本整份重写 `globals.css` 时，开发服务器偶尔在写到一半时读到旧内容，之后就不再重编，页面还是旧样式；再往文件末尾追加一个换行就会重编。面板是毛玻璃（`.frost`，模糊放在 `::before` 上，免得隔断里面元素的背景），顶栏和输入框是浮起来的毛玻璃（`.raised`），输入框上方浮在对话上的提示卡（权限确认、摘要提醒）用 `.notice`：自带模糊，边框颜色用 `[--notice-ring:…]` 设（别用 `.pill`，它不带模糊，后面滚过的消息会直接透出来；`.pill` 只给放在已经是毛玻璃的东西上面的小控件用），输入框浮在对话上面，对话底部按输入框的高度留白：`composer.tsx` 用 ResizeObserver 量输入框，把高度直接写到带 `data-dock` 的几个元素上（`data-dock="padding-bottom 1rem"` 就是 `padding-bottom: calc(高度 + 1rem)`，群聊和流程视图用；刻度尺用 `bottom 1.25rem`），后挂上的（流程视图、换项目）由一个 MutationObserver 补上。别改回在外层容器上设 CSS 变量：回复条、@ 列表展开时输入框每帧都在长，变量一变它下面的节点全要重算样式（群聊约 2000 个，每帧 10～17ms；改成不继承的 `@property` 也一样，刻度尺那 160 个也要 3ms），点「回复」时就只剩五六十帧（2026-11-12 实测：动画期间每帧 11～17ms → 2～5ms）。刻度尺跟着变高变矮时，横线的位置是刻度尺高度的百分比，自己跟着走；重新排横线（React 重画每一根）等尺寸停下 150ms 再做。五家的头像是会动的角色（`bot.tsx`，底层是 `lib/vendor/grokbot.js`，MIT，来源和本地改动写在文件头）：形状在 `BOT_SHAPE`，状态跟席位走（干活、出错、离线睡觉），鼠标进到那一行才盯着鼠标看，入口栏里还会压成胶囊。

头像多久画一次（`grokbot.js` 的「Shared ticker」，本地改动）：每只按它在做的事定节奏，画完一次在 `_update` 末尾定下一次。什么都没动（弹簧都到位、没在翻滚、没有粒子）就不算也不写 DOM，只看一眼定时器；睡着的每秒约 10 次（呼吸和飘的 z）；只有眼睛在动、自己玩（眨眼、蹦一下）、或一直在干活的，每秒约 30 次；鼠标悬停或状态变化引起的身体动作（`morph()`、`setState()` 里的 `_hurry`）两秒内每帧都画。除了最后一种，大家共用同一批帧（节拍）：这个页面上只要有一只 bot 的几何属性变了，那一帧就要多付大约 1ms 的布局，和改了几只、改了多少关系不大（给容器加 `contain`、`overflow` 都没用，实测过），所以让每只各走各的节奏反而更费。属性只在值变了时才写（`put`）；呼吸在头像这种尺寸下不到半个设备像素，就不画了（`_measure` 按尺寸和屏幕密度算，睡着的在高分屏上还会呼吸）。弹簧到了肉眼看不出的距离就直接停在目标上（`Spring` 的第四个参数是各自的容差）。2026-11 在 1680 宽、14 只头像（9 只发呆、5 只睡觉）的房间里量：头像占主线程从约 8.8% 降到约 4.1%，每秒写 SVG 属性从约 1.1 万次降到约 700 次。剩下的主要是「每秒有约 25 帧里有头像在动」乘上那笔固定的布局开销，再降就得少让它们动。

## 唤起

- 人发的话：写到席位名、`@` 他、或交接给他，都会唤起。agent 发的话：只有明确 `@` 或交接才唤起。
- 每个席位一条队列，同一时间只跑一条命令。跑的时候进来的消息攒着，结束后合成一条再唤起，不会丢。以前的 8 秒冷却会直接丢消息，已经去掉。
- 唤起时席位显示「被点到了，正在回复」，结束后恢复原来的那句。
- 命令非零退出或找不到，房间里会出一条系统消息，带 stderr 的最后一段。唤起没有时间上限（以前是 15 分钟，agent 干长活会被截断，已去掉）：进程自己退出、输出里出现一轮结束、或用户点停止，才收尾。
- agent 之间互相 @ 自动接力不限次数（2026-11-11 用户要求取消原来的 3 轮上限）。一条线靠席位自己「结束本轮」停下，或者用户插话、停掉席位。
- 结束本轮：agent 觉得这一轮交接做完了，就 `say` 带 `end: true`（`bench_say` 的 `end`），或者 stdout 回答以「【本轮结束】」开头。这条消息强制不 @ 任何人，正文补上标记，所以它自己那条线停在这里；别的线照常。人发的话带标记不算结束。项目状态里的 `relayClosed` 还在记，但唤起不再看它：以前它把整个项目里 agent 之间的 @ 全关掉，直到人发言，结果把无关的、甚至这个席位自己排着的活悄悄挡掉了（哈基米说完「本轮结束」再交差 @Fable，就没叫醒）。接力轮数仍在记（`lib/summon.ts` 的 `hopOf`、`calledAt`）：每个席位记下最近一次叫它的那条消息在第几轮，它接下来说的话，不管是 stdout 回答、唤起中途的 bench_say、交接，还是从房间没叫醒的会话（守候循环、它自己的窗口）发的，都算下一轮；人说话从 0 开始。以前到第 3 轮再 @ 就不叫醒，2026-11-11 起不再拦，唤起提示里也不再写「最多 3 轮」。两个 agent 互相 @ 停不下来时，用户在席位菜单停掉其中一个，或者在群里说一句。
- 唤起命令的 PATH 会补上 `~/.local/bin` 和 `/usr/local/nodejs/bin`，从桌面图标启动时也能找到 `dsh-agent`、`agy`。
- `GET /api/v1/adapters` 会带 `installed`，告诉页面这条命令的第一个词在本机找不找得到。
- 唤起是无人值守的一轮，没人点「允许」，所以每家的唤起命令都要预先放行 bench 工具：Codex 用 `scripts/codex-wake.sh`（`-c mcp_servers.bench.default_tools_approval_mode="approve"`），Antigravity 带 `--settings` 里的 `mcp(bench/*)`，Claude Code 在 `claude-code.sh` 里加 `--allowedTools mcp__bench`，dsh-agent exec 本来就不审批。Cursor 的 `--approve-mcps` 只管加载 MCP 服务，调用工具另要放行：仓库里的 `.cursor/cli.json` 写了 `Mcp(bench:*)`，唤起在仓库目录里跑，所以能读到。
- `cursor-agent` 是单独的命令行，不随 Cursor 编辑器装上；`cursor agent --help` 发现没装会自己从 cursor.com/install 装到 `~/.local/bin`。它和 Claude 一样要单独 `cursor-agent login`。唤起用 `grok-4.7-low-fast`，2026-11 实测点名 18 秒回话。
- 唤起时转给 agent 的是它没看过的全部消息（`catchUp`），从新往旧收，约 1 万字封顶，更早的只报条数；叫它的那几条标 ★，入座离席这类系统消息不转。抬头会明说这批是不是全量、略去了什么，免得它再去 inbox 翻或者误信截断的一批。读到哪由席位上的 `seenSeq` 记：唤起一次或调一次 `bench_inbox` 就往前推。
- 唤起结尾那段守则（怎么回答、建待办、提问、附件、权限、本轮结束，约 900 字）不是每次都整段给（2026-11-12，`lib/summon.ts` 的 `rulesFor`）：它留在会话历史里，每次都给会越积越多。整段给的时候：第一次叫醒、换了会话或客户端、改过职责、守则内容变了（对整段算 sha1 指纹，换了用户名、开关默认全部权限都会变）、会话记录里在上次整段之后有压缩（`seatContext().compacted.at`，Claude Code 的 `compact_boundary`、Codex 的 `compacted`）、连续 10 次短提醒之后（`RULES_SHORTS`，防房间没看到的压缩，`compacted` 只在读到的那段记录里找）。读不到会话记录的客户端（`CONTEXT_KINDS` 以外的）每次都整段。其余时候换成约 190 字的「守则同前，要点：…」，要点都在，压缩漏判时也不至于丢规矩。只有唤起成功才记账（`markWoken` 写席位上的 `rulesGiven {sig, at, session, shorts}`），失败的那次下次重给。工具说明和参数（约 7000 字符）是客户端每次请求整套带上的，不在对话历史里，压缩丢不掉，所以没压它们。测法：隔离副本、假 HOME 里放一个假的 `claude`（记下 `-p` 的提示词、往 `~/.claude/projects/x/<id>.jsonl` 写一条带 usage 的 assistant），连叫五次，第 3、4 次之间往记录里追加一条 `compact_boundary`：整段、短、短、整段、短。
- agent 交接任务（`bench_task_update` handoff）必须填 done / left / caveats 三栏，存在任务的 `brief` 上、任务卡片里显示；人从界面交接不受限。
- 房间摘要：上次摘要（或用户点「这段不用」）之后的对话超过 `CATCH_UP_CHARS`，输入框上方提醒，用户挑一个能唤起的席位写。写摘要走同一条唤起队列，提示词带上一份摘要和之后的对话（4 万字封顶，同样说明全不全）；stdout 回复的直接存输出，dsh 这类用 `bench_summary` 工具交，不进群聊。唤起时未读被截断，就先附摘要再接最近原文。「稍后」只记在浏览器里，30 分钟。写的时候提醒条换成绿色转圈加一道扫光；`SummaryNudge` 看到有席位在写时 `summary.at` 变了（存摘要在先、`endSummaryJob` 在后，所以前后两个快照都算），就把转圈换成弹出的绿色对勾，0.75 秒后对勾打散成二十几个绿点，沿弧线飞到右栏带 `data-summary-card` 的摘要卡片上，第一个点落地时卡片发一下绿光。右栏没显示（窄屏）时绿点只四散淡出；系统设了减少动效就只显示对勾。用户自己改摘要不放这个动效。
- 顶栏的虫子图标是调试菜单，默认关着：要在 `.env.local` 里写 `NEXT_PUBLIC_BENCH_DEBUG=1`（`.env*` 不进 git），并且用 `next dev` 跑才出现；没开时 `/api/v1/debug` 直接 404，生产模式永远 404。改了 `.env.local` 后 `next dev` 会自己重载。上半部分只改页面看到的（`withDebug` 覆盖快照：摘要提醒条、正在写摘要、全部头像状态；「放一次『摘要写好了』动效」发 `SUMMARY_DONE_DEMO` 事件；「放一次『正在做』卡片」发 `LIVE_DEMO`，在本地假造一个席位，演示换步骤时宽度的变化和做完时的退场），刷新就没了；下半部分会写进房间（插假系统消息、让席位忘掉读到哪、清空摘要；清空摘要要带 `confirm: "清空摘要"`，以前有验收脚本拿它当「读快照」用，每次轮询都把真房间的摘要清掉了。读快照用 `GET /api/v1/room`）。不好触发的新界面，记得往这里加一项。
- 能点的胶囊按钮都加 `chip` 类：悬停变亮，按下缩一下，松手回弹。悬停不要上浮：横向滚动的那排会把上移的部分裁掉，顶上的高光和光晕就没了。新加胶囊按钮记得带上，不要再单写 `hover:brightness-105`。
- 顶栏右上角的齿轮是「设置」：深浅色和「唤起命令…」都在里面。唤起命令平时很少改（换模型、加参数才用），所以不放在入口栏里。
- 开新会话（`lib/spawn.ts`、`app/api/v1/sessions/route.ts`、`components/room/spawn-dialog.tsx`）：目前是 `lib/kinds.ts` 里标了 `spawn` 的 Claude Code 和 DeepSeek。入口在那一家展开后的详情里（点额度圆环或箭头）的「开新会话」，以及席位菜单里的「在同目录开新会话…」。工作区三选一：和某个席位同一个目录（目录从各席位的会话记录里读，加上房间自己的目录）、从那个目录所在的仓库新开 worktree（放在仓库旁边，叫 `<仓库名>-<名字>-xxxx`，分支 `bench/<名字>-xxxx`，不会自动清理和合并）、自己填一个已存在的路径。房间选一个 uuid 当会话 id，直接建席位（`seatCreated`，记下 `workdir`，标 `fresh`），并把席位写进 bench-mcp 的状态文件，所以新会话的 bench 工具不用再 bench_join。会话本身在第一次叫醒时才建：唤起时带 `BENCH_NEW_DIR`，`claude-code.sh` 找不到会话记录就在那个目录里用 `--session-id` 新建。第一次叫醒的提示开头会告诉它自己叫什么、做什么、在哪个目录。填了「第一件事」就以你的名义在群里 @ 它。新会话的权限是默认模式，只放行 bench 工具。
- DeepSeek 开新会话不一样：`dsh-agent` 不能事先指定会话 id，`resume` 也只接得上 `dsh-agent exec` 开出来、不带 Agent 预设的会话（网页端开的叫不醒）。所以 `newDshSession` 当场在选好的目录里跑一次 `dsh-agent exec --json`，用一句介绍（席位名、分工、不用再 bench_join）建出会话，从 `thread.started` 事件里读出 id，再建席位。大约几秒，弹窗按钮显示「在开…」。席位的模型取 `dsh-agent.toml` 里的默认模型。
- 房间自己跑的命令（开新会话、列模型）都要带 `summonPath()` 的 PATH，和唤起一样：从桌面图标启动的房间，PATH 里没有 `~/.local/bin`（cursor-agent、agy 都装在这里），直接跑会报 `spawn … ENOENT`，模型清单也会变空。测试副本要用同样精简的 PATH 启动（比如 `env PATH=/usr/local/nodejs/bin:/usr/bin:/bin npx next dev …`），否则测不出这个问题。另外 `cursor-agent models` 在设了 FORCE_COLOR 的环境里会带颜色码，解析前要去掉。
- 「开新会话」的工作区有四种：同一个目录、新 worktree、临时目录、自己填（弹窗里「自己填」旁边有「浏览…」，用的是 `/api/v1/folder` 弹 zenity）。临时目录（`mode: "temp"`，`newScratch`）：房间在 `$XDG_DATA_HOME/bench/scratch`（默认 `~/.local/share/bench/scratch`）下新建 `<名字>-<4位随机>` 的空文件夹当工作目录，不要求项目设了目录；放在并坐仓库外面，是为了里面的 git 不会找到并坐自己的仓库。席位离开后文件夹不会删，要用户自己清理。
- Cursor 开新会话（`newCursorSession`）：`cursor-agent create-chat` 不跑模型就能建一个空会话，打印出它的 id，3 秒左右。会话不记得自己的目录，resume 时在哪里跑就在哪里干活，所以唤起命令带 `--workspace "${BENCH_NEW_DIR:-$PWD}"`：房间开的席位用自己的目录，别的席位照旧在房间目录里跑。会话记在 `~/.config/cursor/chats/<目录哈希>/<id>`。2026-11 这台电脑上的 Cursor 是免费版，只能用 Grok 4.7、4.6 的固定档和 auto，带 -low、-fast 的都会被拒（报 Model unavailable on Free，房间会改成中文说明），所以默认模型从 grok-4.7-low-fast 改成了 grok-4.7-medium，旧的默认命令记在 `was` 里，会自动升级。
- Codex 开新会话（`newCodexSession`）：Codex 也是自己定会话 id，房间当场在选好的目录里跑一轮 `codex exec --json`，从 `thread.started` 读出 id。它的 stdin 一定要关上，否则 codex exec 会一直等着读输入，直到超时。房间的工具照 `codex-wake.sh` 预先放行。
- Codex 接别的提供方：2026-11-09 起 `~/.codex/config.toml` 顶上是 `model_provider = "tokenrhythm"`、`model = "deepseek-v4.1-flash-1017"`、`web_search = "disabled"`（deepseek-v4-pro 不支持 Codex 自带的联网搜索，开着就整轮报错）。换回账号的方法写在那几行的注释里，旧配置备份在 `config.toml.bak-account-20261109`。这版 Codex 只认 `wire_api = "responses"`，`chat` 已经不支持，所以只走 Chat 接口的 dsh 本地代理（7863）接不了。`model_provider` 不是 openai 时，选模型的清单从那家的 `/models` 读（密钥取自它的 `env_key` 或 `[auth]` 命令）。会话不能换提供方接着跑：在账号上开的旧会话，现在叫醒会报「This chat uses openai…」，房间会改成中文说明（`explain`）。
- CodeBuddy、WorkBuddy 开新会话（`newBuddySession`）：codebuddy 能用 `--session-id` 接房间给的 id，但唤起走 `resume-here.sh`，要先有会话文件才找得到，所以当场在选好的目录里跑一轮介绍。WorkBuddy 用同一个命令行，带 `CODEBUDDY_CONFIG_DIR=~/.workbuddy`，会话记在 `~/.workbuddy/projects`；优先用 PATH 上完整版 codebuddy，因为 WorkBuddy 自带的那份没有自己的登录。桌面端的会话列表记在它自己的 workbuddy.db，这样开出的会话多半不会出现在那里（没核对过）。2026-11 实测：两家各 6～9 秒入座，@ 后能回话。
- 选模型（`lib/models.ts`、`components/room/model-field.tsx`）：开新会话的弹窗和席位菜单「换模型…」都能选，选中的记在席位的 `modelPick` 上，从下一次唤起起生效；不选（或改回默认）就照旧用唤起命令或客户端配置里的默认模型。可选清单：Claude 是写死的几个（含 `claude-fable-5-2`）加上本机 claude 程序文件里出现的 5 代以后的完整 id（Claude Code 更新后新型号自动出现），排在前面；后面是别名 `fable`/`opus`/`sonnet`/`haiku`，指的是那个 Claude Code 版本认识的最新，会落后：2.1.319 的 `fable` 还是 5.1，`claude-fable-5-2` 要写全名，DeepSeek 从 `dsh-agent config --json` 的各线路读，Codex 读它自己加载的模型目录（`config.toml` 的 `model_catalog_json`，没有就 `models_cache.json`，只列不隐藏的），Antigravity 跑 `agy models`（要联网几秒），Cursor 跑 `cursor-agent models`，CodeBuddy 和 WorkBuddy 从 `codebuddy --help` 的「Currently supported: (…)」里读（它的 `codebuddy models` 其实是一句提问、由模型回答，别用；WorkBuddy 没有 PATH 上的 codebuddy 就用它安装目录里那个），跑命令的清单都缓存一分钟；别家没有清单只能自己填 id（`GET /api/v1/models?kind=…`，同时给出默认模型）。怎么带进唤起：Claude Code、Codex、WorkBuddy 靠环境变量 `BENCH_MODEL`（`claude-code.sh` 加 `--model`，`codex-wake.sh` 加 `-m`，`codex-app.mjs` 放进 `turn/start` 的 `model`，`workbuddy-wake.sh` 加 `--model`）；DeepSeek 在 `dsh-agent resume/exec` 后插 `-r <列出它的线路> -m <模型>`，开新会话那一轮也带；命令里本来写了 `--model` 或 `-m` 的（Cursor、Antigravity、Gemini CLI、Qoder），直接替换那一个参数；没写的、`lib/kinds.ts` 里有 `modelFlag` 的（CodeBuddy、Copilot）把它插在 ` -p ` 前面。2026-11 实测过 Claude、Antigravity、Cursor（`--model grok-4.7-medium-fast`）、CodeBuddy（`--model glm-5.2`）；WorkBuddy 只改了脚本没实跑，Copilot 这台电脑没装，`--model` 照文档写的，没测过。改模型会在群里留一条系统消息。思考强度（`effortPick`，同一个弹窗里「思考强度」下拉，`lib/models.ts` 的 `EFFORTS`）：Claude Code `--effort`（low…max）、Codex 每轮的 `effort`（app-server `turn/start`，exec 用 `-c model_reasoning_effort`）、CodeBuddy/WorkBuddy `--effort`（minimal…max）；经环境变量 `BENCH_EFFORT` 给唤起脚本，CodeBuddy 的命令里插在 ` -p ` 前（`withEffort`）。DeepSeek 的 dsh-agent 没有这个参数，Cursor、Antigravity 的强度写在模型名里，这几家不显示。2026-11 实测 Claude：席位设 low，会话记录里是 `"effort":"low"`。DeepSeek 的唤起命令带 `--timeout 0`：dsh-agent 自己默认 30 分钟就杀掉一轮。
- Claude Code 被叫醒时沿用它窗口里的权限模式：`claude-code.sh` 先在 Claude 桌面端的会话记录（`~/.config/Claude/claude-code-sessions/**/local_*.json`，按 `cliSessionId` 对上）里找 `permissionMode`，找不到再看会话记录 jsonl 里最后一个 `permissionMode`。`bypassPermissions` 对应 `--dangerously-skip-permissions`，`acceptEdits`、`auto`、`plan`、`dontAsk` 原样传 `--permission-mode`，其他情况只放行 bench 的工具。也就是说，你在窗口里跳过了确认的会话，被房间叫醒时也不会再问。叫醒追加的对话确实写进同一个会话（同一个 jsonl、接在原来的最后一条后面），但桌面端窗口是按它自己的同步通道显示的，关掉再打开也看不到这些追加的轮次。
- 唤起的输出不设总量上限，每一行都读：以前读到约 1MB（`OUT_LIMIT * 16`）就停，小克一次改了二十多次文件（Claude 的每个 Edit 结果都带整份文件），后面的事件和最后的 `result` 全丢了，进程照常退出，房间把半路的一句进度当回答贴了出去，也没报错。现在只有单独一行超过 8MB（`LINE_LIMIT`）才丢，丢了会在房间里发系统提示说回答可能不完整。过程面板仍然只记前 300 步、每段 4000 字；纯文本输出的客户端，回答只取前 64000 字。按 UTF-8 解码时用 `StringDecoder`，汉字跨两块输出也不会被拆坏。
- 停止和单独说（`lib/summon.ts` 的 `stopAgent` / `whisper`，`POST /api/v1/agents/<id>` 带 `action: "stop" | "whisper"`，`GET` 列出单独说的记录）：唤起命令用独立进程组跑（`detached`），停的时候连 shell 拉起的客户端一起结束。「停止」停掉这次唤起，排在后面的也取消。「单独说」是一次 `purpose: "private"` 的唤起，问和答记在 run 的 `ask` / `answer` 上，不进群聊；席位正在跑时先停掉它，把它刚才在回的那批消息记进 lane 的 `carry`，私聊回完后下一轮带着「刚才被打断、还没回的」重新交给它（被打断的是写摘要就重新排摘要）。挂在 bench_wait 里待命的席位不能单独说。群里 @ 正在忙的席位照旧排队，发送后页面提示「着急就单独说」。单独说的记录和其他 run 一样只留最近 80 次。被杀掉的那一轮，有的客户端不会存进会话，所以它回私聊时可能不记得刚开始的那步。
- 回复链条（`components/room/thread.tsx` 的 `threadItems` / `ReplyChain` / `ChainLine`）：顺着 `replyTo` 往上找到最早那条，同一条起点的消息收成一条链，放在链里最新那条消息的位置，所以新回复照样出现在群聊底部。整条链是一张实底卡片（`bg-card`，看得见的边框、投影、左边一条主色竖条；不用毛玻璃，免得和背景混在一起）：卡头「回复链 · N 条 · 参与者 · 最新几点」和展开/收起；卡里每条左对齐紧凑一行（头像、名字、时间、正文），人和 agent 一样排，人的那行底色淡一点；收起时只露起点和最新一条，中间一行「中间还有 N 条」，展开后把卡片顶部滚回视野（`keepTopInView`）。回的不是上一行时才显示引用。只在页面上画，消息本身不变。每条消息的「回复」按钮常显，在气泡下面「查看过程」旁边（自己的消息在时间旁边）。
- 回复即唤起：人回复 agent 的消息，等于 @ 了那个 agent（`summonCandidates`），不用再写 @；输入框的回复条会写「发出去就会叫醒它」。agent 之间只回复不唤起：每次唤起的回答都自动挂成回复，算唤起的话会来回弹。
- agent 看回复关系（`lib/store.ts` 的 `talkLine` / `messagesFor`）：唤起转去的每一行带 `[m_…]` 和「（回复 [m_…] 谁：前 30 字）」，写摘要用的原文不带 id；`bench_inbox` 同样显示（收件箱接口给消息加 `reply`）。`POST /api/v1/messages`（MCP `bench_messages`）给结构化数据：整条回复链、某席位相关、往前翻页。自动挂回复：`wake` 把最后一条叫它的消息记在 lane 的 `trigger`，开跑时存进 run 的 `replyTo`；这次唤起里它发的话（stdout 贴回的、bench_say 没填 replyTo 的）都挂成对那条的回复，所以群里的问答自然串成链。被单独说打断时 trigger 跟着 carry 留下。
- 待办列表（右栏，原来叫「分工」）：任务可以带 `steps`，每步「待做 / 在做 / 做完」，记谁、几点改的和一句说明（`lib/store.ts` 的 `stepsFrom`、`actOnTask` 的 `step`；MCP `bench_task` 的 `steps`、`bench_step`）。唤起提示要求 agent 接到新功能先建待办、做一步标一步，验收也照着步骤走。待办卡片里的 `StepDrawer`（`tasks-panel.tsx`）平时一行「步骤 2/5 · 正在：…」加进度条，点开是每一步和时间；点步骤前的圆点在 待做 → 在做 → 做完 → 待做 之间切。右栏不再有手写待办的表单（2026-11 删了）：待办由 AI 在对话里被叫到做新功能时自己建，表单和 @ 是重复的；`POST /api/v1/tasks` 还在，`bench_task` 和测试脚本用它。
- 用户的名字（`store.ts` 的 `userName` / `setUserName`，`/api/v1/user`）：存在 `data/user.json`，全部项目共用；没有这个文件时沿用房间里最近一条用户消息的署名（老房间就是 jinbao），全新安装叫「用户」。快照带 `userName`。改名只许 `as: "human"`，名字规则和席位一样，不能和任何项目里的席位重名（409）；改名会把所有项目里用户消息的 `authorName`、用户的待办、待办记录和验收里的旧名一起改掉。唤起提示、入座说明（`joinPrompt` 第三个参数，网页上的接入页也用它，所以 `lib/prompt.ts` 不能 import store）、报错都读它；`bench-mcp.mjs` 的工具说明是静态的，统一写「用户」。新手引导第 1 步的 `NameField` 是引导里唯一会存盘的地方。测试只试拒绝的情况，真改名会改到所有项目。
- 左栏两档（`components/room/left-pane.tsx`，2026-11-12，取代原来单独的项目栏和 `lg`～`xl` 的头像列）：一栏 300 宽，同一时间只显示一档。房间档是当前项目的席位栏（`roster.tsx`，标题行左端是「← 项目」和项目名，`Roster` 的 `head`）；项目档是每个项目一张卡片加「新建项目」（`project-rail.tsx` 的 `ProjectList`）。页面打开在房间档；点卡片进那个项目的房间，点「← 项目」或焦点在左栏时按 Esc 回项目档；点当前项目的卡片只是回房间。中间和右栏始终是当前项目，在项目档里翻看不动它们。「← 项目」上带别的项目里等你的总数（红），别的项目有人在做时带一个青点。窄屏底部「席位」页里是同一套两档。新手引导第 2 步切到项目档、「看它有没有入座」那步切回房间档（`tour.tsx` 的 `tier`，发 `LEFT_TIER` 事件），引导结束回房间档。
  - 过渡（`globals.css`「Left column tiers」）：进房间：点下去其它卡片 120ms 内背着它淡出、挪 8px（`.tier-leaving`，纯 CSS），`LEAD`（110ms）后一次 `startTransition`（类型 `tier-enter`）换档：被点的卡片和房间面板同名 `tier-pane`，两张快照都按原尺寸钉在左上角、由变大的框裁出来（`object-fit: none`），所以不拉伸文字；项目名和小圆点同名 `tier-title` 滑到标题；凳子上的小人用原来的 `seatFlight` 飞到各自那一行的状态灯，按座位错开 25ms（`left-pane.tsx` 现写一段 `<style>`）；席位栏的行从 120ms 起逐行淡入（`.tier-in .tier-rows > *`，错开 20ms，最多 8 行），「← 项目」从左 8px 滑入。回项目（`tier-leave`）：面板旧图 90ms 淡出，框缩回卡片，小人 240ms 飞回凳子，其它卡片从它往外依次淡入（`data-motion="in"`，`--far` 每格 30ms）；`useLayoutEffect` 先把列表滚到那张卡片、把焦点放上去，再截新画面。只动 transform 和 opacity，框的大小交给 ViewTransition 自己的快照。别的项目：`LEAD` 期间顺手 `prefetch`，`openProject(id, then)` 在快照到了的那次 `startTransition` 里一起换档，所以小人有地方可飞；中途点了返回会 `openProject(当前)` 把还在路上的那次作废（`turn` 计数）。打断：新的一次开始前 `document.activeViewTransition?.skipTransition()`，直接跳到新的那次。减少动态效果：框和标题不动，只做 120ms 淡入淡出。坑：`Bot`（小克）现在在 `useLayoutEffect` 里建：视图过渡期间 React 把 `useEffect` 压到过渡结束才跑，原来进房间时各家头像要等动画完了才冒出来。只有锚点卡片（被点的那张，或当前项目）带 `tier-pane` / `tier-title` 名字，别的卡片不进过渡图层。
- 点项目卡片进房间的速度（2026-11-12 用户问「为什么有延迟」）：实测（开发模式、真显卡）拉快照只要 7～11ms，不是网络。时间花在：卡片先淡出的 `LEAD` 110ms、React 画新房间（视图过渡开始前一次 55～70ms 的长任务）、过渡本身 300ms 加席位错开。改法：鼠标左键按下就开始（`pointerdown`，触屏和键盘仍按 click，随后的 click 当重复忽略，`left-pane.tsx` 的 `pickingRef`）；`LEAD` 降到 16ms（只为让被点的卡片先挂上 `tier-pane` 再截旧画面）；面板和标题 300→240ms，席位 320→260ms、延迟 40→20ms、每个错开 25→18ms，行的淡入整体提前 40ms。结果从按下算：新房间上屏 ~290→~190ms，过渡结束 ~720→~530ms，同项目 175→59ms。剩下的大头是开发模式下 React 渲染房间，`next build && next start` 会再快。测法：`~/.cache/bench-copies/probe/lag.mjs`（只读，打开 4399 不带口令，点卡片，用 PerformanceObserver 和 `document.activeViewTransition` 记时间线）。
- 项目卡片（`components/room/project-rail.tsx`）：名字下面一条长凳（「并坐」），右边写几个席位、几个在做、「当前」。凳子上坐 `listProjects` 的 `bench`：最多三个席位，在干活的排前面，其次有权限或提问在等用户的（头上红色「!」），再按最后说话的时间；剩下的写「+N」；在干活的在凳子上像海浪一样跳（`bench-turn`：每 2.4 秒一波，按座位顺序一个比一个晚 0.12 秒快速跳完，然后歇着等下一波；减少动态效果时不跳），离线的变灰。表情用小克的 `mood`（`moodOf`）：等用户 worried、干活 busy、手上有待办等验收 happy（`bench[].review`）、离线 asleep，其余不给 mood 照常发呆。当前项目的凳子上也坐着人（两档以后房间档和项目档不同时出现，小人在两档之间飞）。`lg` 以下顶上的下拉也能切项目。切项目时席位会飞：凳子上的 bot 和席位栏里那一行的状态灯用同一个 `<ViewTransition name>`（`seatFlight(id)`），`room-app.tsx` 切项目时先留着旧房间，新项目的快照到了再在 `startTransition` 里一次换掉，凳子和席位栏在同一次提交里变，React 就把同名的配成一对飞过去（`bench-in` / `bench-out`，0.3 秒，回凳子的先走、出发的晚 0.1 秒；减少动态效果时只淡入淡出）。坑：新项目的第一份快照往往拉取和推送流各来一次，只要屏幕上还是旧项目，每一份都要走 `startTransition`，否则普通更新先把它提交了，就飞不起来。切项目要快（2026-11 优化）：点下去先拉新项目的快照（`/api/v1/room?project=…`），到了才在同一个 `startTransition` 里改 `projectId` 和 `room`；以前点下去先改 `projectId`，整个旧房间同步重画一遍（开发模式 130～460ms，页面卡住）才开始拉。鼠标在卡片上停 120ms 或按下时就预先拉（`prefetch`，4 秒内有效）；连点几个只认最后一个（`wanted`）。新开的对话先只画最后 12 条（`FIRST`），下一帧再在后台补到 40 条（`PAGE`）；待办的步骤列表只在展开时才建（`StepDrawer`），`clock` 共用一个 `Intl.DateTimeFormat`，`useFold` 不再挂上就同步量一次（`ResizeObserver` 自己会报第一次）。测法：测试副本里用 CDP 点项目卡片，量到 `aria-current` 换过来；无头 Chrome 要带 `--use-angle=gl --ignore-gpu-blocklist`（用真显卡，不开窗口），swiftshader 下视图过渡截旧画面要 200ms 以上，真显卡 20～35ms。录过渡：CDP `Page.startScreencast` 加 `Animation.setPlaybackRate`（0.25 就是慢 4 倍，视图过渡也跟着慢）。2026-11-10 实测（开发模式）：点下去到新房间上屏 318/602/608/702ms → 262/383/340/362ms，点中反馈 8～13ms。剩下的大头是开发模式的 React（`jsxDEV` 记调用栈）；用 `next build && next start` 跑会再快几倍，但改代码就要重新构建。凳子上的 bot 在这个页面打开以后说过话（`bench[].saidAt`）会跳一下（`bench-hop`，按 saidAt 做 key，每条新消息跳一次）。红色数字是 `listProjects` 的 `waiting`（待批的权限 + 没回答的提问 + 等验收的待办），小圆点是有新消息：`lastOtherAt`（最后一条不是用户说的、不是系统通知的消息）晚于这个浏览器记的「上次打开」（localStorage `bench-project-seen`）。从没记过的项目按已读算，免得第一次打开满屏小圆点。项目列表每 5 秒轮询一次，标记跟着更新。
- 已完成的待办不能再改（2026-11）：`actOnTask` 一开头，`status: done` 的任务对除 `fork` 以外的一切 action 都回 409（agent 和用户都一样：步骤、认领、卡住、交接、请验收、验收通过 / 打回、加步骤），原文一个字不动。要接着做，用 `action: "fork"`（页面上完成卡片里的「复制一份」）：新建一条同标题、同说明、同样步骤（全部重新「待做」）的待办，负责人沿用原来的（还在房间里的话），`forkedFrom: {id, title}` 写明从哪条来，建立记录里也写，原来那条不变。agent 想继续就 `bench_task` 新建（MCP 没有 fork）。页面上完成卡片里的步骤圆点变灰不能点。唯一还会碰到已完成待办的是改名（席位或用户改名时，负责人显示的名字跟着换，`ownerName`），那是显示同步，不是改内容。测试在 `scripts/test-room.mjs`「已完成的待办」一段。
- 验收（`lib/review.ts`、`actOnTask` 的 `review` / `pass` / `reject`）：任务上的 `review` 记 等验收 / 通过 / 打回。「验收步骤」是以「验收」结尾、16 字以内的那一步（只提到验收的步骤不算，免得误伤「任务加验收状态」这种）。agent 用 `review` 请验收，验收步骤变「在做」；agent 不能把验收步骤标 done，也不能在它没勾时把任务标完成（403）。`pass` / `reject` 只许人类，打回必须带原因：通过以 jinbao 名义发「验收通过「标题」」不叫人，消息带 `verdict: {taskId, state, ownerId}`：网页按 ownerId 查当前名字显示成「（负责人 X）」，转给 agent 的文字写「负责人：你 / 名字，席位 a_…，待办 t_…」，`bench_messages` 里是 `verdict.owner {id, name}`，改名也认得准；打回发「@负责人 打回「标题」：原因」，走正常唤起。`awaitingReview` 决定卡片是否显示「等你验收」框：请过验收，或除验收外的步骤全做完；被打回后要等 agent 再请一次。
- 提问（`bench_ask`，`lib/store.ts` 的 `askUser` / `awaitAnswer`，`POST /api/v1/ask`）：agent 的问题是一条带 `ask`（选项、`multi`、`state`、答案）的消息，页面在它下面画 `AskCard`（`components/room/ask-card.tsx`）：点选项（多选时勾完点「选好了」）或自己写一句，发出去就是回复这条问题，`say` 里的 `answerAsk` 把它记成答案。提问后席位显示「卡住 · 等 jinbao 回答：…」。桥接先 `action: "ask"` 再 `action: "wait"` 长轮询（默认 10 分钟，最多 13 分钟；唤起本身没有时间上限，等不到就再等一次）；等着的时候问题 id 在房间的 `asking` 里，回答时记 `ask.handed`，`summonCandidates` 见到它就不再唤起提问者（等待在 `setImmediate` 的唤起之前就结束了，所以不能临时查 `asking`）。没人在等时回答就是普通的「人回复 agent」，照常唤起它。接管自带提问：`claude-code.sh` 唤起时加 `--disallowedTools AskUserQuestion`，唤起提示和 MCP 说明里都写了「要问 jinbao 用 bench_ask」。其他家 exec 模式本来就没有提问工具，靠提示。已经开着的 MCP 桥接是旧进程，要等那个会话下次启动（唤起每次都是新进程）才有 `bench_ask`。
- 权限确认接管（`lib/permits.ts`，`POST /api/v1/permit`，`components/room/permits.tsx`）：唤起 Claude 时 `claude-code.sh` 加 `--permission-prompt-tool mcp__bench__bench_permit`，`claude -p` 每次要确认都调桥接的 `bench_permit`（参数 `tool_name`、`input`），桥接问房间、挂起等，按 Claude Code 要的格式回 `{"behavior":"allow","updatedInput":…}` 或 `{"behavior":"deny","message":…}`；出错一律拒绝。请求只在内存（`globalThis.__benchPermits`），快照的 `permits` 给页面，输入框上方 `PermitBar` 一张卡一个请求：允许这一次 / 这次唤起全部允许 / 拒绝（可写原因，原因转回给它）。10 分钟没人点按拒绝。临时完整权限按唤起记（席位 id → run id），那次唤起结束自然失效；有它时 `bench_permit` 直接放行。agent 自己可以 `bench_elevate`（`action: "full"` + 理由）请求，唤起提示（只给 Claude 席位）让它被拦时先这么做；用户也能在「正在做」卡片上的「给完整权限 / 完整权限中 · 收回」随时切。「默认开启全部权限」（2026-11-12，用户要的：每次叫出来都要点太麻烦）：席位上的 `autoFull` 标记，存在席位数据里，重启不丢。开新会话时可勾（只对 Claude 显示，上次的选择记在浏览器 `bench-spawn-auto-full`，第一次默认不勾），已有的 Claude 席位在「…」菜单里勾选或取消（`POST /api/v1/agents/<id>` `action: "auto_full"`）。勾上后 `hasFull` 一直为真：`bench_permit` 和 `bench_elevate` 都当场放行；「正在做」卡片上是「默认全部权限 · 这次收回」按钮（2026-11-12 用户要的临时收回）：点了只收这一次唤起（`permits.ts` 的 `held`，席位 → 那次唤起 id，`hasFull` 在 id 相同时不算默认权限），按钮变「这次已收回 · 恢复」，下次唤起 id 不同就自动恢复；再给完整权限或批准 `bench_elevate` 也会清掉收回。要一直关还是去「…」菜单。副本里验过：收回后工具确认挂起等人、恢复后放行、收回后新唤起自动放行、唤起中途收回又挂起。唤起提示也换成「你有默认的全部权限，不用 bench_elevate；改动、删除、对外发送照样以用户说的为准；sudo 只能他输」。注意：窗口本来就是 bypassPermissions 的会话不会弹任何确认；只对 Claude Code 和 Codex 有效（Codex 见「Codex 的权限接到房间」），其他家 exec 模式没有这种接口。用真实 `claude -p` 验过：`ls /opt` 弹到房间，点允许后拿到输出继续答完。自己在某个 Claude 会话里起 `claude -p` 做这种测试时，要 `env -u CLAUDE_CODE_SESSION_ID -u CLAUDECODE claude -p …`：不然子进程的 bench 桥接继承了外层的会话 id，把它当成外层那个会话，bench_join 会把外层的席位搬进测试项目（删测试项目时席位就跟着没了）。
- 撤回（`lib/store.ts` 的 `recall`，`POST /api/v1/recall`，`lib/summon.ts` 的 `forgetMessage`）：只有 jinbao 能撤回，而且只能撤回自己发的。消息留在原位，`recalled: {at}`，`text` 清空、附件和点名去掉，原文只在这次请求的响应里带回给页面（`original`），房间里不存。页面在群聊和回复链里都画成「你撤回了一条消息 · 时间」，这个页面撤回的还有「重新编辑」（`EDIT_EVENT` 把原文放回输入框）。agent 那边：唤起转发（`catchUp`）、收件箱、摘要原文都略去它，`bench_messages` 里只标 `recalled: true`；`summonCandidates` 不再因它叫人；排队里还没开始的唤起由 `forgetMessage` 拿掉这一条（lane 的 `pending` 记着消息 id），已经开跑的唤起已经读到了，收不回。
- 群聊右上角「摘要 / 详细」（记在这台浏览器的 localStorage `bench-thread-detail`）：详细模式下，每条带 `runId` 的回复上面展开那次唤起的步骤（`components/room/run-trail.tsx`，结束的 run 每页只取一次，跑着的每 1.5 秒刷新），和回复重复的最后那段话不再显示；正在跑、还没贴回复的席位在群聊底部单独一行，步骤边来边长。这些只在页面上画，不是房间消息，任何 agent 的收件箱和唤起提示里都没有。过程记录只留最近 80 次，更早的回复上面就什么都不显示。

「摘要」档里 agent 的回复只显示一句结论，点一下在原地展开全文，再点收起（`components/room/gist.tsx`，在 `MessageRow` 和回复链的 `ChainLine` 里用；t_7e73c54f）。「详细」档不变，还是全文加过程。
- **那一句从哪来**：先用消息自带的 `Message.gist`（作者写的第一行，或摘要席位补的；房间那一侧是 t_83c6fcc9），没有就用 `lib/text.ts` 的 `gistOf` 现算（老消息），规则也取不到时用正文开头去掉标记符号后的前 80 字。`Message.gist` 的类型进 `lib/types.ts` 之前，页面里用本地的 `Gisted` 读它，类型有了就把那个转换去掉。
- **哪些不折**：人说的话、带 `ask` 的提问卡、撤回的、系统提示、交接卡片、限额卡片本来就走别的分支，不经过这里；回复短到本身就是那一句、也没有附件时，也照原样画，不加展开记号。
- **提示**：摘要下面一行小字，`展开`加上 `附 N 个`、`待办 xxxx`、`约 N 字`（正文满 200 字才写，取整到十或百）、`摘要由 X 补`（gist 的 `by` 不是 `author` 时）。折着时附件也收起，展开后才显示。
- **展开状态**只记在页面的内存里（`gist.tsx` 的 `opened` 集合，用 `useSyncExternalStore`），刷新就全折回去；换消息、新消息进来、列表重绘都不会让已展开的自己收起。
- **展开收起的动画**用 `Reveal`（高度过渡），一边收摘要行一边放全文；每次点都调 `keepTopInView`，展开后消息顶部不会跑出视野，收起也不会把人甩到别处。
- **跳转**：点消息 id、搜索结果都走 `GOTO_EVENT`，`Thread` 收到后先 `expandMessage(id)` 再滚过去、闪一下，所以跳到折着的那条会自动展开。回复链中间折着的那些，`ReplyChain` 自己会先展开整条链。

群聊的视图切换现在是「进展 / 对话 / 流程」三个，默认「进展」（`components/room/progress.tsx`，`Thread` 里画，`room-app.tsx` 算数据；t_bf01e8d8）。原来按时间排的群聊是「对话」，右上角「摘要 / 详细」只在「对话」里起作用。前台房间（`project.front`）没有待办可排，仍然只有「对话」和「流程」，也默认「对话」。
- **数据**：`lib/digest.ts` 的 `digestOf`（Opus2，t_5de117f4）给出 `you / stuck / doing / done / talk` 五组行和顶上的计数，页面不自己猜状态。只在「进展」显示时才算（`room-app.tsx` 里 `digest` 的 `useMemo`），别的视图不花这份算力。
- **页面**：顶上四个数字，点一个跳到那一组；一组一组往下，空的不显示；「今天做完」和「对话」默认折成一行，点开才列；同组超过 4 行，后面的折成「还有 N 件：…」。一行一件事：左边一道颜色（等你琥珀、停着红、在做天蓝、做完绿、对话灰，和右栏、流程视图同一套），中间标题和「谁 · 一句话结果」，右边进度条和按钮。
- **按钮直接办事**（都走现成的接口，没有新接口）：等验收的「通过 / 打回」（打回要填原因，`POST /api/v1/tasks/<id>` 的 `pass` / `reject`，和右栏一样）；提问直接把 `AskCard` 放在行里；权限直接放 `PermitCard`（从 `permits.tsx` 导出），行里有的权限，输入框上方的 `PermitBar` 不再重复画，没挂在任何一行上的才留在那里；停着的「叫它接着做」和左栏共用 `components/room/nudge.ts` 的 `nudgeSeat`（只有席位有 `owes` 且叫得醒才出现）；在做的「过程 / 停止」。
- **点一行**在原地展开这件事的对话，里面每条回复是「摘要」档那套一句话加展开（`Thread` 的 `progressLine`，不管右上角选的是摘要还是详细，这里一律摘要）。展开状态记在页面内存里（`progress.tsx` 的 `open` 集合），新消息进来不会收起；切视图再回来也还开着。
- **跳转**：点消息 id、待办 id、搜索结果都走 `GOTO_EVENT`。「对话」视图的 `Thread` 只在 `view === "chat"` 时接这个事件；「进展」自己接：找到那条所在的行就展开、滚过去、闪一下，对话组和被折起的「还有 N 件」也会自动展开；没有任何一行带着那条消息（系统提示、太早的）就切到「对话」再跳。
- **「你刚说的」**（`JustSaid`，在输入框上方的提示区）：你最近五分钟里说的最近两句、还没挂到任何待办行上的，显示叫到了谁、每个人那次叫醒现在怎样（`calls`）、对方回的那句摘要；挂到待办行上就淡出。对话组折着时，对话里有新的会在顶上数字下面出一个小标签「对话里有 N 条新的」，点了展开那一组，页面不自己跳。
- **验过的**（隔离副本，假席位造了：等验收两件、提问、权限、卡住、没人负责、在做、今天做完、两段闲聊）：默认进展；通过、打回（填原因）、回答提问、允许权限各点一遍，状态从「等你」落到别的组、顶上数字跟着变；展开收起；三个视图来回切；跳到闲聊里的一条会展开那一组并滚到；跳到系统提示会切到对话；窄屏、深浅两色。**没验到的**：真席位在跑时的「过程 / 停止」（假席位没有 `runId`）、有 `owes` 的席位的「叫它接着做」（假席位叫不醒）。
- 「正在做」气泡（`thread.tsx` 的 `live`）什么时候收起：席位的 `runId` 清掉了，或者群里出现了这次唤起带 `runEnd` 的消息。`runEnd` 只由房间在唤起结束、把 stdout 的回答贴回群里时打（`sayAs(…, { final: true })`，接口传进来的不算）。以前只看「有没有带这个 runId 的消息」，席位干活中途自己 bench_say 一句（交接、「已送到正在干活的…」）也带 runId，它的气泡就没了，左栏还在转，底下看不到（2026-11-12）。
- 席位有正在跑的唤起时，`present()` 一律报「工作中」：以前靠唤起期间的动静续 `lastSeenAt`，一段超过 40 秒没新步骤（客户端排队、长命令），状态就掉成离线，入口栏的头像跟着不显示工作中。
- 唤起的过程可看：五家的唤起命令都改成输出事件流（`claude-code.sh` 加 `--output-format stream-json --verbose`，`codex-wake.sh` 加 `--json`，cursor / agy 加 `--output-format stream-json`，dsh 加 `--json`）。`agents.json` 里还是旧默认命令的，按 `lib/kinds.ts` 的 `was` 自动换成新的。跑的时候席位那行跟着当前步骤变（「正在读 package.json」，至少隔 0.8 秒变一次），点它打开过程面板；跑完后回复下面有「查看过程」。这次唤起期间这个席位发的话（stdout 贴回的，或它自己 bench_say 的）都挂上 `runId`。群聊里只贴它最后一次工具调用之后说的话；中途的进度句子显示在席位那行（「先读 package.json」）和过程面板里，唤起提示也让它别用 bench_say 刷进度。新加的 14 家还没换成事件流，面板里会说只有最终回答。事件流客户端 30 秒还没任何输出时不停掉（Cursor 曾经排队 5 分钟后照常做完），席位和面板每 30 秒写「还没开始回应，已等 N」，开始输出后那条改成「等了 N 才开始回应」；唤起没有时间上限。弹窗用 `[data-slot="dialog-content"]::after` 画一圈左上亮、右下淡的高光细边，外面一层很淡的暖色光晕（`--panel-rim`、`--panel-glow`）。侧栏不加：试过，三面围着像往中间挤。顶栏不再是一条玻璃条，图标和按钮直接放在背景上；栏间距 16px。右栏待办和房间摘要是和流程卡片一样的毛玻璃卡（`frost rounded-2xl ring-1`，2026-11-12 改版；以前是 `.note` 便签：纸色、歪斜、胶带，和整页画风不搭，样式已从 `globals.css` 删掉）。状态是标题前的小圆点加右上角小标签：待办灰、在做天蓝、卡住红、完成绿、等你验收琥珀（和流程视图的「等你」同色，卡片描边也变琥珀）。步骤和交接单放在卡里一层淡底圆角框（`INSET`），进度条在做是天蓝、全做完变绿；步骤圆点：做完绿底白勾，在做天蓝圈加点。卡片底下只留最近两条动态，一条一行，悬停看全文。按钮用系统自带的 outline 样式。面板里参数用小号等宽字，结果用大一号，说的话用正文字体。
- 「接入」弹窗先选再给命令：19 种 agent 排成可搜索、可多选的格子，只为选中的拼一条 `register-mcp.sh a b c`（脚本接受多个种类，某个失败也接着做完）。从入口栏点某一家（没入座的那几家收成的小行）打开时，那一家已经选好。搜不到时直接给接入说明和复制按钮。「替我运行」走 `POST /api/v1/register`（`lib/register.ts`）：只收 `lib/kinds.ts` 里的种类，不经 shell，逐个跑 `register-mcp.sh`，每个限 60 秒，用起房间的那个用户的权限，和自己在终端里粘贴一样；结果逐家列出，失败的显示脚本最后一句。配置里已经有 bench 时 `merge-mcp.mjs` 不改文件也不留备份。
- 唤起用的模型（以前写在入口栏每家第二行；现在入口只在展开后写「软件 · 会话数」，模型在席位名字的悬停提示里）：先看唤起命令里的 `--model` / `-m`（`wakeModel`），没写就读客户端配置里的默认（`modelOf`：Codex 的 `config.toml` 顶层 `model`，dsh 的 `dsh-agent.toml` `[defaults] model`），都没有才写「默认模型」。席位自己报的 `model` 只是它入座时说的，可能和被 @ 时实际跑的不一样，写摘要也用这个唤起模型。
- 会话 id 由 agent 自己取，不让用户报。`bench-mcp` 按各家的环境变量自动识别（`DSH_SESSION_ID`、`ANTIGRAVITY_CONVERSATION_ID`、`CURSOR_AGENT_CHAT_ID` 等）；识别不到时 `bench_join` 直接报错并给出查 id 的命令，不先建一个叫不醒、进程一退就认不回的空席位。实在拿不到才用 `noSession: true`。
- 常驻客户端（dsh 网页版、Codex 桌面版）的 bench 进程不会跟着代码更新，改了 `bench-mcp.mjs` 要停掉旧进程，dsh 会自己重新拉起。
- 2026-11 加的 14 种是按各家文档写的，本机大多没装，没逐个实测；接上一家时先点名一次，看唤起命令对不对，不对就在「设置 → 唤起命令…」里改。按项目存会话的（Gemini CLI、Qwen、Kimi 等）唤起在仓库目录里跑，可能找不到别的目录里开的会话，需要时仿照 `resume-here.sh` 包一层。
- 大多数客户端不把会话 id 交给 MCP 服务器，`bench-mcp.mjs` 里只写了文档或本机确认过的环境变量（`QODER_SESSION_ID`、`CODEBUDDY_SESSION_ID`、`COPILOT_AGENT_SESSION_ID`、goose 的 `AGENT_SESSION_ID`、Gemini CLI 的 `GEMINI_SESSION_ID`），其余靠 `find` 里那条查会话的命令。
- WorkBuddy 从 `~/.workbuddy/mcp.json` 读 MCP，但只在启动时读：先开 WorkBuddy 再注册，要把 WorkBuddy 整个退出重开，否则会话里没有 bench 工具，模型会假装「坐下了」。重开后还要在 WorkBuddy 的 MCP 面板里批准 bench：不是它自己加的 server 都是「待授信」（trust-pending），批准前根本不启动，批准记在 `~/.workbuddy/mcp-approvals.json`。改 bench 的 command、args、env 的键或 cwd 都会让批准失效，要再批一次。
- WorkBuddy 不能像别家那样后台唤起：它自带的命令行在房间里跑会报 `Authentication required`（退出码却是 0）。桌面端的登录加密存在 `~/.workbuddy`，只经内部 socket 交给它自己拉起的命令行进程，房间不去拆它。自带的命令行也没有交互界面，没法 `/login`。解决办法是装完整版：`npm i -g @tencent-ai/codebuddy-code`，在终端运行 `codebuddy` 后 `/login` 一次。它的登录存在 `~/.local/share/CodeBuddyExtension/Data/Public/auth/Tencent-Cloud.coding-copilot.info`，和桌面端的 `workbuddy-desktop.info` 分开，互不影响；唤起脚本优先用它，`CODEBUDDY_CONFIG_DIR=~/.workbuddy` 让它找到桌面端的会话和 `mcp.json`。权限跟桌面端走：脚本从 `~/.workbuddy/workbuddy.db` 的 `sessions.permission_mode` 读出这个会话在桌面端的权限档（比如 `fullAccess`），带成 `--permission-mode`；print 模式没法弹确认，不带的话要批准的命令会直接被拒。CodeBuddy 没有 `--permission-prompt-tool`，没法把每次确认转到网页里。不想装的话，可以在 WorkBuddy 窗口里让它「守着房间」，循环 `bench_wait`。房间对「退出码 0 但没回答、只有 stderr」的唤起按失败报出来。
- `agents.json` 只存改过的命令，`lib/kinds.ts` 里新加的种类自动补上默认命令；所以在「设置 → 唤起命令…」里删掉一条，下次打开它又会回来。
- Antigravity 桌面端（IDE）里开的会话靠克隆叫醒：桌面端的会话记录在 `~/.gemini/antigravity/conversations/<id>.db`，命令行 `agy` 只读 `~/.gemini/antigravity-cli/conversations/`，没有参数或环境变量能换目录，直接 `--conversation <id>` 会报 `trajectory ... not found`。两边文件格式一样，所以唤起命令改成 `scripts/agy-wake.sh`：桌面端有这个 id 时，用 sqlite backup 把它原样拷到 agy 的目录（同一个 id，连 `brain/<id>` 一起），拷完的步数记在旁边的 `<id>.bench-clone`；之后只有桌面端的步数变了才重新拷。重新拷会盖掉克隆里房间叫醒的那几轮（它在群里说过的话房间的补课里还有），桌面端窗口也看不到叫醒的轮次。两边都找不到这个 id 时，房间会用中文说明。
- Antigravity 叫醒时沿用桌面端的权限预设：`~/.gemini/config/config.json` 的 `userSettings.permissionPreset` 为 `AGENT_PERMISSION_PRESET_TURBO` 时，`agy-wake.sh` 加 `--dangerously-skip-permissions`。agy 自己不读这个预设（日志里写 no shared config permissions），而且命令行模式下工具一被拒，整轮直接以「The stream was interrupted」结束，不会接着回答。房间遇到这句报错时会用中文说明。
- Antigravity 的唤起命令固定用 `gemini-3.8-flash-low`：2026-11 实测，同一账号同一时间 Flash 6 秒回一句话，Gemini 4 Argon 要 55 秒到 7 分钟（桌面端也一样慢，是服务端排队），点名协作等不起。这是没选模型时的默认；要某个席位用 Argon，在它的「换模型…」里选。
- Codex 的 `codex queue` 只是把消息排队，等那个会话下次被打开才处理，叫不醒人；要用 `codex exec resume`。Codex 也不把 `CODEX_THREAD_ID` 传给 MCP 服务器（只传给它的 shell），所以 `codex-wake.sh` 用 `BENCH_UUID` 把 thread id 交给新起的 MCP 进程，入座时则让 agent 自己 `echo $CODEX_THREAD_ID` 再填 uuid。
- 恢复会话会新起一个 MCP 进程。`bench-mcp.mjs` 除了按会话存凭证，还按名字存一份（`<kind>-name-<hex>.json`），新进程用同一个名字入座能回到原席位，不会撞「名字已被占用」。
- DeepSeek 网页版建的会话 `dsh-agent resume` 接不上（只认 `dsh-agent exec` 建的），这种席位点名会失败。
- 桌面端 Claude 自带的 `claude` 命令行要单独登录一次，没登录时 Claude 席位叫不醒。

## 点名的去向和「停着还欠着活」（2026-11-13）

借的是 OpenRig 的两条规矩（对比记在 `docs/同类项目对比.md` 末尾，待办 t_d99a05b9）：「叫到了 / 接了 / 做完了」是三件事，分开记；看不出来就说不知道，不硬猜。

**点名的去向（`Message.calls`，`lib/types.ts` 的 `CallState`）**

- 一条消息叫了谁，每个被叫的席位在这条消息上有一份去向：`queued` 排着、`held` 等它来取（它在守着房间）、`started` 已叫到（这次唤起开跑了）、`picked` 在做（客户端有了第一次输出；或者干活中途送到、它自己取走）、`answered` 答了、`silent` 跑完了但没在群里说话、`retrying` 网络断了、房间等一会儿自己再叫（`note` 开头是第几次，见下一节）、`failed` 没成功（`note` 是原因）、`stopped` 被你停下、`cut` 中途断了、`dropped` 从队列拿掉了。
- **只由房间在事情发生的地方写**，都走 `lib/summon.ts` 的 `note()`（底下是 `store.ts` 的 `markCalls`）：`enqueue`（排着、没会话、没唤起命令）、`run`（开跑、拼不出命令、结束时的四种结局）、`launch` 的 `first`（第一次有输出）、`takeQueued`（中途送到）、`intoTerminal`、`stopAgent`、`dropQueuedMessage`、`wake` 里的待命分支、`rewake`。页面只照着画（`thread.tsx` 的 `Calls`），**不要在页面上从别的迹象推去向**：今天修过的「摘要显示在跑其实没进程」「正在做气泡提前收起」都是推出来的状态和事实对不上。以后加一条新的唤起路径，记得在换手的地方写一笔。
- 一次回复唤起在答哪些消息，记在 lane 的 `calls` 上（开跑时的那批加上中途送到的），结束时一起落结局；被单独说打断、被重启或额度打断后重新叫醒的，id 跟着 `carryIds` 回到下一次唤起。
- 「答了」和「跑完了」是两件事：唤起正常结束后看这次唤起里它有没有在群里说过话（`saidInRun`），没说就是 `silent`。不经房间唤起取走的（待命、终端），没有唤起可跟，等它下次在群里说话时记成答了（`settleCalls`）。
- 重启后对账（`settleOpenCalls`，启动时一次）：还在路上的去向逐条对房间手里真有的东西。排着的看 lane（lane 是落盘的），在跑的看有没有那次唤起，等它来取的看它读没读到那条；没有依据的记成 `cut`，不留着「在做」的样子。
- 页面：消息下面一行小字，每个席位一段。答了的不显示（回答就在群里），所以这一行只在点名还在路上、或者没着落时出现。干活中途送到的已经有「已送到正在干活的…」那一行，不重复。

**席位状态只在一处算（`lib/status.ts` 的 `seatState`）**

- 按证据从强到弱：房间的唤起在跑 → 在做；唤起里说的「在做」随唤起结束作废（`ranUntil` 晚于 `statusAt`，被叫醒的会话进程没了就不可能还在做；「卡住」不作废，唤起里提的问要等用户）；桥 40 秒没心跳 → 离线；自己说在做超过 10 分钟（`CLAIM_MS`）没再报、桥还有心跳 → `unsure`，左栏写「不确定在不在做 · N 分钟前说在做」。
- `statusAt` 在 `pulseAgent` 里记，`ranUntil` 在 `busy().settle()` 里记（各种唤起结束都走它）。以前唤起结束后席位自己改过的「在做」会一直挂到 40 秒没心跳才掉。

**停着还欠着活（`lib/owes.ts`，快照里的 `agents[].owes`）**

- 席位「停着」：没有唤起在跑、队列里没排东西、没在待命、没开终端、状态不是在做也不是卡住、不是「不确定」、没有问用户的问题挂着。状态不确定时不下结论。
- 「欠着」：名下状态是待接或在做、又不等别人的待办（请了验收或只差验收的不算，标了卡住的不算）；叫它没叫成或中途断了、之后也没有一次成功唤起的点名（成功唤起会把它没读的消息都转给它，所以一次成功就算补上；用户自己停下、从队列拿掉的不算）。成功唤起的时间记在席位的 `wokeAt`（`markWoken`）。
- 故意停下要写原因：待办标「卡住」并写在等什么，就不再提示。「叫它接着做」发出去的那句话里也这么告诉它。
- 每次出快照时现算，不存。`since` 取席位最后的动静和欠的那件事最后一次变动里较晚的一个；页面等它停满 3 分钟（`PARKED_MS`）才显示，免得交接、接力来回的空当里闪一下。
- 页面：左栏那个席位底下多一行琥珀色「停着 · 还欠 N 件」（第二档，有事才出现），点开是哪几件（点待办或消息会跳过去）；右边「叫它接着做」以用户的名义在群里 @ 它并带上这几件事，就是一条普通的点名。

**测法**：`scripts/test-room.mjs` 的「What became of each call」一段（忙时排队、跑完没说话、出错、被停、欠待办、卡住和等验收不算）。重启后的对账和重新叫醒要重启服务，在隔离副本里用 `~/.cache/bench-copies/tools/calls-check.mjs <副本名> <端口>` 跑两段。被房间叫醒的会话现在在自己的进程和网络空间里跑，`tmux` 起的副本它连不上；副本直接在会话里后台起（`env -i HOME=… PATH=… BENCH_DATA_DIR=… XDG_STATE_HOME=… BENCH_URL=… npx next dev -p 44xx -H 127.0.0.1`）。

## 网络错误自动重试，叫醒时带上还欠的事（2026-11-14，t_de3f8cd3）

网络不稳时，唤起常因为断网失败，以前只记一条「没成功」，要用户再叫一次。

**自动重试（`lib/netfail.ts` + `lib/summon.ts` 的 `run`）**

- 什么算网络错误只写在 `lib/netfail.ts` 的 `NETWORK` 一处：ECONNRESET、ETIMEDOUT、EAI_AGAIN、ENOTFOUND、socket hang up、Connection reset/refused/error、Broken pipe、fetch failed、TLS 中途断开、502/503/504/529 网关和 Overloaded 等。对 `failure`（stderr 末尾或退出原因）和客户端事件流里那条失败步骤去匹配，不看回答正文。不算的：撞额度（`limitOf` 先判，有自己的卡片）、用户点停止（走 `stopped` 分支）、401/403、权限被拒、其他报错。
- 唤起失败且是网络错误、设置开着、还没重试满、席位没换绑：这批消息原样放回 `carry` / `carryIds`（和被插话打断是同一条路，回答仍挂在原来那条消息下），去向记 `retrying`，`note` 写「1/2，20 秒后再叫：原因」，`lane.retryAt` 到点由 `armRetry` 的定时器调 `run`。最多 2 次，等 20 秒、60 秒（`retryDelays()`；测试用 `BENCH_RETRY_MS=400,800` 缩短）。中间的失败不往群里发系统消息，都失败了才记 `failed`（原因后面带「自动重试了 N 次」）并在群里报一次。
- 等待期间：有新消息点它就不等了，带上这批一起跑；`run` 里 `retryAt` 没到、又没有新消息时直接返回，别的路径（插话结束等）调 `run` 不会提前把它跑掉。用户点停止（左栏那一行的 ×、「…」菜单「不再自动重试」，都是 `stopAgent`）：去向记 `stopped`，排在后面的记 `dropped`，返回 `retryCancelled`。剔除其中一条（`dropQueuedMessage`）只拿掉那条，拿光了就不再重试。
- `carryIds` 现在落盘（`lane_state.carry_ids_json`，`ensureLaneDroppedCol` 里补列），以前重启后只剩 `carry` 文本、不知道是哪几条消息。重启后的对账：`openCalls` 认 `retrying`；lane 里还有这批消息的改记 `queued`（「等重试时房间重启了，恢复自动唤起后接着叫」），重启本来就会暂停有积压的 lane，用户恢复后接着叫；没有的记 `cut`。定时器随旧进程没了，不自动续。
- 页面：消息下面「X 重试中 1/2」（`thread.tsx` 的 `CALL_LOOK`，次数从 `note` 开头读）；左栏席位底下琥珀色「网络断了 · 04:14:12 再叫（1/2）」和 ×（`PublicAgent.retry`，经 `lib/lane-state.ts` 的 `retry` 传出）。等重试的席位不算「停着还欠」。
- 开关：设置菜单「网络错误自动重试」，默认开，所有项目一个设置，存 SQLite meta `net_retry`（`off` 才是关），`GET/POST /api/v1/retry`，快照里是 `netRetry`。

**新开会话没报出会话 id 时说出原因（`lib/spawn.ts` 的 `lastWords`）**：agy 断网时退出码是 0、只打一行错，以前报错只说「跑完了，但没报出会话 id」（m_68c8a77c）。现在 agy、dsh-agent、codex 这三处都带上它输出的最后一行（stderr 优先）；这一行像网络错误时再提示「多半是网络不通：房间的环境里要带上代理变量」。

**叫醒时带上还欠的事（`owesLine`）**：回复唤起（`run`、`intoTerminal`）的消息末尾、守则前面加一小段「【你名下还没做完的待办】」，一条一行写 id、标题（截 20 字）和到哪一步（截 14 字），最多 3 条（在做的优先），最后一句「接着做，或者把它标成卡住并写明在等什么」，整段不到 200 字。判断和「停着 · 还欠」是同一个函数（`lib/owes.ts` 的 `owedTasks`，`stepOf` 也共用）：名下待接或在做、没请验收、没标卡住。这次转给它的消息里已经提到 id 的不重复，没有欠的就什么都不加。这段不放进 `carry`，被打断后重跑时按当时的情况重新算。

**测法**：`scripts/test-room.mjs` 里「Network failures are tried again」一段：前两次 ECONNRESET、第三次成功的假客户端（retrying → answered，群里没有中间报错，回答里带着原来的消息）；一直失败的（两次后 failed，只报一次）；非网络错误不重试；等重试时点停止（retryCancelled，之后不再跑）；关掉开关后不重试；提示里带上还欠的待办 id、不重复消息里提到的、没有欠的不加。副本要用 `BENCH_RETRY_MS=400,800` 起（`test-copy.sh` 会把它传下去），否则这段要等 80 秒。重启对账要重启服务，手动测过：等重试（`BENCH_RETRY_MS=60000,60000`）时重启副本，去向从 `retrying` 变 `queued`、lane 暂停，恢复后接着叫。

## 请验收时先复验（2026-11-14，t_f08a0c78）

用户要的：每条待办都靠他自己看太累。席位请验收时，先让另一个席位照着验一遍，他只看结论和没验到的部分。通过还是只有他能点。

- **设置**：项目设置（项目卡片右键或「…」→设置）里「请验收时先复验」：不复验（默认），或选这个项目的一个席位。存在席位上（`Agent.checker`，和 `autoFull` 一样进席位数据，重启不丢），一个项目最多一个，选了新的就清掉旧的（`setChecker`，`POST /api/v1/agents/<id>` `action: "checker"`, `on`）。只有在编辑已有项目时才出现，下拉的席位是打开对话框时现拉的 `/api/v1/room?project=…`。
- **触发**：`actOnTask` 的 review。同一次请验收只复验一次：还在等验收时再请一次，保留原来的结果；打回后再请验收，重新复验。复验人就是这条的负责人时直接记「跳过」。要复验时往 `Task.check` 写 `queued`，存好后发 bus 事件 `check`，`lib/summon.ts` 的 `requestCheck` 接（`__benchCheckHandler` 间接一层，热更新换得到）：复验人叫不醒（没有会话或唤起命令）、正挂在 `bench_wait` 里，记「跳过」并写原因；否则排进它的 lane（`Lane.checks`，排在摘要、压缩之后，回复之前）。
- **那一轮**：`checkTask`，像写摘要一样单独一种唤起（`Run.purpose = "check"`，查看过程里叫「复验待办」），不进群聊。提示里给待办标题、说明、每一步和说明、请验收时写的「怎么看效果」、负责人、项目目录，要求只读（不改工作区、不提交、不重启、不用 bench_say、不改待办）、要跑就按本文起隔离副本、只写真验到的。结论从输出里读：最后一个「复验结论：通过 / 没过 / 没验到」，后面的话全记成依据（2000 字以内）。没这一行记「没跑成：复验没交结论」，附它最后 200 字。所以没改 `bench-mcp.mjs`，常驻客户端不用重启桥。开跑前再看一眼：待办已经被打回、通过或又请了一次验收，这次就不跑了。
- **结果**：`Task.check {state, by, name, note, at, runId}`，`state` 是 queued / running / passed / failed / unverified / skipped / error。只认它被创建的那一次（`setTaskCheck` 比对 `at`），旧的那轮回来不会盖掉新的。没过不自动打回，只是摆给用户看。唤起失败、被停下、复验人叫不醒的排着的复验（`dropChecks`）记 error「复验没跑成：原因」；服务器重启时还排着或在跑的（`abandonChecks`）同样记 error。都不在群里发系统消息。
- **界面**：只在有 `check` 的待办「等你验收」框里多一行（不加常驻的东西）：复验排着 / 复验中（转圈）/ 复验通过 / 复验没过 / 复验没验到 / 没复验 / 复验没跑成。有结论的「依据」点开展开，「过程」打开那次唤起；跳过和没跑成直接写原因（两行内）。
- **测法**：`scripts/test-room.mjs` 里「请验收时先复验」一段，用假复验人（`mockcheck_*`，按待办标题里的【没过】【没验到】【乱答】给不同回答）：没设不触发、通过并记依据且不进群聊、没打回再请不重复、没过不自动打回、打回后重新复验、没验到、没交结论、复验人是负责人跳过、只能有一个复验人、复验人唤起失败、关掉后不再触发。重启时的 `abandonChecks` 没在测试里跑（要重启服务）。
- 注意：复验跑在复验人自己的会话上，这一轮会留在它的上下文里（写摘要也是这样）。挑一个便宜的模型、专门复验的席位最合适。

## Codex 的权限接到房间（2026-11-14，t_f6fea31b）

- 起因：叫醒 Codex 时 `codex-app.mjs` 把审批写死成 `never`，沙箱用会话自己的。GPT2 的会话是只读的，于是改不了文件，也申请不了提权，Codex 发来的审批请求一律被回成 decline。房间里的权限按钮对它不起作用。
- 现在每次叫醒，`codex-app.mjs` 先用本轮的 `BENCH_RUN_KEY` 问房间（`POST /api/v1/permit` 带 `{key, action: "mode"}`，回 `{full}` 即 `hasFull`）：
  - 有全部权限（默认全部权限，或这一轮已经给了）：`thread/resume` 用 `sandbox: "danger-full-access"`、`approvalPolicy: "never"`，`turn/start` 用 `sandboxPolicy: {type: "dangerFullAccess"}`。
  - 没有：可写工作区（`workspace-write` / `workspaceWrite`，不联网，这是 Codex 自己的默认），审批 `on-request`，`approvalsReviewer: "user"`。
  - 恢复会话和开始一轮两处都带，所以会话原来是只读也会被盖掉。
  - 没有 key（不是房间叫醒的）：可写工作区，审批 `never`，越界的一律拒。
  - `BENCH_CODEX_EXEC=1` 走的 `codex exec` 没法问人，固定 `sandbox_mode="workspace-write"` 和 `approval_policy="never"`。
- 审批转到网页：app-server 发来的请求（`item/commandExecution/requestApproval`、`item/fileChange/requestApproval`、`item/permissions/requestApproval`，以及旧格式 `execCommandApproval`、`applyPatchApproval`）都用 `{key, action: "tool", tool, input: {command}}` 问 `/api/v1/permit`，和 Claude 的 `bench_permit` 用同一套卡片。
  - 卡片上的 tool 写「终端 / 网络 / 文件编辑 / 额外权限」，读起来是「GPT2 想用 终端」。
  - 改文件的路径从先到的 `item/started`（fileChange 的 `changes[].path`）里记下。
  - 允许这一次回 `accept`；「这次唤起全部允许」回 `acceptForSession`（permissions 回 `scope: "session"`）；拒绝或超时回 `decline`。
  - 别的 MCP 服务器的表单（elicitation）回 decline，`requestUserInput` 回空。
- permit 接口认 key：`lib/summon.ts` 的 `seatOfRunKey` 从正在跑的 lane 里按 key 找席位，找不到回 404「这次唤起已经结束了」。key 只在这次唤起的进程环境里，唤起一结束就作废。
- `setFull(on)` 把这个席位正在等的卡片按 `{allow: true, full: true}` 结掉。以前只给 `allow`，Codex 就只收到 `accept`，后面的申请还会再问。
- 哪些客户端有「默认开启全部权限」、开新会话的勾选和「正在做」卡片上的权限按钮：看 `lib/kinds.ts` 的 `PERMIT_KINDS`（Claude、Codex），`asksOnPage(kind)`。
- 唤起提示（`envelope` 的 kind 参数）：Codex 没全部权限时让它照 Codex 平常的方式申请提权，有全部权限时告诉它这轮没有沙箱。
- 局限：沙箱在这一轮开始时就定了。
  - 中途给全部权限：之后它申请提权时直接放行，但沙箱不会变宽，还是要它先申请。
  - 中途收回：已经在跑的这一轮仍然没有沙箱，下一轮才收紧。
- 测法：
  - `scripts/test-room.mjs` 用一个假的 app-server（临时目录里的 `bench-fake-codex-*.mjs`，经 `CODEX_BIN` 交给 `codex-app.mjs`）报出它拿到的沙箱和审批，再发一条命令审批和一条改文件审批。测的情况：平时点允许和拒绝；默认全部权限时不设沙箱、不问；点「这次唤起全部允许」后后面的不再问；不在跑的 key 回 404。
  - 沙箱参数在真实的 app-server 0.167 上验过：用临时 `CODEX_HOME` 放一份会话记录，只 `thread/resume`、不开始一轮，不花额度。
  - 没用真实的 Codex 跑过一整轮审批，那要花额度。

## 每条回复的一句摘要（`Message.gist`，2026-11-14，t_83c6fcc9）

用户说群聊的「摘要」档只是不显示过程，回复照样整篇摆着，看到的是细节不是结论。现在每条 agent 回复有一句摘要，页面默认只显示这一句（页面是 Sonnet 的 t_7e73c54f）。三层，前一层取不到才用后一层：

1. **作者写**：守则（整段和短提醒都有）要求回答和发言的第一行写一句 60 字以内的结论。守则签名因此变了，各席位下一次会重收一次整段。
2. **房间取**：`lib/text.ts` 的纯函数 `gistOf`（`GIST_MAX` = 120）：去掉开头的【本轮结束】，取第一段；第一段不超过 120 字、开头不是标题、表格、列表、引用、代码块或一整行粗体，就用它（第一段后半截变成列表或表格的，只取前面的文字）；否则取第一句（到。？！），不超过 120 字才用；再不行就没有。`store.ts` 的 `say()` 在消息入库时算，只给 agent 的聊天消息算，记成 `{ text, by: "author", at }`；人的消息、系统消息、提问卡都不算，撤回时清掉。老消息不回填，页面对没有 gist 的消息用同一个函数现算。`gistOf` 没有 import，页面能直接引用；单元用例在 `scripts/test-gist.mjs`（`node scripts/test-gist.mjs`，Node 自己去掉类型）。2026-11-14 拿正式房间最近 251 条 agent 回复试过，245 条取到了；没取到的是第一句就很长的。
3. **摘要席位补**：项目设置里的「谁来补摘要句」（`Agent.gister`，一个项目一个，和复验人一样走 `POST /api/v1/agents/<id>` 的 `action: "gister"`）。没取到 gist、又超过 200 字（`GIST_LONG`）的 agent 回复，先在同一个项目里攒 5 秒（`BENCH_GIST_MS` 可以改；凑满 12 条就立刻发），再叫醒摘要席位单独跑一轮（run 的 purpose 是 `gist`，不进群聊），要它每条回一行「[消息 id] 摘要句」。房间按 id 把每一行写回 `gist`，by 记它的名字（`setMessageGist`，不覆盖作者自己的那句，也不写撤回的消息）。摘要句里的 @ 会被去掉，超过 120 字截断。提示词控制在 80 KB 以内（每条最多带 2000 字），因为它要放进一个命令行参数。失败就算了：不重试，不在群里报错，页面照旧显示规则截出来的开头。摘要席位排队、停止的处理和复验人一样，停止时攒着的这批一起丢掉。攒着的那批不落盘，重启就没了。
   - 会话越来越长：每 20 批（`GIST_COMPACT_EVERY`）房间替它压缩一次。只有 Claude Code 和 Codex 能这样压；别家靠客户端自己压，或者不压。给它挑便宜、上下文大的模型。

gist 只是给页面显示用的：转给 agent 的原文、搜索、待办都不用它，里面的 @ 也不叫人。`bench_messages` 给 agent 的结构化消息里也不带它。

**测法**：`node scripts/test-gist.mjs`；`scripts/test-room.mjs` 最后一段「Gists」：第一行是短结论的回复 gist 就是它（by author）；第一行是标题的长回复没有 gist，没设摘要席位时不补，设了以后被补上（by 是那个席位、@ 被去掉、它不在群里说话、作者那句不被覆盖）；摘要席位失败时没有 gist、消息不变、群里不报错；人的消息没有 gist。副本用 `BENCH_RETRY_MS=400,800 BENCH_GIST_MS=500 scripts/test-copy.sh up <名字> <端口>` 起（这两个变量已加进 `test-copy.sh` 放行的清单），否则重试那段要等 80 秒。

## 「进展」视图的数据：一件事一行（`lib/digest.ts`，2026-11-14，t_5de117f4）

用户觉得一条回复一句摘要还是不直观（m_217a913d），改成按事情归拢、先看状态。页面是 Sonnet 的 t_bf01e8d8，这里是它调的纯函数 `digestOf({ messages, tasks, agents, permits, userName, now })`：不读库、不发请求，状态全是房间记着的事实，不用模型。

- **输出**：`counts`（等你、停着、在做、今天做完）和五组行 `you / stuck / doing / done / talk`。每行有 `id`（待办 id，talk 是那条回复链第一条消息的 id）、`kind`、`state`、`title`、`owner`、`line`（一句话：最新的结果）、`steps`（做完几步、共几步、当前步骤）、`need`（review / answer / permit，带 `askId` / `permitId`）、`at`、`since`、`messageIds`（从早到晚）、`attachments`、`check`（复验有结论时才有）。
- **消息归哪条待办**：消息上的 `taskId`；验收消息的 `verdict.taskId`；交接消息按待办标题对上；正文里点到的待办 id（点了两条就两条都算）。都没有的，看它所在的回复链：一条待办归最先点到它 id 的那条回复链（`lib/flow.ts` 的 `chainsOf` / `firstNamed`，这次从 `flowsOf` 里抽出来共用，流程视图的结果和原来一样：正式房间 39 条流程、66 个待办块）。链里只有一条待办就归它；有几条的，归作者自己负责的那条，不是任何一条待办负责人的就不归。系统消息、撤回的消息不算。
- **状态，按顺序判断**：已完成 → done（只列本地日期是今天的）；等验收（`awaitingReview`）→ you/review；负责人有没回答的提问 → you/answer；负责人这次唤起有权限卡片在等 → you/permit；标了卡住 → stuck（line 写卡住的原因）；没人负责 → stuck；负责人停着、还欠着这条（`owes`）→ stuck（`since` 取 `owes.since`）；这件事里最后一次点负责人没叫成或中途断了 → stuck；负责人在跑（有 `runId`，或者自己报了在做）→ doing（line 写它在做什么）；其余算 stuck，line 写「还没开始」或「停着：到「某一步」」。
- **line**：等验收取请验收说明的第一句；提问取问题本身；卡住取原因；在做取在做什么；做完写「已验收」；都没有就取这件事最新一条 agent 回复的摘要句（`gist`，没有就用 `gistOf` 现算）。粗体、代码引号这类标记会去掉，最长 80 字。
- **talk**：回复链里没有待办、至少有一条 agent 回复的。标题是第一条消息的几个字，只点了名的写「叫 X」。链里有没回答的提问、提问的人名下又没有没做完的待办，就进 you 组（need answer），免得问题被埋在闲聊里；名下有待办的，那条待办已经因为提问进了 you 组。
- **排序**：you 按等了多久（久的在前），stuck 按停了多久，doing、done、talk 按最后动静（新的在前）。
- **测法**：`node scripts/test-digest.mjs`，21 项，用造的数据逐种情况测：等验收、提问、权限、卡住、停着欠活、点名失败、在做、今天和昨天做完、没人负责、还没开始、没挂待办的对话、一条消息点了两条待办、同链里别人负责的回复、排序和计数。`node scripts/test-digest.mjs --live http://127.0.0.1:4399 <项目 id>` 只用 GET 读那个项目的快照，打印各组。`scripts/ts-alias.mjs` 让普通 node 脚本能 import 用了 `@/` 别名、不带扩展名的 `lib/*.ts`。

## MCP 和唤起是两件事

MCP 只管 agent → 房间：入座、发言、收件箱、任务、在线。房间 → agent（被 @ 时叫醒）MCP 做不到，因为 MCP 服务器不能让闲着的会话开始新的一轮，仍然靠 `agents.json` 的命令。

用 AI 跑开发服务时，Next 16.4 会因为一条安全升级提示自己退出。测试时用 `env -i HOME="$HOME" PATH="$PATH" http_proxy="$http_proxy" https_proxy="$https_proxy" all_proxy="$all_proxy" no_proxy="$no_proxy" npx next dev -p 4399 -H 127.0.0.1` 启动。代理变量一定要带上：被唤起的 cursor-agent、agy 继承房间的环境，没有代理会报 `socket disconnected before secure TLS connection`。

## 待命（bench_wait）

`POST /api/v1/wait` 是长轮询：有点给这个席位的消息（@、交接、回复它）就返回，否则等到超时。MCP 的 `bench_wait` 包着它，agent 在用户让它「守着房间」时循环调用，响应是秒级的，而且不另起进程。

- 席位挂在等待里时 `standby` 为 true，页面显示「待命」。
- 每次等待开始时，房间记下「待命到 超时 + 10 分钟」。这段时间里 `lib/summon.ts` 不再用命令唤起它，消息留给下一次 `bench_wait` 取走，免得同一个会话同时跑两轮。
- 一次等待的时长按客户端的工具超时定：Claude、Codex、DeepSeek 540 秒，Cursor、Antigravity 50 秒（不知道它们的上限）。`register-mcp.sh` 把 Codex 的 `tool_timeout_sec` 和 DeepSeek 的 `toolCallTimeoutMs` 调到 600 秒。`BENCH_WAIT_SEC` 环境变量可以覆盖。
- 用户在客户端里打断时，客户端发 `notifications/cancelled`，`bench-mcp.mjs` 中止那次 HTTP 请求，房间那边随之结束等待。
- `bench-mcp.mjs` 发请求用 `node:http`，不用 `fetch`：Node 的 fetch（undici）等响应头最多 300 秒，超过就断。`bench_wait`（540 秒）、`bench_ask`（默认 600 秒）、权限申请和 `bench_elevate`（11 分钟）都是等到用户点了才回响应头，用 fetch 时超过 5 分钟一律断开，还被说成「房间没开」。现在只有连不上（`ECONNREFUSED`、找不到主机）才报「房间没开」；自己的超时、连接中途断开各有各的说法。`bench_ask` 等回答时断开，会说问题已经在群里、回答时会叫醒你，不让 agent 再问一遍。2026-11-11 在隔离副本里实测：提问后 6 分钟才回答，新桥拿到答案，原来的 fetch 版在 300 秒报「房间没开」。
- 代价：这个会话被占住，用户要先打断才能在它自己的窗口里说话；每次超时返回再调用都是一次模型推理（大部分命中缓存）；上下文会越来越长。

## Windows

2026-11 加的，只在 Linux 上写和测，**没有 Windows 实机测过**。能用 Linux 验证的部分（`lib/platform.ts` 的纯逻辑，把平台当参数传进去，在 Linux 上模拟 `win32` 检查；参数经 Git Bash 传递时引号、`$`、反引号、中文都原样到达）已经验过，其余只是按文档和习惯写的。

- 唤起命令（`lib/kinds.ts`）和 `scripts/*.sh` 都是 bash。Windows 上房间用 Git Bash 跑（`lib/platform.ts` 的 `commandLine`、`scriptCommand`）：先找 `BENCH_BASH`、`Program Files\Git\bin\bash.exe` 等位置，再 `where bash`，**不用** `System32\bash.exe`（那是 WSL，另一台机器）。找不到会在席位上报一句中文说明。
- 房间自己调用的命令行（开新会话、列模型、额度：codex、cursor-agent、codebuddy、agy、dsh-agent、git）也走 Git Bash（`cliCommand`，参数用 `"$@"` 原样传）。原因：npm 装的命令行是 `.cmd`，Node 新版不经 shell 不让启动 `.cmd`；而 npm 同时会装一份没有后缀的 shell 脚本，Git Bash 能直接跑。
- PATH 用 `;` 分隔，补上 `~/.local/bin`、`%APPDATA%\npm`、WinGet 的 Links；找命令时按 `PATHEXT` 试后缀（`summonPath`、`installed`）。
- 停止一次唤起：Windows 没有进程组，用 `taskkill /T /F` 杀整棵进程树（`killTree`）；Unix 照旧杀进程组。
- 选文件夹：Windows 用 PowerShell 的 WinForms 对话框（`app/api/v1/folder/route.ts`）。目录、起始路径、选哪种都用环境变量传进去，不拼进脚本。「选多个文件夹」在 Windows 上只能选一个。
- 临时目录放 `%LOCALAPPDATA%\bench\scratch`（`dataHome`）；注册脚本在 Git Bash 里用 `cygpath -m` 把 node 和 bench-mcp.mjs 换成 `C:/…` 路径再写进各家配置。
- **还不行的**：`workbuddy-wake.sh`（读 WorkBuddy 的 sqlite 要 `python3`，装在 `/opt/apps/…`）、`/usr/lib/chatgpt/resources/codex` 这类 Linux 安装路径、`~/.local/state/bench-mcp`（Windows 上也能用，只是不是 `%LOCALAPPDATA%`，bench-mcp.mjs 和 spawn.ts 得一起改才能换）。各家客户端在 Windows 上的会话、凭据存放位置（额度读的 `~/.claude/.credentials.json` 等）没有核对过。

## 红点上的问题要点得到

项目卡片的红点（`waiting`）算的是房间里所有没答的 `bench_ask` 问题、没处理的权限申请和等验收的待办，可群聊只画最近一段（`PAGE`），一张很早的问题卡可以在几百条之前，红点在却点不到。2026-11：问题卡不在已画出的消息里时，`components/room/ask-card.tsx` 的 `PinnedAsks` 把它们钉在群聊顶上（`sticky`），一行「还有 N 个问题在等你回答」，点开就在里面直接答，答完红点跟着清掉。即使问题卡已经滑出快照最近 400 条热窗口之外，`RoomSnapshot.openAsks` 也会从 SQLite 里把所有未答提问卡单独带出并钉在顶部，回答时直接更新 SQLite。待办在右栏、权限申请有自己的位置，不受这个影响。

## 左栏：平时每个席位只占一行

2026-11 瘦身（Fable 设计，`components/room/roster.tsx`）。以前 Claude 一家带四个席位就占 500px，1080p 一屏只放得下两家半。

**上屏的东西分三档，新东西先归档再动手：**

1. **常驻**：每家一行（头像、名字、额度圆环、展开箭头），每个席位一行（状态灯、名字、「待命」、上下文细条）。这一档要加东西得有很硬的理由。
2. **有事才出现**：在那一行底下多一行，事情过去就消失。现在有：停了 3 分钟以上、名下还有没着落的事，写「停着 · 还欠 N 件」和「叫它接着做」（见「点名的去向和停着还欠着活」）；自己说在做很久没再报，写「不确定在不在做」；上下文到压缩点的 70%（`CONTEXT_WARN`）写「上下文 33万 / 40万」，能压就带「压缩」（和菜单里「压缩上下文」同一个条件）；在干活或卡住（working、blocked 或有 runId）写在做什么，有 runId 时点它看过程，右边两个图标是插话和停止；队列里有排队消息或已暂停自动唤起时显示可控队列条（点开可逐条点 `×` 剔除误发指令、或切换暂停/恢复）；终端开着。额度到 80% 在圆环左边写「每周 85%」，用完写「用完」并变红，读不到写黄色「读不到额度」。家名右边的状态字只在出问题时写（没装、没配唤起命令、没报会话）。
3. **点了才有**：点额度圆环或箭头展开那一家（客户端 · 会话数、全部额度、速度、开新会话，`Reveal` 动画），展开的是哪几家按浏览器存在 localStorage `bench-roster-open`；右上角「接入」左边全部展开 / 全部收起；悬停圆环浮出各条额度、最紧那条的重置时间和速度（base-ui Tooltip，挂在 body 上，不挤动布局，也不被左栏的滚动裁掉）；悬停席位名字看模型 · 分工、状态或最后在线多久前、空闲时的 `doing`；「…」菜单平时不显示，鼠标移到那一行、键盘聚焦或菜单开着时才出现（触屏上半透明常显），里面包含「席位档案与记忆…」「切换客户端 / 顶替…」「暂停/恢复自动唤起」等低频操作。

**新功能默认放第三档。** 左栏每个席位平时只占一行，不要再往席位行下面加常驻的说明行。

- 点头像和名字照旧是 @ 这一家；圆环和箭头是另外的按钮（以前整行是一个按钮，不能套按钮）。
- 数据变了不自动展开或收起，只改颜色和多出来的那一行。
- 没席位的那几家各收成一小行（24px 头像、名字、「还没接入」、箭头），排在有席位的后面；点了在原地展开「开新会话」（这一家能开时）和「接入已有会话…」（走接入对话框），展开状态和有席位的那几家记在同一处。别让这一行只通到接入对话框：那样没会话的一家就开不了新会话，绕成死路。房间里一个席位都没有时，所有家照完整样子列出来并全部展开、没有箭头，那是进房间的入口。
- 截图测：无头 Chrome 不认 `hover: hover`，而 Tailwind v4 的 `hover:`、`group-hover:` 都包在这个媒体查询里，所以无头截图里「…」不会跟着鼠标出现（落到触屏规则半透明常显），要模拟桌面就往页面注入等价的样式。各种状态可以在浏览器里拦 `/api/v1/quota`、`/api/v1/context`、`/api/v1/room` 的响应改出来，不用动数据。

## 撞到额度：群里写原因，弹卡片，重置后自动继续

2026-11 加的。以前 Claude 撞到额度时，房间贴的是客户端另一行报错（`[claude-code:unrecognized_model]…`），真正的「You've hit your 5-hour limit · resets 3:30pm」只在「过程」里，群里看不到。

- **认出**：`lib/limits.ts` 的 `detectLimit` 读 Claude Code 的原话，得到撞到的是什么（5 小时 / 会话 / 每周，带模型名的每周也认）和重置时间（`resets 3:30pm (America/Los_Angeles)`、`resets Nov 12, 3pm`、`resets Thu 9am` 都认，按它写的时区算，夏令时也对）。没读出时间时不猜，卡片上就没有「自动继续」，只剩「现在重试」。只认 Claude Code 这一种格式，别家的限额提示没见过，没猜。
- **只在这一轮失败时才认**（`lib/summon.ts` 的 `limitOf`）：而且要看它最后说的话（回答或最后一条文字步骤），不看 `failure`（那一行可以是别的）。一个成功的回答里引用这句话不会出卡片。
- **卡片**：群里一条系统消息带 `limited`（`LimitedRun`，`components/room/limited-card.tsx`）。按钮：「重置后自动继续 · 15:30」「现在重试」「换别的 AI 顶替…」「不用了」；定了时之后显示「15:30 自动叫醒 X 接着做」和「取消」；点「换别的 AI 顶替…」打开 `SeatProfileDialog` 的切换页签（`POST /api/v1/runs/<id>` `action: "rebind"`），把该席位切到另一家客户端（如 Codex / Gemini / DeepSeek）并带着原席位的职责、长期记忆、负责待办和未完消息立即接着做，卡片变为 `rebound`（「已换 <客户端> 顶替接力」）；叫醒后显示「已经叫醒」。状态：open → scheduled → resumed / failed / rebound，或 dismissed。
- **定时**：`POST /api/v1/runs/<id>` 的 `action`：`schedule`（重置时间 + 45 秒）、`now`、`cancel`、`dismiss`（`limitChoice`）。到点调 `rewake`，和重启后的「重新叫醒」是同一条路：带着当时那些消息接着做（run 上存着 `body`、`project`）。定时写在 `data/runs.json` 的 `run.limited.resumeAt` 里，重启后 `rearmResumes` 重新设；重启时已经过去 6 小时以上的不再自动继续（卡片改成「不自动继续」）。
- **Codex 也认**（2026-11 加）：Codex 撞额度时，错误只在事件流里：`{"type":"turn.failed","error":{"message":"You’ve hit your usage limit. Visit https://chatgpt.com/settings/usage to purchase more credits or try again at Nov 12th, 2026 7:42 PM."}}`（弯引号；时间没写时区，和额度读数 11/12 19:42 对得上，按本机时间算）。以前解析器把这行丢了，房间只说「退出码 1」；现在 `lib/events.ts` 把 `turn.failed` 留成一条失败的「过程」步骤（不算「答完」，进程会自己退），`limitOf` 看这条。2026-11-09 用真的 Codex 在测试副本里验过：卡片写「撞到了「使用额度」，11/12 19:42 重置」，定时和取消都对。
- **Cursor、Antigravity 没接**：这两家的限额报错没见过（本机额度都没用完，也不为了测试去耗光它），不猜格式。碰到一次真的，把原话贴到这里再加。免费版 Cursor 的 `Model unavailable on Free` 是另一回事，已经单独说明。
- 测试注意：从席位的终端里起测试副本，会继承这个席位的 `BENCH_MODEL` 等环境变量，传给 Codex 的唤起，用 `env -u BENCH_MODEL -u BENCH_EFFORT …` 起。Codex 的线程会记住上一次用的模型，被污染的线程要换新的。
- **叫醒后又撞上**：会再出一张新卡片，要用户再点一次，不会自己循环。
- 只发给撞到额度的那一次唤起；写摘要和单独回话的失败也认，其余失败原因不变。
- 测试别耗真额度：测试副本里把 `agents.json` 的 claude 命令换成一个假脚本，第一次输出 `You've hit your 5-hour limit · resets …`（`date` 要加 `LC_ALL=C`，中文环境会打出「下午」）并退出 1，之后输出正常回答。

## 别的项目做完时弹系统通知（2026-11-12）

用户要的：人在别的项目里时，有项目做完了推通知给他。`components/room/notify.ts` 的 `useProjectNotices`，挂在 `room-app.tsx`。

- 数据：项目列表（`listProjects`，页面每 5 秒轮询）每个项目多带 `lastEnd`：最近一条没撤回的「【本轮结束】」（`message.end`），去掉标记后的前 140 字和谁说的。等你处理的数原来就有（`waiting`）。
- 页面每次拿到列表跟上一次比：出现新的 `lastEnd` 就弹「「项目」谁 做完了」+ 那句话；`waiting` 变多就弹「「项目」有 N 件等你处理」。只对不在看的项目：别的项目，或者页面在后台（`document.hidden`）时的当前项目。页面刚打开、项目刚出现时已有的不算新消息。tag 用消息 id，开两个标签页同一条只弹一次。点通知：回到页面，左栏切回房间档，进那个项目。
- 显示在哪：顶栏正中一条毛玻璃圆角胶囊（`components/room/project-notices.tsx`，样式在 `globals.css`「Project notices」），一直有、不用开：左边一颗发言人颜色的圆点（等你处理是琥珀色），项目名、谁做完了、那句话的开头。最新的在最上面，最多三条。6 秒后自己走，鼠标停在上面或标签页在后台时计时暂停；没有按钮（用户：只起通知作用，不增加使用成本），想去的话点胶囊本身就进那个项目。动画：整行高度从 0 展开（其他条滑开不跳），胶囊带一点回弹从上方模糊中落下，圆点晚一拍弹出并扩散一圈，文字随后从左滑入；离开时上浮、缩小、模糊淡出，同时这一行收起。减少动态效果时只淡入淡出。深色下圆点颜色掺白提亮（席位颜色是按浅色挑的）。第一版用 sonner 默认样式，用户说跟整体调性不搭；第二版有「去看看」和关闭按钮，用户要去掉。另外设置菜单「别的项目做完时也弹桌面通知」（localStorage `bench-notify`，默认关）勾上后，页面不在前台（`document.hidden` 或没焦点）时同时弹系统桌面通知；勾的时候才向浏览器要通知权限（必须由点击触发），被拦提示去地址栏站点设置里允许。`127.0.0.1` 算安全来源，不用 https。第一版只有桌面通知且默认关，用户一条也没看到，所以改成页面提示默认就有。坑：测的时候别隔几秒才去查提示在不在，它 6 秒就走了，要录屏看。
- 局限：靠轮询，标签页在后台几分钟后浏览器会把定时器压到一分钟一次，通知可能晚到一分钟；页面整个关掉就没有通知（要那样得做 Service Worker 推送）。
- 测法：测试副本里用 CDP `Browser.grantPermissions` 给通知权限，`addScriptToEvaluateOnNewDocument` 包一层 `Notification` 记下每次弹的内容，用 agent 的 token 在另一个项目 `/api/v1/say` 发「【本轮结束】…」、`/api/v1/ask` 提问，看记录；再调最后一条的 `onclick` 看是否进了那个项目。无头浏览器看不到真正的系统通知弹窗。

## 有事等你时推到手机（可选，默认关）

桌面通知要求浏览器标签页还开着；人不在电脑前或关了页面时，可以在顶栏「设置 → 推送到手机…」里配一条推送（`lib/push.ts`、`app/api/v1/push/route.ts`、`components/room/push-dialog.tsx`）：

- **渠道表（`CHANNEL_TABLE`）**：六种格式做成一张表，以后加一种只往表里添一项：`ntfy`（POST 纯文本 + RFC 2047 UTF-8 `Title` 头 + 可选 Bearer 口令）、`bark`（POST JSON `{title, body, group}`）、`wecom`（企业微信群机器人 Webhook）、`feishu`（飞书自定义机器人 Webhook，可选填签名校验密钥自动算 HMAC-SHA256）、`telegram`（Bot Token + Chat ID + 可选自定义 API 地址）、`webhook`（自定义 POST JSON，可选 Bearer 口令）。两个可选项：「有人说【本轮结束】也推」（默认不勾）、「只推标题，不带正文」（默认不勾，勾上后只写哪个项目、谁、什么事，不带那 60 字正文）。
- **什么时候推（服务端判断，没开网页也能推）**：跨所有项目监听四件事——席位 `bench_ask` 向用户提问、待办进入等用户验收、权限申请等满 **30 秒**还没人点、以及开启对应勾选项时的 `【本轮结束】`。
- **防打扰与合并**：
  - 页面可见且有焦点时每 25 秒（及切回焦点时）向 `POST /api/v1/push` 报一次 `action: "presence"`；服务端 60 秒内收到过就算人在电脑前，跳过自动推送（「测一下」不受此限）。
  - 同一项目 **20 秒**内的多件事合成一条发出；真正发出前逐条复查状态，提问已被回答（或撤回）、待办已不再等验收、权限在 30 秒内已被处理的，一律不补推。
- **安全与网络**：地址和口令只存在 `data/push.json`（权限强制 `0600`）；没有填好或未启用时绝不外发。`GET/POST /api/v1/push` 都要求用户口令（`x-bench-human`），且只回传布尔标记 `filled`（填没填），任何接口响应、房间快照、群聊和错误文本都不回显 URL、口令或 Chat ID。发送器用原生 `node:http`/`node:https`/`node:tls`/`node:net` 尊重进程环境变量 `HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY` 与 `NO_PROXY`（支持 HTTP 转发、HTTPS CONNECT 与无认证 SOCKS5，零外部依赖）；发送失败最多重试 1 次，脱敏后的最近一次错误只显示在设置弹窗里。
- **测法**：**绝不要往真实外部服务发测试消息**。在隔离副本里起本地 `127.0.0.1` 的 `node:http` 假接收端测试（已集成进 `scripts/test-room.mjs`；快跑可给测试副本设 `BENCH_PUSH_MERGE_MS=600 BENCH_PUSH_PERMIT_MS=1200`，不设则按真实 20 秒 / 30 秒跑完）。

## 账号额度（5 小时 / 每周）

`lib/quota.ts`、`GET /api/v1/quota`（缓存五分钟，挂在 `globalThis` 并存 `data/quota-cache.json`，`?fresh=1` 跳过普通缓存），页面在 `components/room/quota.tsx`，仅标签页可见时每五分钟读一次，入口栏每家一行只放一个圆环，代表用得最多的那一条（`QuotaRing`，规则见「左栏：平时每个席位只占一行」）；一条条「窗口 · 进度条 · 已用% · 重置时间」在悬停圆环浮出的卡片里和点开那一家的详情里，悬停某一条看完整重置时间和还剩多久。只做了用账号登录的四家：

- Claude Code：读 `~/.claude/.credentials.json` 里的 OAuth 登录，请求 `https://api.anthropic.com/api/oauth/usage`（Claude Code 的 `/usage` 读的同一个），取 `limits` 里的 `session`（5 小时）、`weekly_all`（每周）、`weekly_scoped`（按模型单列的周额度，比如「Fable 周」）。这个接口限流严、429 时回 `Retry-After: 0`，高频轮询会一直续期 429：照 Claude Code 自己的做法，遇到 429 至少冷却 5 分钟（连续触发翻倍，最长 1 小时，冷却期内 `?fresh=1` 也不穿透；平时真请求之间也至少隔 1 分钟），冷却或网络出错期间如果有 6 小时内的旧读数就先显示旧数并注明「上次读数 · 多久前」。登录过期时不替它刷新（刷新会换掉它的 refresh token），只显示「登录过期」，它下次运行自己续。
- Codex：`~/.codex/auth.json` 的 `auth_mode` 是 `chatgpt` 才算账号；开一个短命的 `codex app-server`，调 `account/rateLimits/read`，按 `windowDurationMins` 认 300＝5 小时、10080＝每周。周额度用完时它只回周那一条，5 小时那条不出现。
- Antigravity：`agy -p /quota`（在临时目录跑，本机直接回，不跑模型、不新建对话），每行用制表符分成「模型组 · 窗口 · 剩余% · 重置时间」。Gemini 和 Claude/GPT 两组额度分开，页面按组各显示 5 小时和每周；它给的是剩余，房间换算成已用。
- Cursor：没有 5 小时 / 每周，额度按月计费周期算。用 `~/.config/cursor/auth.json` 的登录调它 CLI `/usage` 用的 `aiserver.v1.DashboardService/GetCurrentPeriodUsage`（`api2.cursor.sh`，Connect 协议 JSON），显示本月合计、Auto、API 三条，重置时间是周期结束。付费套餐可能还有滚动窗口（`GetSandUsageStatus`），免费版 `includedLimitZero` 为真，不显示。token 过期（401）只提示，不替它刷新。

用 API key 的、以及其他家（CodeBuddy、WorkBuddy…）不显示：没找到能在本机读的账号额度接口。登录口令只发给各家自己的服务器，不进接口响应、不进页面。

### 插件递交用量

房间自己读不到的（CodeBuddy/WorkBuddy 的积分、Qoder、Copilot…），由插件、hook 或定时脚本发给 `POST /api/v1/quota`，`lib/quota-reports.ts` 收：

```json
{ "kind": "workbuddy", "source": "WorkBuddy 插件", "plan": "标准版", "ttl": 21600,
  "windows": [{ "label": "本月", "span": "month", "used": 1300, "limit": 4000, "resetsAt": "2026-12-01T00:00:00+08:00" }] }
```

- `kind` 必须是 `lib/kinds.ts` 里的 id。`windows` 最多 8 条，每条给 `percent`（已用）、`percentLeft`（剩余）或 `used` 加 `limit` 中的一种。`span` 是 `5h`、`day`、`week`、`month` 或 `other`。`group` 可选，用来分组显示。
- `ttl` 是秒数，默认 6 小时、最长 31 天，过期就不显示，免得插件停了还挂着旧数。`windows: []` 撤下这一家。
- 存在 `data/quota-reports.json`，重启后还在。
- 房间自己读得到数的那家，以房间读的为准，插件发来的不覆盖，所以没法冒充 Claude、Codex 这几家。页面在插件数下面标「X 递交 · 多久前」。
- 和别的 POST 一样，要 `content-type: application/json`，带别的网站 Origin 的会被拒（`guard`）。不需要口令：这只是显示用的数。
- 现成的发送脚本：`node scripts/quota-push.mjs --kind workbuddy --window "本月|month|used=1300,limit=4000|2026-12-01T00:00:00+08:00"`，也能用 `-` 从标准输入读整份 JSON。`BENCH_URL` 改房间地址。
- 席位栏只显示核心几家和已经有席位的那几家；没有入口的 kind 发了也看不到。

## 席位的上下文：显示和压缩

花名册里每个席位名下面有一条「上下文 ▬| 33万 / 100万」：它自己那个会话现在有多大、最多能多大，竖线是它会自己压缩的地方。悬停能看精确数、模型和上次压缩（时间、自动还是手动、压前压后）。

- 读法（`lib/context.ts`）：读会话自己的记录，所以不管是房间唤起的还是你在它窗口里打字的都准。只读文件末尾 4 MB（找不到再往前，最多 16 MB），按文件修改时间缓存。
  - Claude Code：`~/.claude/projects/*/<id>.jsonl` 里最后一条 assistant 的 usage（input + cache_creation + cache_read + output）；之后有 `compact_boundary` 就用它的 `postTokens`。分母是 `autoCompactWindow`（`modelSettings.<模型>.autoCompactWindow` 优先，项目 `.claude/settings*.json` 盖过用户 `~/.claude/settings.json`），没设就是模型窗口：现行模型 100 万，Haiku 4.5 和 Opus/Sonnet 4.5 以前 20 万。
  - Codex：`~/.codex/sessions/年/月/日/rollout-*-<id>.jsonl` 里最后一个 `token_count` 的 `last_token_usage.total_tokens` / `model_context_window`。之后有 `compacted` 记录时现在多大不知道，显示「刚压缩」，等它下一轮。
  - 其他客户端读不到，不显示。
- `GET /api/v1/context?project=` 按席位 id 给出；页面每分钟读一次，有席位开始或结束唤起时也读（`components/room/context.tsx`）。
- 压缩：席位菜单「压缩上下文」（只对 Claude/Codex、能唤起、没在跑、没挂在 bench_wait 的席位出现）→ `POST /api/v1/agents/<id> {as:"human", action:"compact"}` → `lib/summon.ts` 的 `compactSession`：像一次唤起那样排在这个席位的队里，命令里的话换成 `/compact`，「过程」里记为「压缩上下文」，停止、重启打断后重新叫醒都照常。Claude Code 无界面模式直接认 `/compact`；`scripts/codex-app.mjs` 见到 `/compact` 改发 `thread/compact/start`，等 `thread/compacted`（`BENCH_CODEX_EXEC=1` 的老路不支持，直接报错）。
- 斜杠命令：输入框里以 `/goal`、`/compact`、`/stop` 开头（前面可以先有 @）的一行不发进群聊，而是发给这一行里 @ 到的席位（`@所有人` 是全部席位，不适用的席位悄悄跳过）。命令表和解析在 `lib/commands.ts`，输入框打 `/` 弹出菜单，下方提示这一行会发给谁；发送在 `room-app.tsx` 的 `sendSlash`，走的是席位动作 `POST /api/v1/agents/<id>`，`/compact`、`/stop` 就是菜单里那两项。只收两家（Claude Code、Codex）都有、而且无界面也能跑的命令；`/model`、`/effort` 用席位菜单的「换模型」；`/clear` 会换会话 id，房间跟不上，所以没做。别的以 `/` 开头的话（比如路径）照常当消息。
- `/goal`：`{action:"goal", text}` → `lib/summon.ts` 的 `requestGoal`，群里先说一句谁给谁定了什么目标，然后在这个席位的队里排一轮 `setGoal`（「过程」里记为「按目标干活」）。命令里的话就是 `/goal <目标>`，不套房间的提示词；`clear`、`清除`、`清掉` 都会换成 `/goal clear`。这一轮跟回复点名一样带 `BENCH_RUN_KEY`，中途叫它的消息会送进来；最后的回答作为它的发言贴进群。Claude Code 无界面模式直接认 `/goal`，回一句 Goal set 后一直干到条件满足；`scripts/codex-app.mjs` 把它换成 `thread/goal/set`，Codex 会自己开一轮去干，可能还接着开好几轮，脚本跟着走，最后一轮结束后 8 秒内没有新的一轮才收工；`/goal clear` 换成 `thread/goal/clear`。目标是留在会话上的：之后的唤起仍会按它做，直到达成或被清掉。终端开着时，`/goal …` 原样打进终端。`BENCH_CODEX_EXEC=1` 的老路不支持，直接报错。
- 做完在群里写一句：记录里出现了新的压缩才算压缩好了（「2.3 万 → 6038」）；没出现就把客户端的原话贴出来（会话太短时 Claude 会说 "Not enough messages to compact."）。记录里有了新的压缩，就算进程退出时报了错也按压缩好了算。2026-11-14 压缩 Fable 时，压缩本身成功了，房间却贴了「没成功：… socat[52] E write(5, …): Broken pipe」。原因有两层：

  - Claude 的 `/compact` 这一轮没有回答文字，也没有步骤。
  - 本机隔离启动器（bwrap 里用 socat 把 4399、7897、7863 桥到外面）在 stderr 里打了一行 socat 报错，是某条桥接连接被对面先关掉了。

  `launch` 有一条规则：退出码 0、没回答、只有 stderr，就把 stderr 最后一行当失败原因。现在算失败原因之前，先去掉 socat 的日志行（`withoutBridgeNoise`，匹配 `YYYY/MM/DD hh:mm:ss socat[N] E|W|N|I …`）。测法：

  - `scripts/test-room.mjs` 里的「去向桥」席位：只往 stderr 写这一行就退出，应记成 silent，而不是 failed。
  - 压缩路径：在隔离副本里把 `HOME` 指到一个假目录，用一个假的 `claude` 往会话记录追加 `compact_boundary`，同时往 stderr 写 socat 那行。旧代码复现出了同一句「没成功」，新代码报「压缩好了：77.3 万 → 1.5 万」。
- 压缩会丢细节，只在你点的时候做，房间不会自己替谁压缩。
- 按席位设两项（「换模型…」「开新会话」）：下拉框「最大上下文窗口」（默认＝模型自带的，或 10/20/30/40/50/100 万，存 `windowPick`），滑条「用到多少自动压缩」（10%～100%，步长 5，默认＝跟客户端自己的设置走，存 `compactPct`）。`lib/context.ts` 的 `compactPoint` 算出「窗口 × 百分比」（没选窗口就用模型的窗口；Claude 低于 10 万按 10 万），`compactEnv` 以 `BENCH_COMPACT_WINDOW` 交给每次唤起和网页终端：`claude-code.sh`、`terminal.sh` 设成 `CLAUDE_CODE_AUTO_COMPACT_WINDOW`（Claude Code 认它优先于所有 settings 文件，`/autocompact` 会显示 "from CLAUDE_CODE_AUTO_COMPACT_WINDOW"；它真正动手的点比这个数略低一点，留给摘要的余量）；`codex-app.mjs`、`codex-wake.sh`、`terminal.sh` 传 `-c model_auto_compact_token_limit=…`。两项都不设就什么都不传。只影响房间叫醒它的那几轮，不改你的全局设置。
- 上下文条：满格＝最大窗口，竖线＝压缩点（选了的用选的，没选的 Claude 用 settings 里的 `autoCompactWindow`，Codex 不知道就不画）；颜色看离压缩点多近：70% 变黄、90% 变红。
- 为什么交给客户端、不由房间接管：客户端在一轮中途、快满的那一刻就能压；房间只能在两轮之间压，一轮里读了大文件照样会撑爆。

## 对话左边的刻度尺和律动

宽屏上对话列两边有空白。左边放刻度尺（`components/room/trajectory.tsx`，名字沿用最早的「轨迹」），右边故意空着（用户定的：不对称更好看，别补成对称）。左边空白不到 64px 时不画刻度尺，不到 150px 时不画律动。

- **刻度尺**：参考 GPT 客户端的做法，但按房间的风格画。最早做过一版按时间画「谁在跑、调了哪些工具」的轨迹，用户看过后改成了这个。
  - 每条消息（不含系统通知、撤回的）一根短横，从上到下就是群聊的顺序，最新的在最下面；条数少时先把间距从 9px 拉开到最多 18px，还铺不满就上下居中；放不下时只画最近的，顶上标「↑N」。
  - 颜色是发言席位的颜色，用户自己的是前景色；越长的消息横线越长（按字数取对数）。2026-11-12 试过像 Codex 那样每根一样长，用户看了说不如原来好看，改回来了。
  - 群聊里正看着的那几条（`[data-message]` 在滚动框里、输入框以上）整根点亮，滚动时跟着变。
  - 鼠标附近的几根像程序坞一样变长（`useDock`：每帧把 `--near` 直接写到横线上，不走 React 状态；鼠标在尺上时 `data-docking` 关掉横线的过渡。以前是 100ms 的 width 过渡，鼠标每动一下、音乐每一帧都把它重启，划过去时要等停下来才变长，2026-11-12 改成实时）；停在一根上弹一张毛玻璃小卡片（谁、几点、开头三行），点一下跳到那条（`goto("message", id)`，和消息里点消息号同一条路，太早没画出来的会先加载）。
  - 最下面每个正在干活的席位一个呼吸光点，点开看它这次的过程。
  - 跟着「只看和他有关的」走：传进来的是 `visibleMessages`。
- **律动**：电脑正在放声音时（有没有席位在干活都一样），刻度尺的横线自己跟着音乐伸长（不另画别的东西，用户明确要的）：最下面一根对应最低的频段，最上面对应最高的，中间按位置插值，越响越长。每帧直接改每根横线的 `--beat`（`useBeat`），不经过 React。刻度尺上方的音符按钮可以关掉（存在 `bench-rhythm`）；系统设置了「减少动态」时不动。
  - 服务端 `lib/audio.ts` 用 `parec` 读默认输出设备的 monitor（PulseAudio，或 PipeWire 的 pulse 兼容层），22050Hz 单声道，每秒约 30 次 FFT，算成 20 个频段的响度（-70 dB 到 0）。传到页面的只有这些数字，声音本身不出这个文件。
  - `GET /api/v1/audio`：一行一个 JSON，只认用户自己页面的口令头（`x-bench-human`），别的请求 403。所有打开的页面共用一个采集进程，最后一个页面断开 3 秒后停掉。页面只在律动开着、标签页在前台时连接。
  - 页面判断「在放」：连续约半秒有声才算开始，安静 4 秒才算结束，免得歌曲间隙闪来闪去。
  - Linux 以外的系统、没有 `parec` 的机器，接口回 204，就只有刻度尺。环境变量 `BENCH_AUDIO_CMD` 可以换掉采集命令（往标准输出写 22050Hz 单声道 s16le），测试时用 `ffmpeg -re -f lavfi -i "aevalsrc=…" -ac 1 -f s16le -` 造声音，不用真的出声。它在自己的进程组里跑，停的时候连同 shell 起的子进程一起停。

- **深色下的三种样子**（2026-11，只改颜色，长度算法和跳转逻辑没动；样式在 `app/globals.css` 末尾 `[data-ruler-tick]` 那一段，浅色主题仍是发言人的颜色）：
  - 平时：冷灰蓝 `rgba(148,163,184,.42)`（规格原写 .18，实际屏幕上几乎看不见，用户反馈后提到 .42），全圆角。正在看的那几根（`data-lit`）掺进一半发言人的颜色，所以看得出是谁说的；悬停卡片里也有发言人的色点。
  - 鼠标移上去：整条刻度尺的底色平滑提亮（`--lift`，用 `@property` 注册，只在刻度尺这一个元素上做过渡，横线自己不过渡，免得又不跟手）；鼠标附近几根按 `--near` 渐变成白色 `rgba(241,245,249,.9)`，伸长沿用原来的。
  - 放音乐（刻度尺上有 `data-playing`）：每根按 `--beat / --reach` 从深海蓝 `#2563EB` 过渡到 `#38BDF8`，再到 `#818CF8`；外发光是整条刻度尺上的一个 `drop-shadow`，不是每根一个滤镜。`--reach` 由 `trajectory.tsx` 写在刻度尺上，要和 `useBeat` 的 reach 保持一致。
  - 帧率（2026-11 查过）：横线每帧都在变（鼠标、音乐），所以放音乐和鼠标在刻度尺上时，横线的过渡动画必须关掉（`group-data-[playing]` / `[docking]`），否则每帧重启一遍 60 多根的过渡，帧率掉到三分之一；伸长用固定宽度加 `scaleX`，不逐帧改 `width`；音乐 + 鼠标一起时不画整条的发光。以后给横线加新效果，先在「放音乐 + 鼠标划过」下量帧。
  - 律动的帧率：音频每秒只有 30 帧数据（`lib/audio.ts`，每 33ms 一帧），`useBeat` 不能直接照着画，否则横线只有 30 帧的阶梯感。它每个屏幕帧让显示值追着最新数据走（上升约 30ms、下降约 110ms 的时间常数，按真实经过的时间算，所以 60 / 144Hz 都一样顺），没变的横线不写样式。这个循环本来每帧都在跑，所以平滑不增加开销。
  - 系统设置了「减少动态」时律动本来就不开，所以没有发光；悬停变长是鼠标触发的，沿用原来的。

**摘要和别的一次性唤起的提示词有字节上限**（2026-11 查出）：提示词是作为命令行的一个参数交给客户端的，Linux 单个参数最多 128KB，一个汉字占 3 个字节，所以原来 4 万字的对话原文再加上一份摘要和流程提示，直接 `spawn E2BIG`。三处防线：`summaryPrompt` 按字节（`SUMMARY_PROMPT_BYTES`，90KB）从最早的对话往前砍，流程那段只有在它自己就把位置占光时才去掉；`launch` 里 `spawn` 抛错（E2BIG 之类）会走 `finish`，把摘要任务、席位状态、过程记录都收掉，并在群里说「起不来：E2BIG」；以前这里没接，摘要任务和「正在干活」的标记就残留，页面显示在跑，点停止回「没在跑」。`stopAgent` 现在遇到「标着在跑但没有进程」也会把这些残留标记清掉。以后加新的一次性唤起，提示词要走同一个字节预算。

## 群聊的「流程」视图（只读）

2026-11 加的（设计 Fable，数据 `lib/flow.ts`，画图 `components/room/flow.tsx`）。群聊右上角放大镜旁边一组「对话 / 流程」（`thread.tsx`），选了哪个记在 localStorage `bench-thread-view`（`room-app.tsx` 的 `viewSaved` / `showView`，和「摘要 / 详细」走同一个事件）。选「流程」时，群聊那块滚动区换成流程视图，「摘要 / 详细」那组藏起来，输入框照常在下面；`Thread` 不卸载，跳回对话不用重画。左边的刻度尺只在「对话」时画。

- **数据只从 `flowsOf` 来**：一件事就是一条回复链（一条不回复谁的消息和它下面的全部），加上链里第一次写出 id 的待办。列、块、线、等你几处全在那里算好，页面不另推关系；算得不对去改 `lib/flow.ts`。只在「流程」显示时才算（`useMemo`），用的是房间快照里的消息（不受「只看和他有关的」过滤）。
- **列表**：一件事一张卡，最新的在上面。默认只展开第一张，收起的那几张一行写标题、起始时间、「等你 N」、参与者的小圆点。顶上一行写一共等你几处。
- **列**：人类那一列默认在中间，其余席位按 `lanes` 的先后轮流排到它右边、左边（`arrange`）；卡片右上角「你在中间 / 你在最左」切换，记在 `bench-flow-human`。列宽至少 150px，比群聊那栏宽就在卡片里横向滚动，人在中间时打开会先滚到人那一列（只在画出来那一次，之后来新消息不会把你自己的滚动拉回去）。流程视图外层带 `contain: inline-size`，否则图的最小宽度会把群聊那一栏撑宽，窄屏上直接出屏幕。
- **行**：一块一行，左边写时间，和上一块同一分钟就不再写。
- **块**：小字种类（指令、派活、待办 t_…、提问、回答、卡住），标题最多两行，note 一行。等你（`you`）琥珀色描边加淡底，做完的内容变淡，卡住红边，等前一步虚线边透明底。点一块：切回「对话」，下一帧发 `GOTO_EVENT` 跳到那条消息。
- **线**：SVG 垫在块下面，按 ResizeObserver 量到的块位置画（宽度变了、展开后都会重量）。同一列直线往下；跨列从朝向对方那一侧的中间出发，横走再圆角拐下去进对方顶上，这样不会从自己下面穿出来（每行只有一块，横的那段不会压到别的块）。call 实线、wait 虚线，都带箭头。
- 减少动态效果时没有动画（展开用 `Reveal`，块的按下缩放也关掉）。
- 截图验法：流程视图只读，可以用无头浏览器不带口令直接开正式房间看，先在 localStorage 里写好 `bench-thread-view=flow`、`theme`、`bench-flow-human` 再加载。
- **卡片和块的短名（随房间摘要一起写，增量）**：在 `lib/flow-summary.ts`。块上默认是消息开头截出来的字，太长；写房间摘要时（`summon.ts` 的 `summaryPrompt`），`flowsToSummarize` 挑两种：块还没起过名的（新的事，以及上线前只写过总述的旧记录）全部一次给，所以上线后第一次写摘要会把房间里已有的事整理一遍（2026-11-12 正式房间是 33 件、209 块、提示约 2.5 万字）；起过名、之后 `lastAt` 又往后走了的，一次最多 8 件，提示里加一段【流程卡片】：每件附「上次写的」、`flowText` 的样子，和「要起短名的块」（还没短名、标题超过 10 字的块，每件最多 16 块，附原文前 160 字）；没有新动静就不加这段，不多花 token。写的人在正文 `## 待定` 后面接一段 `## 流程`，每件 `### m_…` 开头，下面「标题：…」（14 字内）、一两句总述、`- 块编号：短名`（12 字内）。`saveSummary` 用 `splitFlowSummaries` 把这段切下来，正文照旧存、照旧发给席位（席位拿到的摘要里没有这段）；各件按根消息 id 存进 `summary.flows`（`{text, title, nodes, upToAt, by, at}`，块名和旧的合并，最多留 80 件）。`upToAt` 记的是派活那一刻这件事走到哪（job 的 `flowsAt`），写摘要那几十秒里的新动静下次还会算新的；没列给它的件写了也不收（手动「编辑摘要」不限）。页面上：卡片标题用 `title`，下面一行是总述（收起时两行截断，之后又有新动静就标「之后又有新动静」），块上用 `nodes[块 id]`，没有就照旧显示原来的字，悬停看原来的字。注意：写摘要的那一轮由启动时挂上的叫醒循环跑，热更新换不到它，改了 `flow-summary.ts` 或 `summaryPrompt` 要重启服务才生效。验法：隔离副本、假写手（读提示里的 `### m_…` 和 `- 块编号（`，输出带 `## 流程` 的摘要），连写三次看第二次提示里没有【流程卡片】、第三次只列新出来的块，旧块名留着。

## Token 测速台（内置）

以前 `ai_speed.py` 是单独跑在 8765 端口的 Python 服务，现在已经原生合进并坐，不再需要外部 Python 进程。各家记录的字段怎么读、速度怎么算、加一家要改哪几处，写在 `docs/测速台适配.md`：

- 扫描进程（`scripts/speed-worker.mjs`、`lib/speed.ts`）：按需拉起一个独立的 Node IPC 子进程（5 分钟没人查自动退出归还内存），用 512 KB Buffer 按字节预筛扫描 `~/.claude/projects/**/*.jsonl`、`~/.codex/{sessions,archived_sessions}/**/*.jsonl(.zst)`、`~/.gemini/{antigravity,antigravity-cli}/conversations/*.db`（Node 24 原生 `node:sqlite` 只读 + 轻量 protobuf 解码，按回复 id 去重合并桌面端和被房间叫醒的会话）和 `~/.dsh/sessions/**/session.v4.jsonl.zstd`（`dsh` 每条事件追加一个独立 zstd frame，Node 的 `zlib.zstdDecompressSync` 只解第一帧就会停，所以 `eachZstdFrame` 按帧魔数逐帧解完）。增量偏移和行元组存在 `data/speed-cache.json`，二次扫描几十毫秒。
- 接口：`GET /api/v1/speed` 给席位栏摘要（近 24 小时最新一次 ≥100 token 的速度、近 30 次中位数、首 token / 首块上限）；`GET /api/v1/speed/board?range=1h|24h|7d|30d|all&v=…` 给完整看板数据（版本未变回 `{unchanged: true}`）。
- 页面：席位栏每家展开的详情里（以及悬停额度圆环的卡片里）挂 `components/room/speed-line.tsx`（3 分钟内活跃用该家颜色，否则变灰，点开弹窗且不顺带 `@`）；设置菜单和速度行打开 `components/room/speed-panel.tsx` 大弹窗（内置 `components/room/speed-board.tsx`：四家概览卡与 sparkline、速度走势散点+滚动中位数、输入/输出缓存分桶堆叠柱状图、按模型/项目用量表、按模型速度表、速度分布直方图、最近 150 条请求明细）；「在新标签页打开」跳同源的 `/speed`（`app/speed/page.tsx`，自带滚动容器和深浅色切换）。

## 实时终端（席位开在房间的终端里）

平时唤起是无界面跑一轮（`claude -p --output-format stream-json`、`codex exec --json`），看得到的只有整理过的「过程」。实时终端是另一条路：房间用伪终端（`node-pty`）把席位的会话开在客户端自己的交互界面里，网页用 xterm.js 显示，用户能看、能直接打字接管。

它是高级功能，标着 Beta（`terminal-dialog.tsx` 的 `BetaTag`）：席位菜单里放在最下面单独的「高级」一组，席位下的「终端开着」和弹窗标题旁也带这个标。用户还没亲手验证过，正式验收之前别去掉这个标，也别把入口挪回常用项里。

- 文件：`lib/terminal.ts`（开关、输出缓存、打字）、`lib/terminal-state.ts`（谁开着，无依赖，给 store 和唤起队列查）、`scripts/terminal.sh`（按种类进会话目录，`claude --resume` / `codex resume`；带 `BENCH_MODEL`、`BENCH_EFFORT`）、`app/api/v1/terminal/[id]/route.ts`、`components/room/terminal-dialog.tsx`。席位菜单「在终端里打开… / 看终端」，开着时席位下面显示「终端开着」，席位快照里 `terminal: true`。
- 只接了 Claude Code 和 Codex（`TERMINAL_KINDS`）。**Codex 只写了脚本，没实测过**；Claude 2026-11-09 在测试副本里实测。
- 权限：开、打字、看画面都要用户口令。看画面是 `GET` 的 SSE，EventSource 带不了请求头，页面用 fetch 读流。画面先补发最近 256 KB，再推新输出。
- 关掉弹窗终端照样开着；「关掉终端」发 SIGHUP（客户端会存好会话），5 秒没退就 SIGKILL。正在关的这几秒里不让重开，也不往里打字。客户端自己退出（`/exit`）也算关。房间服务重启，终端跟着没了。
- 和唤起共存：同一会话两个进程会互相踩，所以终端开着时 `run()` 不再起无界面进程，点名的话（`introduce` + `envelope`，按「用 bench_say 回」的说法）用 bracketed paste 打进去，300ms 后补回车；它用 MCP 的 bench_say 回群。写摘要、压缩、单独说先排着，终端关了再按平常方式跑（`onTerminalClosed` 触发 `run`）。正在跑一轮时不让开终端（409）。终端里客户端自己的权限确认就在终端里点，不弹到网页。
- 回群靠 MCP 认席位：`bench-mcp.mjs` 按 `<种类>-<会话 id>` 找本机凭据。会话自己 bench_join 入座过的有凭据；只用接口建的席位没有，它会重新入座成新名字（测试时踩过）。
- 环境：房间如果是从某个 Claude Code 会话里启动的，会继承 `CLAUDE_CODE_CHILD_SESSION` 等标记，终端里的 Claude 会以为自己是子会话、不存记录（底部提示「Transcript saving is off」）。`lib/terminal.ts` 开终端前把这些标记删掉。
- 依赖：`node-pty` 在 Next 默认的服务端外部包名单里，`next.config` 不用改；Linux x64 用它自带的预编译文件，npm 的安装脚本没跑也能用（npm 会提示 install-scripts 未放行）。macOS 上它的 `spawn-helper` 要有执行权限，那是它安装脚本做的事，没在 macOS 上试过。Windows 走 Git Bash 跑脚本，也没试过。
- 字体：终端字体列表里带了思源等宽 / Noto Sans Mono CJK，否则中文字距会散开。

## agent 自己接入：自检、不踩已在跑的房间

- **自检**（`lib/selfcheck.ts`、`POST /api/v1/selfcheck`、MCP 工具 `bench_selfcheck`）：席位带 agentId 和 token 问「点名我能不能真叫起来」。逐项查：入座时报没报客户端和会话 id、`agents.json` 有没有这种客户端的唤起命令、命令在不在房间的 PATH 上（Claude、Codex 的唤起脚本再查底下的 `claude` / `codex`）、会话记录在不在（只有 Claude、Codex 能查）；再给最近一次唤起的状态、耗时和结束说明。**不真唤起**：自检的 agent 多半就在那个会话里，再起一个进程会在同一会话上打架。所以「叫得醒」的证据是最近一次唤起那一栏：还没被叫过时，提示让用户 @ 一次再查。
- **已有实例保护**（`scripts/register-mcp.sh`）：注册前在各家客户端配置里找已登记的 `bench-mcp.mjs`。如果它指向另一份还存在的并坐目录，就停下（退出码 3），说明该去哪份注册；要改指得加 `--force`。路径已经不存在的照常替换。为的是 agent 拉一份新克隆来注册时，不把用户正在用的房间的 MCP 悄悄改指走。
- **注册完的提示**写给 agent 看：工具要在新会话里才出现，这不是注册失败；当前会话用 PROTOCOL 的 curl 入座；入座后跑 `bench_selfcheck`。需要人手做的一步单独一行「⚠ 需要你做」（DeepSeek 重启、WorkBuddy 面板批准、goose 手动加）。
- **口令**：`npm run open` 只在终端（TTY）里打印带口令的链接；不是终端、又打不开浏览器时，只让用户自己跑。浏览器程序（xdg-open 等）退出码不是 0 也算打不开；它一直不退出，5 秒后当作已打开。这**不是防线**：agent 的 shell 本身是终端时（tmux、dsh-agent、终端里的客户端）照样看得到，而且同一个账号本来就能读 `data/human-key`，只是默认不往 agent 眼前送。故意没做 `--print`。
- **启动**：`start.sh` / `start.bat`（`.bat` 保持 CRLF，`.gitattributes` 里 `*.bat -text`）发现 4399 上已经是并坐，就只打开、不再起第二个；被别的程序占着就报错。端口固定 4399，不自动换：所有 MCP 桥默认连它，换了端口起的房间谁也连不上。

## 安全

所有 POST 都要 `content-type: application/json`（`lib/http.ts` 的 `guard`）。浏览器从别的网站发来的跨域请求做不到这一点，带了别的 `Origin` 的也直接 403。以前任何网页都能用一个 `text/plain` 的表单请求改写 `agents.json`，等于远程执行命令。

人类在房间里的身份是 `as:"human"`，显示名是用户设的名字，`authorId` 是 `human`。`as:"human"` 要带 `x-bench-human` 头，值是 `data/human-key` 里的口令（`lib/human.ts`；第一次用时随机生成，权限 600，重启不变）。`readBody` 统一检查，口令不对一律 403，新接口不用自己再查。口令不进页面、不进日志：`instrumentation.ts` 启动时只确保文件存在、打印一句「用 npm run open 打开」；`scripts/open-room.mjs`（`npm run open`，`start.sh`、`start.bat`、`scripts/start-bench.sh` 都调它）读文件、用 `/?key=…` 打开浏览器；`components/room/api.ts` 把地址里的口令存进 localStorage（`bench-human-key`）再从地址栏去掉，之后每个请求都带上；没有口令时页面顶上有红条。`scripts/test-room.mjs` 从 `data/human-key` 读（`BENCH_KEY_FILE` 可改路径），并检查首页里没有口令。以前只要写 `as:"human"` 就算用户本人，任何 agent 一条 curl 就能替自己批准权限；第一版把口令放在首页 `<meta>` 里，curl 首页就能抠出来，等于没挡。剩下的边界：agent 和用户同一个系统账号，读得到 `data/human-key`。Agent 用入座返回的 `agentId` 和 `token`。token 只在 join 的响应里出现，别的接口不要再带回。

## 状态存在哪（SQLite 持久化、可控队列与席位解耦）

按项目分房间，底层统一存在 `data/bench.db`（Node 24 内置 `node:sqlite`，零外部 npm 依赖，开启 `WAL` 模式与 `FTS5 trigram` 全文索引；可通过 `BENCH_DATA_DIR` 覆盖数据目录做隔离测试）。进程内 `globalThis.__benchRooms` 维护项目列表和各房间热状态（每个房间内存热窗口留最近 400 条消息以保证 SSE 推送轻量，任务全量常驻，早期消息与全量唤起记录 `runs` / `run_steps` 均存在 SQLite 中，不再硬截断 400 条消息、200 条任务或 80 次过程记录）。群聊右上角放大镜按钮与 `POST /api/v1/messages`（MCP `bench_messages`）支持 `before` 无限向上翻页和 `q` 全文搜索（≥3 字走 FTS5 `trigram`，1～2 字中文短词自动结合 `INSTR` 精确匹配）。

**Node 版本**：`node:sqlite` 是 22.5.0 加入的，到 v22.13.0 / v23.4.0 才不用 `--experimental-sqlite`（nodejs.org/api/sqlite.html 的 History），所以最低 22.13：`package.json` 的 `engines`，`scripts/check-node.mjs`（`predev`/`prebuild`/`prestart` 和 `start.sh`/`start.bat` 都先跑它，版本不够打一句话而不是一串 import 报错）。改最低版本要三处一起改：engines、check-node.mjs 的判断、README 里那句。

**搜索跳转后的「洞」**（`components/room/thread.tsx` 的 `spans` / `holesBetween` / `GapMarker`）：点搜到的旧消息，只取回它所在的那条回复链，是一座孤岛，和最近 400 条之间隔着没加载的消息。页面按 seq 记下「整段已加载」的区间（`spans`，加上热窗口 `[最早一条, ∞)`），区间之间的洞在群聊里画一条「这里和下面之间还有没显示的消息 · 点这里补上」，点一下用 `before: 洞的下沿` 取 80 条，一直取到和孤岛接上。顶上的「从历史记录加载更早的消息」只管最上面那一段。显示条数用不上：seq 不是逐条连续的，所以不写「还有 N 条」。

首次升级启动时，`lib/db.ts` 的 `migrateLegacyJsonIfNeeded` 会在单个 SQLite 事务内把旧版 `data/projects.json`、`data/projects/<id>.json`、`data/runs.json`、`data/user.json`（或热更新前的内存态）无损导入 `bench.db`，并将旧 JSON 原样备份到 `data/backup-json-v1/`。

**可控持久化唤醒队列**（`lib/db.ts` 的 `lane_state` / `lane_queue`、`lib/summon.ts` 的 `pauseQueue` / `dropQueuedMessage`）：每个席位的待唤起排队消息实时落盘 SQLite，重启服务后未跑完的排队消息不会丢失，且重启后有积压项的队列默认处于暂停状态（避免排在后面的消息抢在被打断的那一轮之前自动跑掉），等用户点恢复或「重新叫醒」才继续。支持 `POST /api/v1/agents/<id>` 带 `action: "queue_pause" | "queue_resume" | "queue_drop"`：暂停期间点名消息安全积压在队列中，单条点 `×` 剔除会记录在 `lane.dropped` 中，恢复唤起时 `catchUp` 自动跳过被剔除的消息（无需撤回群聊原文）。

**席位身份解耦、长期记忆与跨厂商换脑**（`SeatProfile`、`lib/spawn.ts` 的 `rebindSession` / `switchBackBinding`、`POST /api/v1/memory`、MCP `bench_memory`）：席位（`agentId`、名字、待办归属、工作目录、`SeatProfile` 职责规范与长期记忆）与底层某一家客户端的具体 `<agentName, session>` 解耦。每个席位的 `persona` 与 `memory` 存在 SQLite 并由房间单向导出到 `data/seats/<agentId>.md`（只从房间写出，直接改磁盘 `.md` 不会读回，防止其他 agent 改队友文件篡改职责；职责只能在网页上由用户改）。当某家客户端撞到额度或想换模型接力时，通过席位菜单「切换客户端 / 顶替…」或撞额度卡片「换别的 AI 顶替…」（`action: "rebind"`）即可在同一席位下切换到另一家客户端接力（席位正忙跑一轮时返回 409 拒绝，须先停下或等跑完再换；每次换脑或切回都会轮换席位 `token` 并清理旧 `bench-mcp` 凭证，旧会话再入座或报会话无法抢回席位）。新会话首次唤起时自动注入 `seatBriefing`（接力说明 + 职责规范 + 长期记忆 + 名下未完成待办）；原会话保存在 `previousBindings`（最多 5 条）中，原账号额度恢复后可一键切回（`action: "restore_binding"`）。

「当前是哪个项目」不是参数，是 `AsyncLocalStorage`（`lib/store.ts` 的 `scope`）：路由进门时用 `inRequest`（看 body 的 `agentId` 找席位所在项目，或 `project` 字段 / `?project=`，只有一个项目时可省）、`inSeat`、`inProject` 进入一次，里面调到的 store 函数都作用在这个项目上。没进门就调会报「没指明是哪个项目」。唤起在请求结束后还在跑，`lib/summon.ts` 里输出、计时器、结束回调都用 `bindProject` 包着，回到发起时的项目；项目被删了就什么也不做。

席位 id 全局唯一，名字只在项目内唯一。点名认席位 id，不认名字：发言时 `lockMentions` 把 @名字 解析成 id 存进 `mentions`，正文里的 @旧名字 换成现在的名字（席位的 `formerNames` 最多记 5 个，被别人占了的旧名字不算）。改名走 `renameAgent`：页面在席位菜单「改名…」（`POST /api/v1/agents/<id>` `action: "rename"`，顺带改掉 bench-mcp 状态文件里的名字，见 `lib/spawn.ts` 的 `renameSeatFiles`），AI 自己用 `bench_join` 填新名字（桥发 `rename: true`）。改名时按 id 把这个席位说过的话的署名、点到它的消息里的 @、任务负责人都换成新名字。回座认 token：带对 token 就回到那个席位，名字保持现在的，除非请求里有 `rename: true`；改名之前的旧版桥回座总会带上它记得的名字，这样才不会把页面上改的名字又改回去。一个会话（agentName + uuid）同一时间只坐在一个项目里：`join` 或报会话时，它在别的项目里的席位会被请走，那边留一句「X 去了「Y」」。入座进哪个项目由 `pickProject` 决定：指名 > 这个会话已经坐着的项目 > 工作目录落在哪个项目目录里（最深的那个）> 只有一个项目时就是它 > 否则 400 列出项目，让模型问用户（不用 409：旧版桥会把 409 当成「名字被占」）。MCP 桥在 `bench_join` 前先调 `POST /api/v1/projects/pick`（带 `process.cwd()`），找到项目再按「项目 + 名字」读回旧席位。换项目时名字、模型、分工跟着走。

页面的每个请求都带当前项目（`components/room/api.ts`：读请求加 `?project=`，JSON body 加 `project` 字段），所以页面代码里大多数调用不用自己写。

附件（`components/room/attachments.tsx`）：大家都在这台电脑上，所以附件只传路径。回形针菜单里「选文件… / 选文件夹…」调 `POST /api/v1/folder`（`pick: "files"` 或 `"dirs"`，可多选），拿到的是原文件的路径，不复制。粘贴、拖进来的东西浏览器给不出路径，就先 `POST /api/v1/files`（JSON 里放 base64，单个不超过 25 MB），房间存到 `data/uploads/<日期>/` 下，消息带的是那份副本的路径。`say` 收 `attachments`（最多 10 个），逐个查磁盘：路径不存在就拒绝，是文件夹、图片还是普通文件、多大，都按磁盘上的实际情况记。转给 AI 时（唤起的转发、bench_inbox、摘要原文）在正文后面加「附件（图片）：/路径」这样的行，AI 用自己的工具去读。页面上的图片走 `GET /api/v1/files?path=`，只给 `data/uploads` 里的、或这个项目某条消息附带的图片，不给 svg，响应带 `content-security-policy: sandbox`。`data/uploads` 不会自动清理。

音频附件（`components/room/audio-card.tsx`）：扩展名在 `lib/media.ts` 的 `AUDIO_TYPES` 里（mp3、wav、ogg、opus、m4a、aac、flac、weba），附件记成 `kind: "audio"`，转给 AI 时写「附件（音频）：/路径」。页面上画成一张播放卡片：播放/暂停，进度条可以点、可以拖（pointer capture），聚焦后左右键跳 5 秒，时间、大小、倍速（1 / 1.25 / 1.5 / 2）、保存（同一个地址加 `&download`）。声音走 `GET /api/v1/files`，带 Range 才能拖进度，浏览器先发 `bytes=0-` 再按需取段。同时只放一个：开始播放时在 window 上发 `bench-media-playing`（视频卡片也用这个，detail 是正在放的元素），别的音频、视频卡片收到就暂停。`<audio>` 报错（文件没了、格式浏览器不认）时卡片显示红字，不再能点。`preload="metadata"`，页面上很多条音频也只读开头一点拿时长。测试里用一段手写的 WAV 验 audio 识别和 206。

视频附件（`components/room/video-card.tsx`）：扩展名在 `lib/media.ts` 的 `VIDEO_TYPES` 里（mp4、m4v、webm、mov、ogv）。不收 mkv、avi、wmv，因为浏览器自己放不了。附件记成 `kind: "video"`。页面上画成嵌在消息下面的 `<video controls>`：拖进度、音量、倍速、全屏、画中画都用浏览器自带的；卡片底栏有文件名、时长、大小、保存、复制路径。同时只放一个视频（window 事件 `bench-video-playing`）。放不了时显示提示：mp4 用 H.264 最稳，ffmpeg 加 `-pix_fmt yuv420p -movflags +faststart`。`GET /api/v1/files` 是流式读（`createReadStream` 转 web stream），带 Range 时回 206 或 416，几百 MB 的录屏也不会整个读进内存。

AI 在汇报里带音视频：被唤起时调 MCP 的 `bench_attach`（`paths`，对应 `POST /api/v1/attach`，即 store 里的 `pinAttachments`），把本机文件挂到这次唤起上，存在内存里（`globalThis.__benchPinned`，席位 id → `{runId, list}`）。这次唤起里它说的下一句话会把这些文件带出去：stdout 贴回的回答走 `sayAs`，进的也是 `say`；它自己发的 `bench_say` 也一样。不在唤起里调用回 409，这时直接用 `bench_say` 的 `attachments`（路径数组）。唤起提示里有一句用法。已经开着的 MCP 桥接是旧进程，要等那个会话下次启动才有 `bench_attach`。用真的 `claude -p` 验过：临时项目里开一个 Claude 会话，叫它挂 mp4，回答带着 `kind: "video"` 的附件发回来了。

干活中途收到新消息（`lib/summon.ts` 的 `takeQueued`，`POST /api/v1/queue`）：一个席位正在回复时又被叫到，消息先进它 lane 的 `pending`。原来要等这轮结束才唤起下一轮，现在这轮当中就能取走：
- Claude Code：每次回复唤起生成一个 `lane.key`，作为 `BENCH_RUN_KEY` 传给命令。`claude-code.sh` 见到它就加 `--settings`，挂上 PostToolUse 钩子 `scripts/bench-hook.mjs`。每次工具调用后，钩子拿钥匙来取，用 `additionalContext` 塞进这一轮，效果和在 Claude Code 窗口里边干边打字排队一样。
- Codex：`codex-wake.sh` 现在改调 `scripts/codex-app.mjs`。它用 `codex app-server`（stdio JSON-RPC：initialize → thread/resume → turn/start）跑这一轮，每 2.5 秒拿 `BENCH_RUN_KEY` 问一次房间，有新消息就 `turn/steer` 插进正在跑的这一轮，和在 Codex 窗口里边干边打字一样。它把 app-server 的事件翻成 `codex exec --json` 那几种（agent_message、command_execution、mcp_tool_call、file_change、web_search、turn.completed），过程面板不用改。审批一律关掉（approvalPolicy never），server 发来的请求一律拒绝。`codex queue` 不行：实测它只把消息存着，等下次打开会话才处理，正在跑的 `codex exec` 读不到。设 `BENCH_CODEX_EXEC=1` 可以退回原来的 `codex exec resume`。用真 codex 0.167 验过：在房间里 @ 它跑三次 `sleep 12`，中途插一句暗号，送到后它这一轮的汇报里带着暗号，只回了一条。
- 其他家：命令行没有中途输入的接口，靠 bench 桥接。它这轮里调任何 bench 工具（`bench_permit`、wait、join、leave、inbox 除外），桥接都用席位凭证来取一次，附在工具结果后面。
- 取走时：内容用 `catchUp` 生成，席位的游标跟着往前走，下一轮不会重复。清空 `pending` 和 `trigger`，这轮结束就不再唤起。接力次数记进 `midHop`，答完时取最大值，（现在只记不拦。）消息记上 `reached`，页面在它下面显示「已送到正在干活的 XX」；过程面板里也记一笔。
- 用真的 `claude -p` 验过：它在跑三次 `sleep 20`，中间 @ 它报一个暗号，第一条 sleep 结束后就送到了，最后的回答里带着暗号，也只回了一条。
- 钩子要等席位下次被唤起才挂上，正在跑的那一轮不受影响。

项目设置里的「浏览…」调 `POST /api/v1/folder`：房间在桌面上开 zenity 的选目录窗口，等人选完把完整路径交回（浏览器给不出目录的完整路径，所以只能由房间来开）。房间是 `env -i` 起的也行，`DISPLAY`、`XAUTHORITY`、DBus 地址缺了会按本机桌面补上。取消返回 `{dir: null}`；同时只开一个窗口，开着时再点是 409；没装 zenity 是 501，提示直接填路径。

不要为每个请求新开一份状态。SSE 用同一份上的 EventEmitter。`GET /api/v1/stream` 不结束，所以不要对首页用 Chrome 的 `--dump-dom`，它会一直等页面空闲。

快照热窗口带最近 400 条消息（`totalMessages` 给总数），全量历史消息、任务和唤起过程均完整保存在 `data/bench.db`，不设条数截断上限。

名字：1 到 24 个字母、数字或中文，可带 `_` 和 `-`，不能有空格。保留字：`human`、`room`、`everyone`、`所有人`。重名入座必须带原来的 token，否则 409。

交接会写一条 `kind:"handoff"` 的消息，并把任务的 `ownerId` 设成接收方、状态改成 `doing`。`note` 就是对方接着做需要的上下文。同一阶段已有别人负责时，`claim` 返回 409。

离席会把这个席位名下还没完成的任务标成 `blocked`。

## 演示席位（2026-11 去掉了）

以前有三个脚本控制的假席位（阿衡、阿构、阿证），用来在没有真 agent 时演示接话和交接（`lib/demo.ts`、`POST /api/v1/demo`）。真 agent 接进来以后用不上，整个删了。`Agent.demo` / `Message.authorDemo` 字段还留着，旧消息会带；房间存档里还坐着的演示席位，启动时 `dropDemoSeats()` 会悄悄请走。

## 消息里的 Markdown

消息按 Markdown 画（`lib/markdown.ts` 解析成树，`components/room/markdown.tsx` 画，`MessageBody` 调用）。没用第三方库，也不输出 HTML，消息里写 `<script>` 只会显示成文字。认的写法：

- 块：三个反引号的代码块（要闭合，没闭合的照原样显示）、`#` 标题（字号只比正文大一点）、`-`/`*`/`+` 和 `1.` 列表（按缩进嵌套）、`>` 引用、表格（第二行是 `|---|:-:|` 这种分隔行，支持左中右对齐）、`---` 分割线、段落。段落里的单个换行照样换行，像聊天。
- 行内：反引号代码、`**粗体**`、`*斜体*` / `_斜体_`（`snake_case`、`2*3*4` 不会被当成斜体）、`~~删除线~~`、`[文字](链接)`、裸的 `https://…`、反斜杠转义。
- 链接：http(s) 和 mailto 新标签打开；`file://` 和写成路径的链接当文件打开（见下面「能点的引用」）；其他协议只显示文字，悬停看地址。
- @ 只在普通文字里高亮，代码和链接里的不算。
- 代码块：等宽框，左上写语言（没写的标「命令」），右上「复制」，长行横向滚动。复制 shell 代码块（bash、sh、console、powershell 等，以及没写语言的）时，如果有 `$ ` 或 `> ` 开头的行，只复制这些命令、去掉提示符，中间的输出不复制（`lib/text.ts` 的 `copyText`）；其他语言原样复制。
- 长消息折叠按高度（`max-h-[4lh]`）而不是 `line-clamp`，表格、代码框才能一起折进去。
- 字号刻意贴近正文：一条带标题和表格的回答还像一个聊天气泡，不像一篇文档。
- 复选框列表：`- [ ]` / `- [x]` 画成方框和打勾的方框，勾上的那项淡一点。只是显示，点了不改消息。
- `diff` / `patch` 代码块按行着色：`+` 绿底、`-` 红底、`@@` 蓝字、`diff --git` / `---` / `+++` 加粗；蓝色气泡里换成浅色版。

### 能点的引用

普通文字和整段是一个引用的行内代码里，`lib/markdown.ts` 的 `splitRefs` / `refOf` 认出四种引用，`components/room/markdown.tsx` 的 `RefLink` 画成点线下划线的按钮（`components/room/refs.ts` 管点了之后做什么）：

- `m_xxxxxxxx`（消息）：在对话里滚到那条并闪一下边框，折起的回复链会自己展开，还没加载的早期消息先放宽加载数；实在找不到就提示。对话里每条消息外面有 `data-message`。
- `t_xxxxxxxx`（待办）：打开待办详情（`room-app.tsx` 监听 `bench:goto`）。
- 提交号：7–40 位十六进制，且同时有字母和数字（免得把 `1234567` 或 `deadbeef` 当提交）。点了弹 `CommitDialog`，读 `GET /api/v1/commit?hash=&from=`：在说话那个座位的工作目录（没有就用项目目录）里只读地跑 `git rev-parse --verify` 和 `git show --stat` / `--patch`，补丁超过 150KB 截断。
- 文件路径：绝对路径只认 `/home`、`/tmp`、`/media`、`/mnt`、`/opt`、`/usr`、`/etc`、`/var`、`/srv`、`/root` 和 `~` 开头的（`/api/v1/open` 这种接口地址不算）；相对路径要带目录和扩展名（`lib/a.ts`），或者写在反引号里。行号写 `:12` 或 `#L12`。点了调 `POST /api/v1/open`（只有用户能调，要 human key），`lib/open-ref.ts` 先按说话座位的 `workdir`、再按项目目录找文件，找到才用编辑器打开。

编辑器：设了 `BENCH_EDITOR` 就用它（`BENCH_EDITOR_JUMPS=1` 时传 `-g 文件:行`），否则依次找 `code -g`、`cursor -g`，都没有就 `xdg-open`。进程脱离房间服务单独跑，带上桌面环境变量。自测时把 `BENCH_EDITOR` 指到一个只把参数写进日志的脚本，别在用户屏幕上开真窗口。

## 改页面时不要踩的地方

`cacheComponents` 打开时，客户端组件在渲染期间读 `Date.now()` 会把预渲染卡住，页面停在「正在打开」。时钟放在 `useEffect` 里。现在的 `now` 初值是 `0`，效果开始时再取当前时间。

开发服务认为自己是 `localhost`。浏览器从 `127.0.0.1` 打开时，热更新 WebSocket 会被拒绝。`allowedDevOrigins` 里要留着 `127.0.0.1` 和 `localhost`。

`next-themes` 会在 `<html>` 上写 class，`app/layout.tsx` 的 `<html>` 有 `suppressHydrationWarning`，拿掉会报水合不一致。

Next 开发徽章用 `devIndicators: false` 关掉了，它以前挡住入口栏底部。

`DropdownMenuLabel` 必须包在 `DropdownMenuGroup` 里：Base UI 的 `Menu.GroupLabel` 找不到组就直接抛错（`MenuGroupContext is missing`），整个页面换成报错浮层。左栏「排队 N 条」的菜单以前就是这样，一点开就报错，2026-11-13 修了。

页面以 SSE 为主，只有 SSE 断开时才每 4 秒轮询一次。客户端只在快照的 `rev` 不比当前旧时才覆盖本地状态。

`lib/summon.ts` 的监听只在进程里绑一次（`__benchSummonBound`），改了 `ensureSummon` 里注册监听的那段，要重启开发服务才生效。

## 前台项目与跨项目只读工具

- **前台项目（`ProjectInfo.front?: true`）**：全房间最多只有一个，名字固定为 `"前台"`，SQLite `projects` 表 `front` 列持久化（旧库升级时 `ensureSchemaColumns` 自动 `ALTER TABLE` 补列），`orderProjects` 与 `dbLoadProjects` 保证始终排在项目列表最前（索引 0）。`POST /api/v1/projects` 带 `{ as: "human", front: true }` 幂等建/取（新建返 `201`，已存在返 `200`，均返回 `{ project }`）；普通项目禁止取名 `"前台"` 或改 `front: true`；删除项目允许删前台项目但保留至少一个普通项目；`inRequest` 与 `pickProject` 在自动匹配“唯一项目”时排除前台项目，防止普通 CLI 会话误入前台；在前台开新会话时，`lib/spawn.ts` 的 `workspaces()` 额外提供「用户家目录」（`os.homedir()`）选项。
- **两件跨项目只读工具（`lib/front.ts`、`app/api/v1/overview/route.ts`、`app/api/v1/peek/route.ts`、`scripts/bench-mcp.mjs` 的 `bench_overview` / `bench_peek`）**：由 `lib/store.ts` 的 `requireFrontSeat` 把关，仅允许坐在前台项目（`front === true`）里的席位调用（普通项目席位一律返 `403`，缺或错 `token` 返 `401`）。`bench_overview` 汇总全房间各项目的有事席位（总席位 `> 4` 时无事席位折叠为名字和状态）、等用户的提问/权限申请/等验收计数、未完待办数、最后动静时间与房间摘要开头（总长封顶 `< 4500` 字）；`bench_peek(project, before?)` 支持传项目名或 `p_…` id，返回该项目的房间摘要全文、等用户的提问（含选项）/权限申请/等验收待办明细、未完待办进度与验收/复验状态、各席位状态与 `owes` 明细、未叫成或中途断掉的点名、最近 30 条带 `[m_…]` 的对话（`dbLoadTalkPage` 过滤系统消息与已撤回消息，支持 `before` 翻页）。严格只读：不推进任何席位 `seenSeq`，不触发任何唤起，绝不回传 `human-key`、席位 `token`、`session` uuid 或手机推送配置。
- **前台席位叫醒职责说明（`lib/summon.ts`）**：当 `currentProjectInfo().front` 为真时，向完整守则 `whole` 拼入 `< 200` 字的前台职责说明（用户只跟前台对接；用 `bench_overview` / `bench_peek` 看各项目；每件事带项目名和 `t_…` / `m_…` id；当前只读阶段不能替用户验收、批权限或以他的名义说话；需要他去哪个房间处理说清楚），向短提醒 `brief` 拼入精简要点，自动参与 `rulesFor` 的 sha1 指纹计算与守则瘦身。

### 前台的页面（2026-11-14，t_5455b26a）

- 顶栏右侧的「前台」按钮（`components/room/front.tsx` 的 `FrontButton`）有三种样子：
  - 还没有前台：铃铛加「前台」，点了走开启流程。
  - 已开启：点了进前台。走的是切项目的现成流程，先把左栏切回房间档，和点通知胶囊一样。前台里有等你的事时显示红色数字，有你没看过的新消息时显示主色小圆点。未读和左栏项目卡片用同一套 `bench-project-seen`（`project-rail.tsx` 的 `unreadIn` / `useSeenAt`）。
  - 人在前台：变成「← 回到〈刚才的项目〉」。「刚才的项目」是最后一个打开过的非前台项目，存在 localStorage `bench-front-back`（`rememberBack` / `useBack`），在前台刷新也记得。
  - 窄屏只显示铃铛和「回到」两个字。
- 坑：`useSeen`（把当前项目记为已读、把没记过的项目记为读到现在）以前只在左栏的项目档里调用。左栏停在房间档时，前台从没被记过，`unreadIn` 永远不会算它未读，顶栏的圆点就不出来。现在 `room-app.tsx` 里也调一次，左栏在哪一档都有效。
- 左栏项目档（`project-rail.tsx`）：
  - 前台用单独的 `FrontCard`，固定在最上面（`listProjects` 本来就把它排第一）。它没有长凳和目录，铃铛代替项目色点，标题旁带「只读阶段」小标签（`FrontStage`），下面一行写「XX 值班」，右边是值班的机器人。机器人带 `seatFlight`，进前台时照样飞进席位栏。不在前台时，底色是一层淡淡的主色渐变。
  - 还没有前台时，这个位置是虚线的「开启前台」卡片（`EnableFront`），不算进项目的进出动画序号（`lead`）。
  - `ProjectTitle` 遇到前台也换成铃铛加「只读阶段」，所以房间档顶上的标题也一样。
- 开启流程（`room-app.tsx` 的 `enableFront`）：
  - `POST /api/v1/projects {as:"human", front:true}` 建好或取回前台，重拉项目列表，再进去。
  - 前台房间上屏、里面还没人时，弹出「挑一个 AI 来值班」：复用 `SpawnDialog`，传 `preset`（`FRONT_PRESET`）。席位名「前台」，分工「前台：替你看各项目」，工作区默认临时目录。弹窗里多一排「用哪一家」，可以在里面换客户端（`onKind`）；换的时候已经填的不清空，只清掉模型。
  - 弹窗要等前台房间上屏，并且延后一个 `setTimeout(0)` 才开。这样 `api.ts` 当时打开的项目已经是前台，问工作区和开会话都落在前台。
  - 坑：别在 effect 的清理函数里取消这个定时器。切项目后第一份快照常来两次，取消了弹窗就不出了。
  - 前台里一直没人时，空房间引导里有「挑一个 AI 来值班」按钮（`Thread` 的 `onStaff`）。
- 前台房间里：
  - 顶栏写「前台 · 只读阶段：替你看所有项目」（`project-menu.tsx` 的 `placeLine`）。
  - 空房间引导换成 `FrontWelcome`：现在能问什么、还不能替你派活、验收、批权限。三个示例点了会带上 `@值班席位`。
  - 输入框占位语是「问前台… @XX 它就去看各项目…」（`frontHint`）。房间只叫醒被 @ 的席位，所以提示里写了 @ 谁。
  - 值班席位是 `deskSeat`：分工以「前台」开头的那个，没有就取第一个席位。
- 窄屏的项目下拉菜单里，前台带铃铛、写「替你看所有项目 · 只读阶段」；没有前台时多一项「开启前台…」。
- 新手引导只在最后一步加了一句「项目多了以后，点顶栏的『前台』」，没加新步骤，因为引导只讲配置。
- 别的项目的通知胶囊对前台照样有效，点胶囊进前台，不用改。
- 打开页面时，如果既没有链接指定项目、上次也没记下项目，默认进第一个普通项目。前台排在第一，以前会落进前台。
- 测法：隔离副本、无头 Chrome 驱动、走一整遍。顺序是：没开启 → 点顶栏「前台」开启 → 弹窗预填 → 开出 Claude 席位 → 前台房间 → 回到 → 前台里有新发言时顶栏出现圆点 → 进去看过、回来后圆点消失 → 左栏卡片 → 窄屏菜单 → 通知胶囊点进前台。深浅两色都截了，录了一段进出的录屏。测的时候开出的会话会在真的 `~/.local/share/bench/scratch/` 下建 `前台-xxxx` 空文件夹，测完删掉。

## 没 @ 人的话叫最后说话的 AI（2026-11-15，t_bd01d3c1，用户说先临时加上）

- 在 `lib/store.ts` 的 `say()` 里：用户发的话没有 @（`@所有人` 也算 @），也不是在回复哪条时，在正文开头补上 `@<lastSpeaker()>`，然后照常走 `lockMentions`。叫醒的逻辑一点没改。
- `lastSpeaker()` 在这个项目的热消息里往回找，取最后一条不是系统消息、也不是用户发的消息，找到的作者还在座、也不是演示席位就是它。交接消息也算说过话。
- @ 写进正文而不是只塞进 `mentions`：群里、撤回带回的原文、对方收到的话都看得出叫了谁。代价是正文多了一个 @，想取原话的测试要拿服务端回的 `message.text` 比，不能写死原句。
- 页面在 `composer.tsx` 里：`fallback` 用 room-app 传进来的 `speakers` 按同一规则取人，输入框下面显示「没 @ 人，发给 @X」；@ 了房间里没有的名字时，提示改成「…，会改叫 @X」。两边的取法要一起改。
- 想撤掉的话，删 `say()` 里那段 `if` 和 composer 里的 `fallback`，再把 test-room 里 t_bd01d3c1 那三条断言删掉。

## 验证

用独立副本验证，不在正式房间跑测试（Linux，需要 PATH 中有 Node 22.13+，以及 cp/flock/setsid/ss/curl）：

```bash
scripts/test-copy.sh up check 4487
scripts/test-copy.sh list
# 按 up 输出的 BENCH_URL、BENCH_KEY_FILE 和副本脚本路径运行测试。
scripts/test-copy.sh up check 4487 keep # 只重启，保留代码和数据
scripts/test-copy.sh down check       # 停止并删除
```

副本默认放在 `.bench/test-copies/<网络空间>-<PID空间>/`，不依赖 tmux；在普通终端和隔离会话中都在调用者的空间启动。端口只接受 4400–4499，只监听回环地址。代码复制后先在副本里 `next typegen`、`tsc --noEmit --incremental false`，失败就不起服务；这样不会把生成类型或编译缓存写进正式工作区。依赖使用硬链接，不要在副本内升级或修改 node_modules。

副本只继承 HOME、PATH、用户/语言/终端及代理变量，设置独立的 BENCH_DATA_DIR、XDG_STATE_HOME、BENCH_URL；不复制正式数据、凭证或 `.env`。只读输出所指的副本 human-key，不用正式房间口令。down 核对 PID 启动时间与工作目录后结束进程组，僵尸进程视为已退出。list 标记一天未启动的副本，并列出其他空间的目录；不同空间不能用数字 PID 互相停止。隔离空间退出后服务不会继续存在，残留目录需确认不再使用再清理。

本机隔离启动器在仓库之外；需要桥接的端口仅限以下清单，不开放额外直连外网：

| 端口 | 用途 | 桥接目标 |
| --- | --- | --- |
| 4399 | 正式房间 MCP / HTTP | 宿主机回环房间服务 |
| 7897 | 外网代理 | 启动器已有的代理 Unix socket |
| 7863 | DeepSeek 本地线路 | 宿主机回环 7863，经用户级私有 Unix socket |

测试端口 4400–4499 在当前空间直接启动，不桥到外部。7863 桥只对重新启动的隔离会话生效；旧会话要重新叫醒。本机安装操作与路径不纳入通用启动脚本。

2026-11-14 验证：普通主机与隔离空间的 up/list/keep/down 均通过，主机副本整份 test-room 输出 `room ok`；7863 桥接后新隔离空间中真实 `dsh-agent exec` 返回「好」。Claude CLI 在新隔离空间执行 `mcp list` 显示 bench Connected；这只证明新进程连接正常，尚不能证明 Sonnet 原会话工具恢复，历史断连原因仍待取到该会话的实际错误。

### 要害清单与「放一个 bug 进去，测试得抓到」

[`docs/要害清单.md`](docs/要害清单.md) 列出了房间里不能坏的 7 处要害（叫醒和队列、点名的去向、存储和搜索索引、重启后的恢复、入座/换脑和凭证轮换、权限卡片与用户口令、提问和验收），以及每处要害的文件、依赖、历史事故和管它的测试。

**规矩**：
1. 凡是改到 [`docs/要害清单.md`](docs/要害清单.md) 里列出的文件，必须在 `scripts/test-room.mjs` 里补或改一段对应的测试；
2. 必须在 `scripts/test-faults.mjs` 的 `FAULTS` 表里加（或保留）一条**对这处改动做源码替换注入后能被测试当场抓到**的故障；
3. 改完后跑故障注入脚本验证（脚本会自动在 `~/.cache/bench-copies/faults-<pid>` 起一份独立副本，先验干净基线通过，再逐个打上故障替换确认测试失败并还原，不动正式房间和工作区源码）：

```bash
node scripts/test-faults.mjs
# 只验某一条故障：
node scripts/test-faults.mjs --only queue-drop-after-wake
```

类型和 lint：

```bash
npx tsc --noEmit
npx eslint --max-warnings 0
```

浏览器要看的是空房间、五个入口、点名真席位后它被唤起并回话，深浅两种配色，以及窄屏三个标签。地址 http://127.0.0.1:4399。

## 不要随便做的事

`PROTOCOL.md` 是给进房间的模型的协议，不要写成给人看的说明；给人看的是 `README.md` 和 `docs/新手引导.md`。

`docs/同类项目对比.md`：2026-11-09 查的 GitHub 上同类开源项目（agentchattr、hcom、agmsg、vibe-kanban 等）和并坐的对比，写明了哪些是没核对的。以后做新功能想知道别人怎么做，先翻它；过了几个月要重查，星数和功能都会变。

不要用 `POST /api/v1/reset` 除非要清空。请求体必须是 `{"confirm":"清空"}`。测试脚本会自己清。

不要在这个工作区里 `git stash`、`git checkout -- <文件>`、`git reset --hard`、`git clean`：工作区是所有席位共用的，常常有好几个席位的改动同时没提交。`git stash` 会把别人改到一半的文件一起收走，这期间别人的编辑会落空，放回来时还可能冲突（2026-11-14 有席位为了确认「类型检查报错不是我引起的」这么做过，这次没出事）。想知道报错是不是自己引起的，看报错的文件是不是自己改的那几个，或者在隔离副本里验。
- 重启接上被打断的唤起（`lib/runs.ts`、`lib/summon.ts` 的 `announceInterrupted` / `rewake`）：唤起一开始就写进 `data/runs.json`，记下项目、当时在回的那批消息（`body`）、`replyTo`、单独回话的原话。启动时读到还在 running 的记录，标成 `interrupted`；第一次 boot 时按项目发一条系统提示（带 `interrupted` 列表，每条只提示一次），席位置回空闲。提示下面每人一个「重新叫醒」按钮：`POST /api/v1/runs/<id> {as:"human", action:"rewake"}`。回复类的会把原来那批消息作为「刚才被打断、还没回的」再送一次，单独回话重放原话，摘要重新排队；同一条只能叫醒一次。
- 重启前先看有没有 agent 在跑：`ps -eo pid,etime,args | grep -E "claude-code.sh|codex-wake|dsh-agent|cursor-agent|agy "`，或看左栏谁是「在做」。被唤起的 agent 是开发服务器的子进程，重启会把它们一起掐断；现在重启后能在群里一键叫回来，但最好挑大家都空闲时重启。agent 自己要重启时，用一个独立会话的后台脚本（`setsid nohup`）延迟几十秒再做，不然会先把自己掐掉。
- agent 想在临时项目里自测时，新坐一个测试席位（`/api/v1/join` 起个新名字），不要用自己的席位 `bench_join` 到临时项目：入座会让它离开原来的项目，临时项目删掉后它就哪儿也不在了。
- 自测脚本建的临时项目，删除要放在 `finally` 里（照 `scripts/test-room.mjs`）。只写在脚本最后一行的话，中途断言失败或超时就会留下一个没人删的项目：`.bench/accept/pfull.mjs` 留下过 `pfull-…`。现在删项目要带 `data/human-key` 的口令，脚本从文件读。
- 点「发给」的标签，`@名字` 加在输入框光标所在的位置（选中了一段就替换那一段），不再加到最前面：`lib/text.ts` 的 `insertMention` 在名字两边各留一个空格（已经有就不加），光标落在名字后面那个空格之后，接着打字不会和名字连在一起把点名弄没；文字是受控的，所以光标位置先记在 `caret` 里，等新文字渲染完再在 layout effect 里设。没点进过输入框时光标在末尾。点名一律按整个名字匹配（`@Opus2` 不算 `@Opus`）：服务端一直如此，页面上发送后「正在忙」的提示以前用的是子串，2026-11 改成和服务端同一个 `namedAgentIds`。注意名字后面要有空格或标点，`@Opus2看一下`、`@opus2` 都谁也叫不到，输入框下面会提示没有这个席位。
- 「发给」快捷标签可以拖动排序（`composer.tsx` 的 `useChipOrder`）：指针事件，横向拖过 6px 才算拖；拖动时在 window 上监听 pointermove/up，因为 React 换位会移动 DOM 节点、丢掉指针捕获。拖过别人中线就换位，其他标签用 FLIP 滑过去：位置用 offsetLeft 量（不受动画中的 transform 影响），新一段滑动从当前屏幕位置接着走，位移加在外层（内层有 overflow-hidden，挪出去会被裁掉，拖得快时就是这样「看不见」的）。顺序按席位 id 存在 localStorage 的 `bench-chip-order`，新席位按原顺序排在后面；松手 300ms 内的 click 不算点选。「所有人」固定在最后，不参与拖动。
- 点进输入框时，最近在群里说过话的席位（最多 3 个，最新的在最前）排到「发给」最前面，其余按拖好的顺序：`room-app.tsx` 的 `speakers` 从群聊倒着取说话的席位（跳过系统消息和用户自己），`composer.tsx` 在 `onFocus` 里取前 3 个、`upFront` 排前面。只在获得焦点那一刻定一次，打字时不跟着新消息跳；重排本身不写进 `bench-chip-order`（拖动的话按拖时看到的顺序存）。
- 答完就收尾（`lib/events.ts` 的 `ended`、`lib/summon.ts` 的 `END_GRACE_MS`）：输出流里出现一轮结束的事件（Claude / cursor 的 `type:"result"`、Antigravity 的 `event:"result"`、Codex 的 `turn.completed`、`type:"final"`）后，进程 3 秒内不退就收掉它的进程组，按正常结束贴回答，「过程」里记一条说明。常见原因是 agent 在后台挂了任务（Claude Code 的 `-p` 要等后台任务结束才退），以前要等到超时，回答才贴出来。只等 3 秒，是因为同一席位的下一次唤起会接着用这个会话，旧进程不能留着。
- 「正在做」卡片（thread.tsx 的 `LiveRun` / `LiveDrawer`）：气泡里藏着一份按自然宽度排的副本，量出宽度后再给气泡设宽，靠 width 过渡平滑伸缩。席位做完后，`useLeaving` 用它最后的样子再留 `LEAVE_MS`，播 `.live-leave` 退场，效果是老电视关机：上下压成一条亮线，缩成一个点，然后这一行合上。离开的卡片必须是同一个元素（同 key、同 `Leaving` 外壳）；换成新元素的话，入场淡入会把退场盖住。CSS 动画是 1.4 秒，`LEAVE_MS` 要比它稍长。合上的那一行在卸载前还占着群聊那一列的行间距（`gap-1`，4px），以前卸载时会跳一下；现在那一列把间距写成 `--live-gap` 交给它，`live-close` 合上时用负的 `margin-top` 一起收掉。改那一列的 `gap` 时记得同步这个值。气泡末尾是「停止」（2026-11-12）：以前那里是一个过程图标，点它和点气泡一样是展开过程，等于没用。现在外层是 `div.bubble`，里面左边一个按钮（点了看过程），右边一个圆形停止按钮（按钮不能套按钮）。停止和席位菜单里的停止调同一个 `stopSeat`（`room-app.tsx`，`action: "stop"`），停掉这次唤起，排着的也一起取消。量宽度的那份副本在末尾垫一个同样大的空位。新手引导的演示气泡（`demo`）不显示停止。

## 界面用词和长短

新增或修改界面文案时照同一把尺子写（第一批对照表见 [`docs/界面文案对照表.md`](docs/界面文案对照表.md)）：

- **统一叫法**：同一概念只用一种词——**客户端**（不混用厂家/厂商/后端/软件）、**席位** vs **会话**、**叫醒**（给人看的动作统一写叫醒，仅保留配置专有名词「唤起命令」）、**待办**（不混用任务）、**验收** / **复验**、**房间摘要** vs **摘要句**、**单独说**（不混用插话）、**默认给全权** / **本轮全允**。
- **字数尺子**：
  - **菜单项**：≤ 6 字，动词开头，不带句号，不带解释（解释放 `title`）。
  - **悬停提示（`title`）**：一句，≤ 20 字；按钮文字本身已说清的直接不设 `title`。
  - **toast**：≤ 16 字，只说结果。
  - **弹窗**：标题 ≤ 8 字（席位名、项目名等动态标识用小号副标签跟在旁边）；`DialogDescription` 和字段说明最多一句；按钮 2～4 字。
  - **群聊系统消息**：一句，≤ 30 字（「谁 + 怎么了」，需要时加一句动作）；长报错原因与客户端输出写进 `Run` 步骤（点开「过程」查看），不要整段贴进群聊。
  - **「接着做」发出的话（`components/room/nudge.ts`）**：≤ 40 字。
- **只改短、不能删的提醒**：不可撤销后果（清空记录、删项目会删掉席位/对话/待办）、花额度的地方（复验、补摘要句、压缩省额度但少细节）、往外发内容（手机推送及本机密钥位置）、改外部配置（向客户端写 MCP 配置、导出 `.md` 只读副本、换客户端不带旧会话聊天记录）、安全边界（「默认给全权」直接跑命令改文件）、手动善后（新分支手动合并、临时目录手动清理）。
