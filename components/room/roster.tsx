import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Lamp } from "@/components/room/bits"
import { ago, STATUS_LABEL } from "@/lib/status"
import type { PublicAgent } from "@/lib/types"

export function Roster({
  agents,
  now,
  focusId,
  onMention,
  onFocus,
  onLeave,
  onSeat,
  onDismiss,
  onConfigure,
  demoSeated,
  busy,
}: {
  agents: PublicAgent[]
  now: number
  focusId: string | null
  onMention: (name: string) => void
  onFocus: (id: string | null) => void
  onLeave: (agent: PublicAgent) => void
  onSeat: () => void
  onDismiss: () => void
  onConfigure: (name: string | null) => void
  demoSeated: boolean
  busy: boolean
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between px-4 py-3">
        <h2 className="text-sm font-medium">队友</h2>
        <span className="text-xs text-muted-foreground">{agents.length} 个席位</span>
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 pb-3">
        {agents.length === 0 ? (
          <div className="rounded-xl border border-dashed px-3 py-4 text-sm leading-6 text-muted-foreground">
            还没有 agent 入座。它们各自用自己的模型，但进度、对话和任务都写在这间房间里。
            <Button
              type="button"
              variant="outline"
              className="mt-3 w-full bg-card"
              disabled={busy}
              onClick={onSeat}
            >
              先坐下三个演示席位
            </Button>
          </div>
        ) : (
          agents.map((agent) => {
            const focused = focusId === agent.id
            return (
              <article
                key={agent.id}
                className="rounded-xl border bg-card px-3 py-3"
                style={{
                  borderLeftWidth: 3,
                  borderLeftColor: agent.color,
                  outline: focused ? `2px solid ${agent.color}` : undefined,
                  outlineOffset: focused ? 1 : undefined,
                }}
              >
                <div className="flex items-start justify-between gap-2">
                  <button
                    type="button"
                    className="min-w-0 text-left"
                    onClick={() => onMention(agent.name)}
                  >
                    <span className="flex items-center gap-2">
                      <Lamp status={agent.status} />
                      <span className="truncate font-medium" style={{ color: agent.color }}>
                        {agent.name}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {STATUS_LABEL[agent.status]}
                      </span>
                    </span>
                    <span className="mt-1 block text-xs text-muted-foreground">
                      {agent.model} · {agent.role}
                    </span>
                  </button>
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      className="rounded-md px-1.5 text-sm text-muted-foreground hover:bg-muted"
                      aria-label={`${agent.name} 的席位菜单`}
                    >
                      ···
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => onMention(agent.name)}>
                        @{agent.name}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => onFocus(focused ? null : agent.id)}
                      >
                        {focused ? "看全部对话" : "只看这个人"}
                      </DropdownMenuItem>
                      {!agent.demo ? (
                        <DropdownMenuItem onClick={() => onConfigure(agent.agentName || null)}>
                          配置唤起
                        </DropdownMenuItem>
                      ) : null}
                      <DropdownMenuItem variant="destructive" onClick={() => onLeave(agent)}>
                        请离席
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
                <p className="mt-2 text-sm leading-5">
                  {agent.doing || (
                    <span className="text-muted-foreground">还没写正在做的事</span>
                  )}
                </p>
                {agent.strengths.length > 0 ? (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {agent.strengths.map((strength) => (
                      <Badge key={strength} variant="secondary">
                        {strength}
                      </Badge>
                    ))}
                  </div>
                ) : null}
                <div className="mt-2 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <span>{agent.demo ? "演示席位" : "真席位"}</span>
                    {!agent.demo ? (
                      <Badge variant={agent.callable ? "secondary" : "outline"}>
                        {agent.agentName ? `${agent.agentName} · ` : ""}
                        {agent.callable ? "可唤起" : agent.hasSession ? "未适配" : "未报"}
                      </Badge>
                    ) : null}
                  </span>
                  <span>报过进度 {ago(agent.lastSeenAt, now)}</span>
                </div>
              </article>
            )
          })
        )}
      </div>
      <div className="space-y-2 border-t px-3 py-3">
        <p className="text-xs leading-5 text-muted-foreground">
          大约 40 秒不报进度，席位会变灰。先看别人正在做的那一句，再决定要不要接。
        </p>
        <Button
          type="button"
          variant="outline"
          className="w-full"
          disabled={busy}
          onClick={() => onConfigure(null)}
        >
          配置唤起
        </Button>
        {demoSeated ? (
          <Button
            type="button"
            variant="outline"
            className="w-full"
            disabled={busy}
            onClick={onDismiss}
          >
            请演示离席
          </Button>
        ) : agents.length > 0 ? (
          <Button
            type="button"
            variant="outline"
            className="w-full"
            disabled={busy}
            onClick={onSeat}
          >
            先坐下三个演示席位
          </Button>
        ) : null}
      </div>
    </div>
  )
}
