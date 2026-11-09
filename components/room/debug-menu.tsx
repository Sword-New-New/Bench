import { Bug } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { AgentStatus, PublicAgent, RoomSnapshot } from "@/lib/types"

// Only in `next dev`; the debug route refuses in production as well.
export const DEBUG_MENU = process.env.NODE_ENV === "development"

// Overrides on what you see. They never touch the room itself.
export type DebugView = {
  nudge: boolean
  writing: boolean
  status: AgentStatus | "real"
}

export const NO_DEBUG: DebugView = { nudge: false, writing: false, status: "real" }

export function withDebug(room: RoomSnapshot, view: DebugView): RoomSnapshot {
  if (!view.nudge && !view.writing && view.status === "real") return room
  const status = view.status
  const agents =
    status === "real"
      ? room.agents
      : room.agents.map((agent) => ({
          ...agent,
          status,
          standby: false,
          // A seat that can be woken shows as resting; take that away so
          // "offline" really sleeps.
          callable: status === "offline" ? false : agent.callable,
        }))
  const writer = agents.find((agent) => agent.callable && !agent.demo) ?? agents[0]
  return {
    ...room,
    agents,
    summaryDue: view.nudge || room.summaryDue,
    sinceSummary: view.nudge ? { count: 128, chars: 12_400 } : room.sinceSummary,
    summaryWriter: view.writing ? (writer?.id ?? null) : room.summaryWriter,
  }
}

const NOTES = [
  { kind: "relay", label: "接力到上限" },
  { kind: "failed", label: "唤起失败" },
  { kind: "nosession", label: "点到了但没报会话" },
]

const STATUSES: { value: DebugView["status"]; label: string }[] = [
  { value: "real", label: "真实状态" },
  { value: "idle", label: "全部空闲" },
  { value: "working", label: "全部在做" },
  { value: "blocked", label: "全部卡住" },
  { value: "offline", label: "全部离线（睡着）" },
]

export function DebugMenu({
  view,
  agents,
  busy,
  onView,
  onNote,
  onForget,
  onClearSummary,
  onClearSnooze,
  onSummaryDone,
  onLiveDemo,
}: {
  view: DebugView
  agents: PublicAgent[]
  busy: boolean
  onView: (view: DebugView) => void
  onNote: (kind: string) => void
  onForget: (agent: PublicAgent) => void
  onClearSummary: () => void
  onClearSnooze: () => void
  onSummaryDone: () => void
  onLiveDemo: () => void
}) {
  const changed = view.nudge || view.writing || view.status !== "real"
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="调试菜单"
            className={changed ? "text-amber-600 dark:text-amber-400" : undefined}
          />
        }
      >
        <Bug />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel>只改你看到的</DropdownMenuLabel>
          <DropdownMenuCheckboxItem checked={view.nudge} onCheckedChange={(nudge) => onView({ ...view, nudge })}>
            摘要提醒条
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem checked={view.writing} onCheckedChange={(writing) => onView({ ...view, writing })}>
            有人正在写摘要
          </DropdownMenuCheckboxItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>头像状态</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuRadioGroup
                value={view.status}
                onValueChange={(status) => onView({ ...view, status: status as DebugView["status"] })}
              >
                {STATUSES.map((item) => (
                  <DropdownMenuRadioItem key={item.value} value={item.value}>
                    {item.label}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
              <DropdownMenuLabel className="font-normal">从「在做」切走会先放完成动画</DropdownMenuLabel>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuItem onClick={onSummaryDone}>放一次「摘要写好了」动效</DropdownMenuItem>
          <DropdownMenuItem onClick={onLiveDemo}>放一次「正在做」卡片：换步骤、做完退场</DropdownMenuItem>
          <DropdownMenuItem onClick={onClearSnooze}>清掉「稍后提醒」</DropdownMenuItem>
          {changed ? <DropdownMenuItem onClick={() => onView(NO_DEBUG)}>全部恢复</DropdownMenuItem> : null}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel>会写进房间</DropdownMenuLabel>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger disabled={busy}>插一条系统消息</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {NOTES.map((note) => (
                <DropdownMenuItem key={note.kind} onClick={() => onNote(note.kind)}>
                  {note.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger disabled={busy || agents.length === 0}>让席位忘掉读到哪</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {agents.map((agent) => (
                <DropdownMenuItem key={agent.id} onClick={() => onForget(agent)}>
                  {agent.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuItem disabled={busy} onClick={onClearSummary}>
            清空房间摘要
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
