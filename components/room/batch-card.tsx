"use client"

import { useEffect, useMemo, useState } from "react"
import { Check, ChevronDown, ClipboardCheck, ExternalLink, X } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/components/room/api"
import { notifyDeputyChanged } from "@/components/room/front"
import { openProjectAt } from "@/components/room/refs"
import { Button } from "@/components/ui/button"
import { batchCounts, batchRemainingText, sortBatchItems } from "@/lib/review"
import { clock, plainCheckText } from "@/lib/status"
import type { Message, RelayBatchItem, RelayDraft, RoomSnapshot, SignLane, Task } from "@/lib/types"

// A batch sign-off card drafted by the front desk (Message.relay.kind === "batch",
// t_50597554 / t_1d6bfa5a). Waiting reviews across projects are split into three
// lanes:
//   - batch（「可以整批通过」）: checkbox per row (all checked by default), one line
//     from the desk, expandable checker basis, and a single 「这 N 件都通过」 button.
//   - look（「你看一眼」）: one line, 「通过」 and 「去看」 per row.
//   - you（「只能你签」）: the reason why only the user may sign, 「通过」 and 「去看」 per row.
// Settled rows sink below unsettled rows inside each lane (and settled lanes sink below
// unsettled ones), showing what remains in plain words until the whole list is done.

const FOLD_LIMIT = 6

const GROUP_META: Record<SignLane, { title: string; badge: string; tone: string }> = {
  batch: {
    title: "可以整批通过",
    badge: "跑得出结果 · 查过，没问题",
    tone: "text-emerald-700 dark:text-emerald-300",
  },
  look: {
    title: "你看一眼",
    badge: "界面或要人判断",
    tone: "text-amber-800 dark:text-amber-300",
  },
  you: {
    title: "只能你签",
    badge: "去原项目处理",
    tone: "text-muted-foreground",
  },
}

type ExtraInfo = {
  checkNote?: string
  checkName?: string
  fallbackWhy?: string
}

function fallbackWhyOf(task: Task): string | undefined {
  const c = task.check
  if (!c) return "还没有检查"
  if (c.state === "failed") return `查出问题${c.note ? `：${plainCheckText(c.note).split("\n")[0].slice(0, 40)}` : ""}`
  if (c.state === "unverified") return "没查出结论"
  if (c.state === "skipped") return (c.note ? plainCheckText(c.note) : "") || "没检查"
  if (c.state === "error") return (c.note ? plainCheckText(c.note) : "") || "检查没跑成"
  if (c.state === "queued" || c.state === "running") return "检查还在跑"
  if (task.review && c.at < task.review.at) return "检查是上一轮的"
  if (c.by && task.ownerId && c.by === task.ownerId) return "检查人就是负责人"
  if (c.kind === "you") return "检查标为只能本人签"
  if (c.gaps) return `有没验到的：${c.gaps.slice(0, 36)}`
  return undefined
}

export function BatchCard({ message }: { message: Message }) {
  const relay = message.relay
  const [overrideRelay, setOverrideRelay] = useState<{ base: RelayDraft | undefined; next: RelayDraft } | null>(null)
  const localRelay = overrideRelay && overrideRelay.base === relay ? overrideRelay.next : relay

  const items = useMemo(() => localRelay?.items ?? [], [localRelay?.items])

  // Track which batch-lane items the user has unchecked (all open batch items
  // are checked by default).
  const [unchecked, setUnchecked] = useState<Set<string>>(() => new Set())
  const [openBasis, setOpenBasis] = useState<Set<string>>(() => new Set())
  const [expandedGroups, setExpandedGroups] = useState<Set<SignLane>>(() => new Set())
  const [busy, setBusy] = useState(false)
  const [extras, setExtras] = useState<Record<string, ExtraInfo>>({})

  // Fetch checker notes / fallback reasons from the target projects when the
  // card items don't already carry them inline.
  useEffect(() => {
    const missingProjects = new Set<string>()
    for (const item of items) {
      if (!item.checkNote && item.project) missingProjects.add(item.project)
    }
    if (missingProjects.size === 0) return
    let live = true
    Promise.all(
      [...missingProjects].map((projId) =>
        api<RoomSnapshot>(`/api/v1/room?project=${encodeURIComponent(projId)}`)
          .then((snap) => ({ projId, tasks: snap.tasks }))
          .catch(() => ({ projId, tasks: [] as Task[] })),
      ),
    ).then((list) => {
      if (!live) return
      const next: Record<string, ExtraInfo> = {}
      for (const { projId, tasks } of list) {
        for (const t of tasks) {
          next[`${projId}:${t.id}`] = {
            checkNote: t.check?.note,
            checkName: t.check?.name,
            fallbackWhy: fallbackWhyOf(t),
          }
        }
      }
      setExtras((prev) => ({ ...prev, ...next }))
    })
    return () => {
      live = false
    }
  }, [items])

  if (!localRelay || localRelay.kind !== "batch") return null

  const byLane: Record<SignLane, RelayBatchItem[]> = {
    batch: sortBatchItems(items.filter((item) => item.lane === "batch")),
    look: sortBatchItems(items.filter((item) => item.lane === "look")),
    you: sortBatchItems(items.filter((item) => item.lane === "you")),
  }

  const orderedLanes = (["batch", "look", "you"] as const).filter((lane) => byLane[lane].length > 0)
  const sortedLanes: SignLane[] = [
    ...orderedLanes.filter((lane) => byLane[lane].some((item) => !item.state)),
    ...orderedLanes.filter((lane) => byLane[lane].every((item) => Boolean(item.state))),
  ]

  const openBatchItems = byLane.batch.filter((item) => !item.state)
  const checkedBatchIds = openBatchItems
    .map((item) => item.taskId)
    .filter((id) => !unchecked.has(id))

  const toggleCheck = (taskId: string) => {
    setUnchecked((prev) => {
      const next = new Set(prev)
      if (next.has(taskId)) next.delete(taskId)
      else next.add(taskId)
      return next
    })
  }

  const toggleBasis = (key: string) => {
    setOpenBasis((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const toggleGroup = (lane: SignLane) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(lane)) next.delete(lane)
      else next.add(lane)
      return next
    })
  }

  const passTasks = async (taskIds: string[]) => {
    if (taskIds.length === 0 || busy) return
    setBusy(true)
    try {
      const res = await api<{ relay?: RelayDraft }>("/api/v1/relay", {
        method: "POST",
        body: JSON.stringify({
          as: "human",
          messageId: message.id,
          action: "pass",
          taskIds,
        }),
      })
      const nextRelay: RelayDraft = res?.relay ?? {
        ...localRelay,
        items: localRelay.items?.map((item) =>
          taskIds.includes(item.taskId) && !item.state ? { ...item, state: "passed" } : item,
        ),
      }
      setOverrideRelay({ base: relay, next: nextRelay })
      notifyDeputyChanged()

      const prevState = new Map(items.map((item) => [`${item.project}:${item.taskId}`, item.state]))
      const nextItems = nextRelay.items ?? []
      let passedNow = 0
      let skippedNow = 0
      for (const item of nextItems) {
        if (!prevState.get(`${item.project}:${item.taskId}`) && item.state) {
          if (item.state === "passed") passedNow += 1
          else if (item.state === "skipped") skippedNow += 1
        }
      }
      const nextCounts = batchCounts(nextItems)
      const remText = batchRemainingText(nextItems)
      const actionPrefix =
        passedNow > 0
          ? passedNow === 1 && taskIds.length === 1
            ? "验收通过"
            : `已通过 ${passedNow} 件`
          : skippedNow > 0
            ? `${skippedNow} 件已处理过`
            : "已更新"
      if (nextCounts.remTotal === 0) {
        toast.success(passedNow > 0 ? `${actionPrefix}，这批都处理完了` : "这批都处理完了")
      } else if (remText) {
        toast.success(`${actionPrefix}，${remText}`)
      } else {
        toast.success(actionPrefix)
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "没成功")
    } finally {
      setBusy(false)
    }
  }

  const counts = batchCounts(items)
  const remText = batchRemainingText(items)
  const passedCount = counts.passed

  // Closed without being finished: a newer list took over what still waited
  // on it (lib/front-relay.ts carryOpenBatches). One line, so the chat holds
  // one list to act on.
  if (localRelay.state === "dropped") {
    return (
      <div
        data-batch-card={message.id}
        data-batch-closed="true"
        className="my-2 flex w-fit max-w-full items-center gap-1.5 self-start rounded-full border border-border/60 px-3 py-1 text-xs text-muted-foreground"
      >
        <ClipboardCheck className="size-3.5 shrink-0" />
        <span>
          验收清单 · {passedCount > 0 ? `通过了 ${passedCount} 件，` : ""}
          {localRelay.replacedBy ? "剩下的并进了新的一张" : "不用了"}
        </span>
      </div>
    )
  }

  return (
    <div
      data-batch-card={message.id}
      className="my-2 w-full max-w-[min(44rem,100%)] self-start rounded-2xl border border-primary/25 bg-primary/[0.05] px-4 py-3 text-sm"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1 font-medium text-foreground">
          <ClipboardCheck className="size-3.5 text-primary" />
          验收清单
        </span>
        <span>
          共 {counts.total} 件{counts.passed > 0 ? ` · 已通过 ${counts.passed} 件` : ""}
        </span>
        {counts.skipped > 0 ? <span>· 已跳过 {counts.skipped} 件</span> : null}
        {localRelay.settledAt ? <span>· {clock(localRelay.settledAt)}</span> : null}
      </div>

      {remText ? (
        <p
          data-batch-remaining
          className={`mt-1.5 text-xs font-medium ${
            counts.remTotal === 0
              ? "text-emerald-700 dark:text-emerald-300"
              : "text-amber-800 dark:text-amber-300"
          }`}
        >
          {remText}
        </p>
      ) : null}

      {localRelay.why ? <p className="mt-1.5 text-xs leading-5 text-muted-foreground">{localRelay.why}</p> : null}

      <div className="mt-3 space-y-3">
        {sortedLanes.map((lane) => {
          const list = byLane[lane]
          if (list.length === 0) return null
          const meta = GROUP_META[lane]
          const expanded = expandedGroups.has(lane)
          const visible = expanded || list.length <= FOLD_LIMIT ? list : list.slice(0, FOLD_LIMIT)
          const hiddenCount = list.length - visible.length

          return (
            <section
              key={lane}
              data-batch-lane={lane}
              className="rounded-xl bg-background/55 px-3 py-2.5 ring-1 ring-foreground/[0.08]"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div className="flex items-baseline gap-1.5">
                  <h4 className={`text-xs font-semibold ${meta.tone}`}>{meta.title}</h4>
                  <span className="text-[0.6875rem] text-muted-foreground tabular-nums">{list.length}</span>
                </div>
                <span className="text-[0.6875rem] text-muted-foreground">{meta.badge}</span>
              </div>

              <ul className="mt-2 divide-y divide-foreground/[0.06]">
                {visible.map((item) => {
                  const rowKey = `${item.project}:${item.taskId}`
                  const extra = extras[rowKey]
                  const rawBasis = item.checkNote ?? extra?.checkNote
                  const basis = rawBasis ? plainCheckText(rawBasis) : undefined
                  const checker = item.checkName ?? extra?.checkName
                  const rawWhy = item.why ?? item.note ?? extra?.fallbackWhy
                  const whyText = rawWhy ? plainCheckText(rawWhy) : undefined
                  const rawSkip = item.note ?? item.why
                  const skipText = rawSkip ? plainCheckText(rawSkip) : undefined
                  const basisOpen = openBasis.has(rowKey)
                  const isChecked = !unchecked.has(item.taskId)
                  const settled = item.state === "passed" || item.state === "skipped"

                  return (
                    <li key={rowKey} data-batch-item={item.taskId} className="py-2 first:pt-0.5 last:pb-0.5">
                      <div className="flex items-start gap-2">
                        {lane === "batch" && !settled ? (
                          <input
                            type="checkbox"
                            checked={isChecked}
                            disabled={busy}
                            onChange={() => toggleCheck(item.taskId)}
                            aria-label={`勾选 ${item.title}`}
                            className="mt-1 size-3.5 shrink-0 cursor-pointer rounded border-foreground/30 accent-primary"
                          />
                        ) : null}

                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
                            <span className="shrink-0 rounded bg-foreground/[0.06] px-1.5 py-0.5 text-[0.625rem] leading-4 text-muted-foreground">
                              {item.projectName}
                            </span>
                            <span className="font-medium leading-5 text-foreground" title={item.taskId}>
                              {item.title}
                            </span>
                          </div>

                          {lane === "you" ? (
                            <>
                              <p className="mt-0.5 text-xs leading-5 text-amber-800 dark:text-amber-300">
                                {whyText || item.line || "需本人确认"}
                              </p>
                              {item.line && whyText && item.line !== whyText ? (
                                <p className="mt-0.5 text-[0.6875rem] leading-4 text-muted-foreground">{item.line}</p>
                              ) : null}
                            </>
                          ) : item.line ? (
                            <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{item.line}</p>
                          ) : null}

                          {settled ? (
                            <p
                              className={`mt-1 inline-flex items-center gap-1 text-[0.6875rem] font-medium ${
                                item.state === "passed"
                                  ? "text-emerald-700 dark:text-emerald-300"
                                  : "text-amber-800 dark:text-amber-300"
                              }`}
                            >
                              {item.state === "passed" ? (
                                <>
                                  <Check className="size-3" />
                                  已通过
                                </>
                              ) : (
                                <>
                                  <X className="size-3" />
                                  没通过{skipText ? `：${skipText}` : ""}
                                </>
                              )}
                            </p>
                          ) : null}

                          {basis && basisOpen ? (
                            <div className="mt-1.5 rounded-lg bg-foreground/[0.04] px-2.5 py-1.5 text-[0.6875rem] leading-5 text-foreground/85 ring-1 ring-foreground/[0.06]">
                              {checker ? <p className="font-medium text-muted-foreground">检查人：{checker}</p> : null}
                              <p className="whitespace-pre-wrap">{basis}</p>
                            </div>
                          ) : null}
                        </div>

                        <div className="flex shrink-0 items-center gap-1">
                          {(lane === "batch" || lane === "you") && basis ? (
                            <button
                              type="button"
                              onClick={() => toggleBasis(rowKey)}
                              aria-expanded={basisOpen}
                              className="rounded px-1.5 py-0.5 text-[0.6875rem] text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground"
                            >
                              {basisOpen ? "收起" : "依据"}
                            </button>
                          ) : null}

                          {(lane === "look" || lane === "you") && !settled ? (
                            <Button
                              type="button"
                              size="xs"
                              disabled={busy}
                              onClick={() => void passTasks([item.taskId])}
                            >
                              <Check className="size-3" />
                              通过
                            </Button>
                          ) : null}

                          <Button
                            type="button"
                            size="xs"
                            variant="outline"
                            onClick={() => openProjectAt(item.project, item.taskId)}
                          >
                            <ExternalLink className="size-3" />
                            去看
                          </Button>
                        </div>
                      </div>
                    </li>
                  )
                })}
              </ul>

              {hiddenCount > 0 ? (
                <button
                  type="button"
                  onClick={() => toggleGroup(lane)}
                  className="mt-1.5 flex w-full items-center justify-center gap-1 rounded-lg py-1 text-xs text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground"
                >
                  <span>还有 {hiddenCount} 件</span>
                  <ChevronDown className="size-3.5" />
                </button>
              ) : list.length > FOLD_LIMIT && expanded ? (
                <button
                  type="button"
                  onClick={() => toggleGroup(lane)}
                  className="mt-1.5 flex w-full items-center justify-center gap-1 rounded-lg py-1 text-xs text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground"
                >
                  <span>收起</span>
                  <ChevronDown className="size-3.5 rotate-180" />
                </button>
              ) : null}

              {lane === "batch" && openBatchItems.length > 0 ? (
                <div className="mt-2.5 flex items-center justify-between border-t border-foreground/[0.06] pt-2">
                  <span className="text-[0.6875rem] text-muted-foreground">
                    已勾 {checkedBatchIds.length}/{openBatchItems.length} 件
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    disabled={busy || checkedBatchIds.length === 0}
                    onClick={() => void passTasks(checkedBatchIds)}
                  >
                    <Check className="size-3.5" />
                    这 {checkedBatchIds.length} 件都通过
                  </Button>
                </div>
              ) : null}
            </section>
          )
        })}
      </div>
    </div>
  )
}
