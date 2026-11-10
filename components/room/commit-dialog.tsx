"use client"

import { useEffect, useState } from "react"
import { Loader2 } from "lucide-react"

import { api } from "@/components/room/api"
import { CodeBox } from "@/components/room/markdown"
import { closeCommit, useCommit } from "@/components/room/refs"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"

type Commit = {
  hash: string
  author: string
  date: string
  subject: string
  body: string
  dir: string
  stat: string
  patch: string
  truncated: boolean
}

// A commit named in a message (click its hash): who, when, the message, the
// files it touched and the diff, read from the seat's or the project's repo.
export function CommitDialog() {
  const wanted = useCommit()
  const [found, setFound] = useState<{ key: string; commit?: Commit; error?: string } | null>(null)
  const key = wanted ? `${wanted.hash}|${wanted.from ?? ""}` : ""

  useEffect(() => {
    if (!wanted) return
    let alive = true
    const query = new URLSearchParams({ hash: wanted.hash, ...(wanted.from ? { from: wanted.from } : {}) })
    api<Commit>(`/api/v1/commit?${query}`)
      .then((commit) => alive && setFound({ key, commit }))
      .catch((error: Error) => alive && setFound({ key, error: error.message }))
    return () => {
      alive = false
    }
  }, [wanted, key])

  const shown = found?.key === key ? found : null
  const commit = shown?.commit
  return (
    <Dialog open={wanted !== null} onOpenChange={(open) => !open && closeCommit()}>
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="pr-6 leading-snug">{commit ? commit.subject : `提交 ${wanted?.hash ?? ""}`}</DialogTitle>
          <DialogDescription>
            {commit
              ? `${commit.hash.slice(0, 10)} · ${commit.author} · ${new Date(commit.date).toLocaleString("zh-CN", { hour12: false })} · ${commit.dir}`
              : shown?.error ?? "正在读…"}
          </DialogDescription>
        </DialogHeader>
        {!shown ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            在仓库里找这个提交
          </div>
        ) : commit ? (
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1 text-[0.9rem]">
            {commit.body ? <p className="whitespace-pre-wrap text-muted-foreground">{commit.body}</p> : null}
            {commit.stat ? <CodeBox code={commit.stat} lang="改动的文件" tone="ink" /> : null}
            {commit.patch ? <CodeBox code={commit.patch} lang="diff" tone="ink" /> : null}
            {commit.truncated ? <p className="text-xs text-muted-foreground">diff 太长，只显示了前面一部分。</p> : null}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
