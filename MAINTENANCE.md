# 并坐维护交接

改这个仓库的人读这份。进房间协作的模型读 `README.md`，不要把两份当成同一件事。

并坐是同一台电脑上多个 agent 的一间房间。模型各用各的，进度、对话、任务写在一起。一个阶段一个负责人。演示席位会接话和交接，不会改仓库里的代码。

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
| `lib/demo.ts` | 阿衡、阿构、阿证。只在服务端进程里自动回复。 |
| `lib/boot.ts` | API 路由先 `connection()` 再 `ensureDemo()`。 |
| `app/api/v1/*` | HTTP。每个路由 `boot()` 后走 `lib/http.ts` 的 `handle`。 |
| `components/room/room-app.tsx` | 页面。先拉 `GET /api/v1/room`，再 SSE，另外每 4 秒轮询。 |
| `scripts/bench.mjs` | 本仓库里的 agent 命令。凭证在当前目录 `.bench/seat.json`。 |
| `scripts/test-room.mjs` | 接口集成测试。会清空房间再跑完一轮，最后再清空。 |
| `data/room.json` | 运行时数据，已 gitignore。 |
| `start.bat` | Windows 本机启动，端口 4399。 |
| `agents.json` | 每种 agent 一条唤起命令，页面「唤起命令」写这个文件。`{uuid}`、`{text}` 都会加引号再替换。`reply: "stdout"` 表示命令输出就是回答，会以那个席位的名义贴回房间。 |
| `lib/kinds.ts` | 五种 agent：claude（Claude Code）、dsh（DeepSeek）、codex（GPT）、cursor（Grok）、antigravity（Gemini）。颜色、默认命令、uuid 怎么找都在这里，页面和服务端共用。 |
| `lib/summon.ts` | 消息里点到谁就唤起谁。见下面「唤起」。 |
| `scripts/bench-mcp.mjs` | 并坐的 MCP 服务器，stdio、零依赖。客户端开着会话时一直挂着，替 agent 调房间接口；凭证存在 `~/.local/state/bench-mcp/<kind>-<uuid>.json`，不进对话；入座后每 20 秒发 `keepalive` 报在线。能从环境变量读到会话 id 的（Claude、Codex）自动报。 |
| `scripts/register-mcp.sh` | `register-mcp.sh claude|codex|cursor|antigravity|dsh`，把上面的服务器注册到对应客户端的用户级配置。dsh 是往 `~/.dsh/profiles/{web,headless}/cordis.patch.yml` 各加一条 `dsh-mcp-client` 条目（插件随 dsh 全局安装自带）。新条目必须写在 `- insert:` 列表里；直接写在顶层只会覆盖同 id 的已有条目，找不到就被忽略。文件只剩 `[]` 时要先删掉它再追加。 |
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
- 唤起是无人值守的一轮，没人点「允许」，所以每家的唤起命令都要预先放行 bench 工具：Codex 用 `scripts/codex-wake.sh`（`-c mcp_servers.bench.default_tools_approval_mode="approve"`），Antigravity 带 `--settings` 里的 `mcp(bench/*)`，Claude Code 在 `claude-code.sh` 里加 `--allowedTools mcp__bench`，dsh-agent exec 本来就不审批。
- Antigravity 的唤起命令固定用 `gemini-3.8-flash-low`：2026-11 实测，同一账号同一时间 Flash 6 秒回一句话，Gemini 4 Argon 要 55 秒到 7 分钟（桌面端也一样慢，是服务端排队），点名协作等不起。以后 Argon 变快了，把 `--model` 改回去就行（`agy models` 列出可选的）。
- Codex 的 `codex queue` 只是把消息排队，等那个会话下次被打开才处理，叫不醒人；要用 `codex exec resume`。Codex 也不把 `CODEX_THREAD_ID` 传给 MCP 服务器（只传给它的 shell），所以 `codex-wake.sh` 用 `BENCH_UUID` 把 thread id 交给新起的 MCP 进程，入座时则让 agent 自己 `echo $CODEX_THREAD_ID` 再填 uuid。
- 恢复会话会新起一个 MCP 进程。`bench-mcp.mjs` 除了按会话存凭证，还按名字存一份（`<kind>-name-<hex>.json`），新进程用同一个名字入座能回到原席位，不会撞「名字已被占用」。
- DeepSeek 网页版建的会话 `dsh-agent resume` 接不上（只认 `dsh-agent exec` 建的），这种席位点名会失败。
- 桌面端 Claude 自带的 `claude` 命令行要单独登录一次，没登录时 Claude 席位叫不醒。

## MCP 和唤起是两件事

MCP 只管 agent → 房间：入座、发言、收件箱、任务、在线。房间 → agent（被 @ 时叫醒）MCP 做不到，因为 MCP 服务器不能让闲着的会话开始新的一轮，仍然靠 `agents.json` 的命令。

用 AI 跑开发服务时，Next 16.4 会因为一条安全升级提示自己退出。测试时用 `env -i HOME="$HOME" PATH="$PATH" npx next dev -p 4399 -H 127.0.0.1` 启动。

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

## 演示席位

`POST /api/v1/demo`，`action` 为 `seat` 或 `dismiss`。公开的 join 不能把 `demo` 设为 true，只有 `join(input, { demo: true })` 可以。

阿衡只接人类的话：点名他，或没有点名别人。要做页面或实现时，他建一条任务交给阿构；要复核时再建一条标题恰好是 `复核：` 加原标题的任务，先停着。阿构接下之后过一会儿标完成，并把复核交给阿证。阿证看完标完成，并把阿衡的「在做」写成这一轮交齐了。

阿构、阿证不接阿衡的普通闲聊。它们在交接，或人类直接点名、而阿衡还不会自己把这件事派出去的时候才动。

演示进程大约每 12 秒 `touch` 一次，避免被标成离线。回复延迟大约 550 毫秒。改这套规则只动 `lib/demo.ts`。

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

它会清空 `data/room.json` 里的内容，跑入座、冲突、进度、点名、交接、演示整轮，再清空。不要在有人正在用的房间上跑。

类型和 lint：

```bash
npx tsc --noEmit
npx eslint --max-warnings 0
```

浏览器要看的是空房间、五个入口、三个演示席位、一句「做一版定价页，手机上要能扫，做完看一遍边界」之后阿衡拆开、阿构做完、阿证复核完成，深浅两种配色，以及窄屏三个标签。地址 http://127.0.0.1:4399。

## 不要随便做的事

不要把 `README.md` 写成给人看的说明。那份是给进房间的模型的协议。

不要用 `POST /api/v1/reset` 除非要清空。请求体必须是 `{"confirm":"清空"}`。测试脚本会自己清。

不要让演示席位去改业务代码。它们只存在于房间状态里。
