"use client"

import { useState } from "react"
import { Check, ChevronDown, ExternalLink } from "lucide-react"

import { AskCard } from "@/components/room/ask-card"
import { DeputyPassList, useDeputyToday } from "@/components/room/front"
import { LimitedCard } from "@/components/room/limited-card"
import { PermitCard } from "@/components/room/permits"
import { openProjectAt } from "@/components/room/refs"
import { InterruptedCard } from "@/components/room/thread"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import type { Digest, DigestRow } from "@/lib/digest"
import {
  collectOpenAsks,
  isPendingInterrupted,
  isPendingLimited,
  reviewCheckSummary,
  type WaitingOverview,
} from "@/lib/waiting-shared"
import type { RoomSnapshot } from "@/lib/types"

// First-layer side column「等你定」: lists only decisions that genuinely wait
// on the user right now (most blocking first), plus the two quiet status lines
// at the bottom (deputy auto-accepts today & working AI count).

export function WaitingPanel({
  room,
  digest,
  overview,
  workingCount,
  refreshKey,
  busy,
  onEnterFull,
  onOpenRun,
  onRewake,
  onReview,
  onPassForeignReview,
}: {
  room: RoomSnapshot
  digest: Digest | null
  overview: WaitingOverview | null
  workingCount: number
  refreshKey: string
  busy: boolean
  onEnterFull: (taskId?: string) => void
  onOpenRun: (runId: string) => void
  onRewake: (runId: string) => void
  onReview: (taskId: string, pass: boolean, note: string) => Promise<boolean>
  onPassForeignReview: (projectId: string, taskId: string) => Promise<void>
}) {
  const isFront = Boolean(room.project.front)
  const { passes, busyId: deputyBusyId, reopen } = useDeputyToday(refreshKey)
  const [deputyOpen, setDeputyOpen] = useState(false)

  // Unify single-project and front-desk waiting lists into one WaitingOverview
  // shape so sorting, counts and card rendering share a single code path.
  const meta = { projectId: room.project.id, projectName: room.project.name }
  const data: WaitingOverview | null = isFront
    ? overview
    : {
        permits: (room.permits ?? []).map((permit) => ({ ...meta, permit })),
        asks: collectOpenAsks(room.messages, room.openAsks).map((message) => ({ ...meta, message })),
        limited: room.messages.filter(isPendingLimited).map((message) => ({ ...meta, message })),
        interrupted: room.messages.filter(isPendingInterrupted).map((message) => ({ ...meta, message })),
        reviews: (digest?.you.filter((row) => row.need === "review") ?? []).map((row) => ({ ...meta, row })),
        workingTotal: workingCount,
      }

  const totalCount = data
    ? data.permits.length + data.asks.length + data.limited.length + data.interrupted.length + data.reviews.length
    : 0

  return (
    <aside
      aria-label="等你定"
      data-waiting-panel
      className="frost flex h-full min-h-0 flex-col rounded-2xl"
    >
      <div className="flex shrink-0 items-center justify-between gap-2 px-4 pt-4 pb-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <span>等你定</span>
          {totalCount > 0 ? (
            <span className="grid h-5 min-w-5 place-items-center rounded-full bg-amber-500 px-1.5 text-xs font-semibold text-white tabular-nums">
              {totalCount}
            </span>
          ) : null}
        </h2>
      </div>

      <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto px-3 pb-3">
        {data === null ? (
          <p className="rounded-2xl border border-dashed px-3.5 py-6 text-center text-xs text-muted-foreground">
            正在看各项目有没有等你定的事…
          </p>
        ) : totalCount === 0 ? (
          <p className="rounded-2xl border border-dashed px-3.5 py-6 text-center text-xs text-muted-foreground">
            现在没有要你定的事
          </p>
        ) : (
          <>
            {data.permits.map((item) => (
              <PermitCard
                key={`${item.projectId}:${item.permit.id}`}
                item={item.permit}
                projectName={isFront ? item.projectName : undefined}
                onInspect={isFront ? () => openProjectAt(item.projectId) : undefined}
              />
            ))}
            {data.asks.map((item) => (
              <AskCard
                key={`${item.projectId}:${item.message.id}`}
                message={item.message}
                projectName={isFront ? item.projectName : undefined}
                showQuestion
                onInspect={isFront ? () => openProjectAt(item.projectId) : undefined}
              />
            ))}
            {data.limited.map((item) => (
              <LimitedCard
                key={`${item.projectId}:${item.message.id}`}
                message={item.message}
                compact
                projectName={isFront ? item.projectName : undefined}
                onInspect={isFront ? () => openProjectAt(item.projectId) : undefined}
              />
            ))}
            {data.interrupted.map((item) => (
              <InterruptedCard
                key={`${item.projectId}:${item.message.id}`}
                message={item.message}
                compact
                projectName={isFront ? item.projectName : undefined}
                onOpenRun={onOpenRun}
                onRewake={onRewake}
                onInspect={isFront ? () => openProjectAt(item.projectId) : undefined}
              />
            ))}
            {data.reviews.map((item) => (
              <WaitingReviewCard
                key={`${item.projectId}:${item.row.id}`}
                row={item.row}
                projectName={isFront ? item.projectName : undefined}
                busy={busy}
                onPass={() =>
                  isFront ? onPassForeignReview(item.projectId, item.row.id) : onReview(item.row.id, true, "")
                }
                onReject={isFront ? undefined : (reason) => onReview(item.row.id, false, reason)}
                onDetail={isFront ? undefined : () => onEnterFull(item.row.id)}
                onInspect={isFront ? () => openProjectAt(item.projectId, item.row.id) : undefined}
              />
            ))}
          </>
        )}
      </div>

      <div className="shrink-0 space-y-2 border-t border-foreground/[0.06] px-3.5 py-2.5 text-xs">
        {passes.length > 0 ? (
          <div>
            <div className="flex items-center justify-between gap-2">
              <span className="flex min-w-0 items-center gap-2 text-muted-foreground">
                <span className="size-2 shrink-0 rounded-full bg-emerald-500" aria-hidden />
                <span className="truncate">今天替你收下 {passes.length} 件</span>
              </span>
              <button
                type="button"
                aria-expanded={deputyOpen}
                className="inline-flex shrink-0 items-center gap-0.5 text-muted-foreground underline underline-offset-3 hover:text-foreground"
                onClick={() => setDeputyOpen((v) => !v)}
              >
                {deputyOpen ? "收起" : "看看"}
                <ChevronDown className={`size-3 transition-transform ${deputyOpen ? "rotate-180" : ""}`} />
              </button>
            </div>
            {deputyOpen ? (
              <div className="mt-2 max-h-56 overflow-y-auto rounded-xl border border-foreground/[0.06] bg-background/50 px-2.5 py-1.5">
                <DeputyPassList passes={passes} busyId={deputyBusyId} onReopen={(item) => void reopen(item)} />
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="flex items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-2 text-muted-foreground">
            <span
              className={`size-2 shrink-0 rounded-full ${
                workingCount > 0 ? "animate-pulse bg-emerald-500" : "bg-foreground/25"
              }`}
              aria-hidden
            />
            <span className="truncate">{workingCount} 个 AI 正在干活</span>
          </span>
          <button
            type="button"
            className="shrink-0 text-muted-foreground underline underline-offset-3 hover:text-foreground"
            onClick={() => onEnterFull()}
          >
            看细节
          </button>
        </div>
      </div>
    </aside>
  )
}

function WaitingReviewCard({
  row,
  projectName,
  busy,
  onPass,
  onReject,
  onDetail,
  onInspect,
}: {
  row: DigestRow
  projectName?: string
  busy: boolean
  onPass: () => Promise<boolean | void>
  onReject?: (reason: string) => Promise<boolean>
  onDetail?: () => void
  onInspect?: () => void
}) {
  const [rejecting, setRejecting] = useState(false)
  const [reason, setReason] = useState("")
  const [submitting, setSubmitting] = useState(false)

  const checkSummary = reviewCheckSummary(row.check)
  const metaParts = [
    projectName,
    row.owner?.name ? `${row.owner.name} 做完了` : "已做完",
    checkSummary,
  ].filter(Boolean)
  const note = row.line && row.line !== "等你验收" ? row.line : ""
  const locked = busy || submitting

  return (
    <article
      data-waiting-review={row.id}
      className="rounded-2xl border border-l-4 border-foreground/10 border-l-amber-500 bg-card px-3.5 py-2.5 text-xs shadow-sm"
    >
      <h3 className="truncate text-[0.8125rem] leading-5 font-semibold" title={row.title}>
        {row.title}
      </h3>
      <p className="mt-0.5 text-[0.6875rem] leading-4 text-muted-foreground">
        {metaParts.join(" · ")}
      </p>
      {note ? (
        <p className="mt-1.5 line-clamp-2 leading-5 text-foreground/85">{note}</p>
      ) : null}

      {rejecting && onReject ? (
        <form
          className="mt-2 space-y-1.5"
          onSubmit={async (event) => {
            event.preventDefault()
            const clean = reason.trim()
            if (!clean || locked) return
            setSubmitting(true)
            const ok = await onReject(clean)
            setSubmitting(false)
            if (ok) {
              setRejecting(false)
              setReason("")
            }
          }}
        >
          <Textarea
            autoFocus
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder={`哪里不对？会转给 ${row.owner?.name ?? "负责人"}，它照着改`}
            aria-label="打回原因"
            rows={2}
            className="min-h-0 resize-none bg-background/60 text-xs"
          />
          <div className="flex items-center gap-1.5">
            <Button type="submit" size="xs" variant="destructive" disabled={locked || !reason.trim()}>
              打回
            </Button>
            <Button type="button" size="xs" variant="ghost" onClick={() => setRejecting(false)}>
              取消
            </Button>
          </div>
        </form>
      ) : (
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          <Button
            type="button"
            size="xs"
            disabled={locked}
            onClick={async () => {
              setSubmitting(true)
              await onPass()
              setSubmitting(false)
            }}
          >
            <Check className="size-3" />
            通过
          </Button>
          {onReject ? (
            <Button type="button" size="xs" variant="outline" disabled={locked} onClick={() => setRejecting(true)}>
              打回
            </Button>
          ) : null}
          {onDetail ? (
            <Button type="button" size="xs" variant="ghost" disabled={locked} onClick={onDetail}>
              看细节
            </Button>
          ) : null}
          {onInspect ? (
            <Button type="button" size="xs" variant="outline" disabled={locked} onClick={onInspect}>
              <ExternalLink className="size-3" />
              去看
            </Button>
          ) : null}
        </div>
      )}
    </article>
  )
}
