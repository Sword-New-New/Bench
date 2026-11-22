"use client"

import { useCallback, useEffect, useState } from "react"
import { ArrowRight, Loader2, Settings2 } from "lucide-react"

import { api } from "@/components/room/api"
import { usePathPicker } from "@/components/room/folder-picker"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { folderNameOf } from "@/lib/first-name"

// 「第一次打开」 (lib/first-open.ts): a room nobody has used yet asks only what
// the user wants done. Who does it and where are picked for them, each with
// 「换一个」; 「更多设置」 goes to the full page with all its dialogs.

type Info = {
  fresh: boolean
  kinds: { id: string; label: string }[]
  pick: string | null
  parent: string
  parentLabel: string
  install?: { label: string; text: string; url: string }
}

export function FirstOpen({ onMore, onStarted }: { onMore: () => void; onStarted: (projectId: string) => void }) {
  const [info, setInfo] = useState<Info | null>(null)
  const [text, setText] = useState("")
  const [kind, setKind] = useState<string | null>(null)
  const [dir, setDir] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const picker = usePathPicker(true)
  const [problem, setProblem] = useState("")

  const look = useCallback(() => {
    api<Info>("/api/v1/first")
      .then((data) => {
        if (!data.fresh) return onMore()
        setInfo(data)
        setKind((current) => (current && data.kinds.some((item) => item.id === current) ? current : data.pick))
      })
      .catch(() => onMore())
  }, [onMore])
  useEffect(look, [look])

  if (!info) return null
  const who = info.kinds.find((item) => item.id === kind) ?? info.kinds[0]

  const nextKind = () => {
    const at = info.kinds.findIndex((item) => item.id === who?.id)
    setKind(info.kinds[(at + 1) % info.kinds.length].id)
  }

  const browse = async () => {
    const picked = await picker.browse({ start: dir ?? info.parent })
    if (picked?.[0]) setDir(picked[0])
  }

  const start = async () => {
    if (!text.trim() || busy) return
    setBusy(true)
    setProblem("")
    try {
      const result = await api<{ project: string }>("/api/v1/first", {
        method: "POST",
        body: JSON.stringify({ as: "human", text: text.trim(), kind: who?.id, ...(dir ? { dir } : {}) }),
      })
      onStarted(result.project)
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "没准备好，再点一次「开始」试试")
    } finally {
      setBusy(false)
    }
  }

  const where = dir ? (
    <>
      <span className="break-all text-foreground">{dir}</span>（用这个已有的文件夹）
    </>
  ) : (
    <>
      <span className="text-foreground">
        {info.parentLabel} / {folderNameOf(text)}
      </span>
      （自动新建这个文件夹）
    </>
  )

  return (
    <div className="relative flex min-h-dvh flex-col items-center justify-center px-4" data-first-open>
      <Button type="button" variant="ghost" size="sm" className="absolute top-3 right-3" onClick={onMore}>
        <Settings2 className="size-4" />
        更多设置
      </Button>
      <div className="frost w-full max-w-xl rounded-3xl px-6 py-7 sm:px-8">
        <h1 className="text-2xl font-semibold tracking-tight">你想做点什么？</h1>
        {who ? (
          <>
            <Textarea
              value={text}
              autoFocus
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void start()
              }}
              rows={3}
              placeholder="比如：给我的小店做一个网站，要有商品列表和购物车"
              className="mt-5 resize-none text-base"
              aria-label="想做什么"
            />
            <dl className="mt-4 grid grid-cols-[auto_1fr_auto] items-baseline gap-x-3 gap-y-2 text-sm text-muted-foreground">
              <dt>谁来做</dt>
              <dd>
                <span className="text-foreground">{who.label}</span>（这台电脑上已经装好）
              </dd>
              <dd>
                {info.kinds.length > 1 ? (
                  <button type="button" className="text-primary hover:underline" onClick={nextKind}>
                    换一个
                  </button>
                ) : null}
              </dd>
              <dt>放在哪</dt>
              <dd className="min-w-0">{where}</dd>
              <dd>
                <button type="button" className="text-primary hover:underline disabled:opacity-50" disabled={picker.browsing} onClick={() => void browse()}>
                  {picker.browsing ? "选择中…" : "换一个"}
                </button>
              </dd>
            </dl>
            {problem ? (
              <p role="alert" className="mt-4 text-sm leading-6 text-destructive">
                {problem}
              </p>
            ) : null}
            <Button type="button" size="lg" className="mt-5 w-full" disabled={!text.trim() || busy} onClick={() => void start()}>
              {busy ? <Loader2 className="animate-spin" /> : <ArrowRight />}
              {busy ? "正在准备…" : "开始"}
            </Button>
          </>
        ) : (
          <div className="mt-5 space-y-3 text-sm leading-6">
            <p className="text-base">这台电脑上还没装能用的 AI。</p>
            {info.install ? (
              <p className="text-muted-foreground">
                最省事的是装 {info.install.label}：{info.install.text}。
                <a className="ml-1 text-primary hover:underline" href={info.install.url} target="_blank" rel="noreferrer">
                  怎么装
                </a>
              </p>
            ) : null}
            <Button type="button" variant="outline" onClick={look}>
              装好了，再看一次
            </Button>
          </div>
        )}
      </div>
      {picker.dialog}
    </div>
  )
}
