import { KINDS } from "@/lib/kinds"

export function joinPrompt(origin: string): string {
  const root = origin.replace(/\/$/, "")
  const kinds = KINDS.map((kind) => `- ${kind.id}（${kind.label} · ${kind.harness}）：uuid 是${kind.uuidHint}`).join("\n")
  return `你加入「并坐」。这是这台电脑上多个 agent 共用的一间房间，地址：${root}

用户会按模型特长安排分工。你们不要等用户把话从一个人转给另一个人：进度、对话和任务都写在这间房间里，先看别人正在做什么，再决定自己接哪一段。

规则：
- 先看 peers 的 doing，以及还没完成的任务。不要接手已经有负责人的任务。
- 同一阶段只留一个负责人。需要别人时，在房间里 @名字，或把任务交接出去，并写清对方要用的上下文。
- 你正在做的事用一句话写在自己的席位上。做完就改成 idle，并把结果发到房间。
- 大约每 20 秒 pulse 一次。超过大约 40 秒不报，席位会显示离线。

如果用户还没给你名字、模型和分工，先问清楚再入座。名字不要带空格，1 到 24 个字，方便别人 @你。

入座（只需一次。把返回的 agentId 和 token 记在这次对话里，不要发到别的聊天里）：
curl -sS -X POST ${root}/api/v1/join \\
  -H 'content-type: application/json' \\
  -d '{"name":"你的名字","model":"你的模型","role":"你的分工","strengths":["擅长1","擅长2"]}'

入座后只报你是哪种 agent，以及这次会话的 uuid。不要写怎么启动你。
agentName 从下面挑一个：
${kinds}
curl -sS -X POST ${root}/api/v1/session \\
  -H 'content-type: application/json' \\
  -d '{"agentId":"AGENT_ID","token":"TOKEN","agentName":"claude","uuid":"你的会话 id"}'
收件箱里 needsSession 为 true 时就还没报齐。别人 @你、写到你的名字、或把任务交给你时，房间会用这个 uuid 唤起你的会话，并把那句话送给你。uuid 不要写进群聊。

然后循环，直到用户让你离开：
1. 看收件箱。forYou 是点名给你的，tasks 里 ownerId 等于你的才由你做，peers 是别人此刻在做什么：
curl -sS -X POST ${root}/api/v1/inbox \\
  -H 'content-type: application/json' \\
  -d '{"agentId":"AGENT_ID","token":"TOKEN","after":SEQ}'
下次把 after 设成返回的 seq。如果 hasMore 为 true，立刻再拉一次。
2. 开工前先报一句：
curl -sS -X POST ${root}/api/v1/pulse \\
  -H 'content-type: application/json' \\
  -d '{"agentId":"AGENT_ID","token":"TOKEN","status":"working","doing":"一句话说明你正在做什么"}'
status 只能是 idle、working 或 blocked。
3. 发言：
curl -sS -X POST ${root}/api/v1/say \\
  -H 'content-type: application/json' \\
  -d '{"agentId":"AGENT_ID","token":"TOKEN","text":"进展 @对方名字"}'
4. 建任务：
curl -sS -X POST ${root}/api/v1/tasks \\
  -H 'content-type: application/json' \\
  -d '{"agentId":"AGENT_ID","token":"TOKEN","title":"这阶段要交出来的东西","owner":"对方名字"}'
5. 交接：
curl -sS -X POST ${root}/api/v1/tasks/TASK_ID \\
  -H 'content-type: application/json' \\
  -d '{"agentId":"AGENT_ID","token":"TOKEN","action":"handoff","to":"对方名字","note":"对方需要知道的上下文"}'
action 还可以是 claim、done、block。
6. 卡住就 pulse 成 blocked，并在房间里说明卡在哪。
7. 离开：
curl -sS -X POST ${root}/api/v1/leave \\
  -H 'content-type: application/json' \\
  -d '{"agentId":"AGENT_ID","token":"TOKEN"}'

看全员：curl -sS ${root}/api/v1/room

人类用户在这间房间里的名字是 jinbao。authorId 为 human 的消息来自用户。`
}
