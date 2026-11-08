# 并坐维护交接

改这个仓库的人读这份。进房间协作的模型读 `README.md`，不要把两份当成同一件事。

并坐是同一台电脑上多个 agent 的一间房间。模型各用各的，进度、对话、任务写在一起。一个阶段一个负责人。演示席位会接话和交接，不会改仓库里的代码。

## 现在跑在哪

云端虚拟机上的开发服务是 `npm run dev`：`0.0.0.0:43123`。Cursor 把这个端口接到使用这台云端机器的人电脑上的 `127.0.0.1:43123`。所以别人浏览器里的 43123 往往是云端，不是他自己解压的那份。

本机启动用 `start.bat`，端口是 **4399**，只绑 `127.0.0.1`。地址是 http://127.0.0.1:4399。不要把 `start.bat` 改回 43123，那个端口已经被云端转发占着。

`package.json` 里的 `dev` 和 `start` 仍是 43123。那是云端这条进程用的，和 `start.bat` 分开。

房间接口在虚拟机本机大约几毫秒到几十毫秒。页面若很慢，先看是不是还在走 43123 的转发。开发模式一次要拉大约 6 MB、二十多个未压缩脚本（React 开发包、Next 开发工具、热更新）。这不是房间数据慢。

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
| `agents.json` | 每种 agent 一条终端模板，页面「配置唤起」写这个文件。`{uuid}` 换成入座时报的 uuid，`{text}` 换成点到他的那句话。 |
| `lib/summon.ts` | 消息里写到席位名、`@` 他、或任务交给他时，按 `agents.json` 唤起。 |

页面是客户端组件，`app/page.tsx` 只渲染 `RoomApp`。三列：席位、群聊、分工。窄屏用「对话 / 队友 / 分工」三个标签。

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

`cacheComponents` 打开时，客户端组件在渲染期间读 `Date.now()` 会把预渲染卡住，页面停在「正在打开席位」。时钟放在 `useEffect` 里。现在的 `now` 初值是 `0`，效果开始时再取当前时间。

开发服务认为自己是 `localhost`。浏览器从 `127.0.0.1` 打开时，热更新 WebSocket 会被拒绝，React 会一直等调试通道，页面同样停在骨架。`allowedDevOrigins` 里要留着 `127.0.0.1` 和 `localhost`。

`next-themes` 会在 `<html>` 上写 `color-scheme`。`app/layout.tsx` 的 `<html>` 有 `suppressHydrationWarning`，拿掉会报水合不一致。

Next 开发徽章在左下角，会挡住席位栏底部。`app/globals.css` 里 `body:has(nextjs-portal) main` 的下内边距是为了躲开它。空房间时「先坐下三个演示席位」放在虚线空状态里，不放在会被徽章挡住的栏底。

客户端只在快照的 `rev` 不比当前旧时才覆盖本地状态。

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

浏览器要看的是空房间、三个演示席位、一句「做一版定价页，手机上要能扫，做完看一遍边界」之后阿衡拆开、阿构做完、阿证复核完成，以及窄屏三个标签。云端预览用 43123。本机用 4399。

## 不要随便做的事

不要把 `README.md` 写成给人看的说明。那份是给进房间的模型的协议。

不要在云端预览里把端口改回和本机相同，除非先确认转发已经关了。

不要用 `POST /api/v1/reset` 除非要清空。请求体必须是 `{"confirm":"清空"}`。测试脚本会自己清。

不要让演示席位去改业务代码。它们只存在于房间状态里。
