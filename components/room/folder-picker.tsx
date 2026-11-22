"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ArrowUp, Check, ChevronRight, File, Folder, FolderOpen, HardDrive, Home, Loader2, Search } from "lucide-react"
import { toast } from "sonner"

import { api, ApiResponseError } from "@/components/room/api"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"

export type PickKind = "dir" | "dirs" | "files"

type ListEntry = {
  name: string
  path: string
  kind: "dir" | "file"
  size?: number
}

type ListResponse = {
  dir: string
  parent: string | null
  drives: string[]
  shortcuts: { label: string; path: string }[]
  entries: ListEntry[]
  truncated: boolean
}

type FallbackRequest = {
  pick: PickKind
  start: string
  reason: string
}

const TITLES: Record<PickKind, string> = {
  dir: "选项目目录",
  dirs: "选要发的文件夹",
  files: "选要发的文件",
}

function formatSize(bytes?: number) {
  if (bytes === undefined) return ""
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

// In-page directory/file browser shown when the server cannot open an OS
// desktop dialog (e.g. isolated Win32 desktop, headless Linux, missing zenity).
function FolderPickerDialog({
  request,
  onPick,
  onCancel,
}: {
  request: FallbackRequest | null
  onPick: (paths: string[]) => void
  onCancel: () => void
}) {
  const [data, setData] = useState<ListResponse | null>(null)
  const [typedPath, setTypedPath] = useState("")
  const [filter, setFilter] = useState("")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [shown, setShown] = useState<FallbackRequest | null>(null)
  const loadAbortRef = useRef<AbortController | null>(null)
  const reqIdRef = useRef(0)

  if (request !== shown) {
    setShown(request)
    if (request) {
      setData(null)
      setTypedPath(request.start)
      setFilter("")
      setLoading(true)
      setError(null)
      setSelected([])
    }
  }

  const loadDir = useCallback(
    (opts: { path?: string; start?: string; query?: string; keepSelection?: boolean }) => {
      if (!request) return
      loadAbortRef.current?.abort()
      const controller = new AbortController()
      loadAbortRef.current = controller
      const id = ++reqIdRef.current
      setLoading(true)
      setError(null)
      if (!opts.keepSelection) setSelected([])
      api<ListResponse>("/api/v1/folder", {
        method: "POST",
        signal: controller.signal,
        body: JSON.stringify({
          as: "human",
          action: "list",
          includeFiles: request.pick === "files",
          ...(opts.path ? { path: opts.path } : { start: opts.start ?? "" }),
          ...(opts.query ? { query: opts.query } : {}),
        }),
      })
        .then((res) => {
          if (reqIdRef.current !== id) return
          setData(res)
          setTypedPath(res.dir)
          setFilter(opts.query ?? "")
        })
        .catch((err: unknown) => {
          if (controller.signal.aborted || reqIdRef.current !== id) return
          setError(err instanceof Error ? err.message : "读取目录失败")
        })
        .finally(() => {
          if (reqIdRef.current === id) setLoading(false)
        })
    },
    [request],
  )

  useEffect(() => {
    if (!request) {
      loadAbortRef.current?.abort()
      return
    }
    const controller = new AbortController()
    loadAbortRef.current?.abort()
    loadAbortRef.current = controller
    const id = ++reqIdRef.current
    api<ListResponse>("/api/v1/folder", {
      method: "POST",
      signal: controller.signal,
      body: JSON.stringify({
        as: "human",
        action: "list",
        includeFiles: request.pick === "files",
        start: request.start,
      }),
    })
      .then((res) => {
        if (reqIdRef.current !== id) return
        setData(res)
        setTypedPath(res.dir)
        setFilter("")
        setError(null)
        setSelected([])
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted || reqIdRef.current !== id) return
        setError(err instanceof Error ? err.message : "读取目录失败")
      })
      .finally(() => {
        if (reqIdRef.current === id) setLoading(false)
      })
    return () => controller.abort()
  }, [request])

  const shownEntries = useMemo(() => {
    if (!data) return []
    const q = filter.trim().toLowerCase()
    if (!q || data.truncated) return data.entries
    return data.entries.filter((item) => item.name.toLowerCase().includes(q))
  }, [data, filter])

  const toggleSelect = (target: string) => {
    setSelected((prev) => (prev.includes(target) ? prev.filter((item) => item !== target) : [...prev, target]))
  }

  const pickMode = request?.pick ?? "dir"
  const canConfirm =
    Boolean(data?.dir) &&
    !loading &&
    (pickMode === "files" ? selected.length > 0 : true)

  const confirm = () => {
    if (!data?.dir) return
    if (pickMode === "dir") {
      onPick([data.dir])
      return
    }
    if (pickMode === "dirs") {
      onPick(selected.length > 0 ? selected : [data.dir])
      return
    }
    if (selected.length > 0) onPick(selected)
  }

  return (
    <Dialog open={request !== null} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col gap-3 sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FolderOpen className="size-4 text-muted-foreground" />
            <span>{TITLES[pickMode]}</span>
          </DialogTitle>
          <DialogDescription>{request?.reason || "选择此电脑上的目录。"}</DialogDescription>
        </DialogHeader>

        {data ? (
          <div className="flex flex-wrap items-center gap-1.5">
            {data.shortcuts.map((item) => (
              <Button
                key={item.path}
                type="button"
                variant={data.dir === item.path ? "secondary" : "outline"}
                size="xs"
                onClick={() => loadDir({ path: item.path })}
              >
                <Home className="size-3" />
                {item.label}
              </Button>
            ))}
            {data.drives.map((drive) => (
              <Button
                key={drive}
                type="button"
                variant={data.dir.toLowerCase().startsWith(drive.toLowerCase()) ? "secondary" : "outline"}
                size="xs"
                onClick={() => loadDir({ path: drive })}
              >
                <HardDrive className="size-3" />
                {drive.replace(/\\$/, "")}
              </Button>
            ))}
          </div>
        ) : null}

        <form
          className="flex items-center gap-1.5"
          onSubmit={(event) => {
            event.preventDefault()
            if (typedPath.trim()) loadDir({ path: typedPath.trim() })
          }}
        >
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            disabled={!data?.parent || loading}
            title="上一级目录"
            aria-label="上一级目录"
            onClick={() => data?.parent && loadDir({ path: data.parent })}
          >
            <ArrowUp className="size-3.5" />
          </Button>
          <Input
            value={typedPath}
            onChange={(event) => setTypedPath(event.target.value)}
            placeholder="输入完整路径回车跳转…"
            aria-label="当前路径"
            className="min-w-0 flex-1 font-mono text-xs"
          />
          <Button type="submit" variant="outline" size="sm" disabled={!typedPath.trim() || loading}>
            前往
          </Button>
        </form>

        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={filter}
            onChange={(event) => {
              const next = event.target.value
              setFilter(next)
              if (data?.truncated) loadDir({ path: data.dir, query: next.trim(), keepSelection: true })
            }}
            placeholder={data?.truncated ? "目录项较多，输入关键词筛选…" : "过滤当前目录…"}
            aria-label="过滤目录内容"
            className="h-8 pl-8 text-xs"
          />
        </div>

        {error ? (
          <p className="rounded-lg bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive">{error}</p>
        ) : null}

        <div className="min-h-56 max-h-72 overflow-y-auto rounded-lg border bg-background/50 p-1">
          {loading && !data ? (
            <div className="flex h-48 items-center justify-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              读取目录中…
            </div>
          ) : shownEntries.length === 0 ? (
            <div className="flex h-48 items-center justify-center text-xs text-muted-foreground">
              {filter.trim() ? "没有匹配的项目" : pickMode === "files" ? "此目录为空" : "此目录下没有子文件夹"}
            </div>
          ) : (
            <div className="space-y-0.5">
              {shownEntries.map((entry) => {
                const isDir = entry.kind === "dir"
                const selectable = (pickMode === "dirs" && isDir) || (pickMode === "files" && !isDir)
                const checked = selected.includes(entry.path)
                return (
                  <div
                    key={entry.path}
                    className={`flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs transition-colors ${
                      checked ? "bg-primary/10 text-foreground" : "hover:bg-muted/70"
                    }`}
                  >
                    {selectable ? (
                      <button
                        type="button"
                        role="checkbox"
                        aria-checked={checked}
                        aria-label={`勾选 ${entry.name}`}
                        className={`grid size-4 shrink-0 place-items-center rounded border ${
                          checked ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/40"
                        }`}
                        onClick={() => toggleSelect(entry.path)}
                      >
                        {checked ? <Check className="size-3" /> : null}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 items-center gap-2 text-left"
                      onClick={() => {
                        if (isDir) {
                          loadDir({ path: entry.path })
                        } else if (selectable) {
                          toggleSelect(entry.path)
                        }
                      }}
                    >
                      {isDir ? (
                        <Folder className="size-3.5 shrink-0 text-amber-500/85" />
                      ) : (
                        <File className="size-3.5 shrink-0 text-muted-foreground" />
                      )}
                      <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                      {entry.size !== undefined ? (
                        <span className="shrink-0 text-[0.6875rem] text-muted-foreground">{formatSize(entry.size)}</span>
                      ) : isDir ? (
                        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/60" />
                      ) : null}
                    </button>
                  </div>
                )
              })}
              {data?.truncated ? (
                <p className="px-2 py-1 text-[0.6875rem] text-muted-foreground">只显示前 500 项，可用上方搜索框筛选。</p>
              ) : null}
            </div>
          )}
        </div>

        <DialogFooter className="items-center gap-2 sm:justify-between">
          <span className="min-w-0 truncate font-mono text-[0.6875rem] text-muted-foreground" title={data?.dir ?? ""}>
            {data?.dir ?? ""}
          </span>
          <div className="flex shrink-0 items-center gap-2">
            <Button type="button" variant="ghost" onClick={onCancel}>
              取消
            </Button>
            <Button type="button" disabled={!canConfirm} onClick={confirm}>
              {pickMode === "files"
                ? `选择文件 (${selected.length})`
                : pickMode === "dirs" && selected.length > 0
                  ? `选择已勾选 (${selected.length})`
                  : "选择当前目录"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function usePathPicker(active = true) {
  const [browsing, setBrowsing] = useState(false)
  const [fallback, setFallback] = useState<FallbackRequest | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const resolverRef = useRef<((value: string[] | null) => void) | null>(null)

  const settleFallback = useCallback((value: string[] | null) => {
    setFallback(null)
    const resolve = resolverRef.current
    resolverRef.current = null
    resolve?.(value)
  }, [])

  // Reset UI state synchronously when parent dialog closes so reopening never
  // shows a stale "选择中…" spinner.
  if (!active && (browsing || fallback !== null)) {
    setBrowsing(false)
    setFallback(null)
  }

  useEffect(() => {
    if (active) return
    abortRef.current?.abort()
    abortRef.current = null
    const resolve = resolverRef.current
    resolverRef.current = null
    resolve?.(null)
  }, [active])

  useEffect(() => {
    return () => {
      abortRef.current?.abort()
      abortRef.current = null
      const resolve = resolverRef.current
      resolverRef.current = null
      resolve?.(null)
    }
  }, [])

  const browse = useCallback(async ({ pick = "dir", start = "" }: { pick?: PickKind; start?: string } = {}): Promise<string[] | null> => {
    if (abortRef.current || resolverRef.current) return null
    const controller = new AbortController()
    abortRef.current = controller
    setBrowsing(true)
    try {
      if (pick === "dir") {
        const result = await api<{ dir: string | null }>("/api/v1/folder", {
          method: "POST",
          signal: controller.signal,
          body: JSON.stringify({ as: "human", start }),
        })
        return result.dir ? [result.dir] : null
      }
      const result = await api<{ paths: string[] }>("/api/v1/folder", {
        method: "POST",
        signal: controller.signal,
        body: JSON.stringify({ as: "human", pick, start }),
      })
      return result.paths.length > 0 ? result.paths : null
    } catch (error) {
      if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
        return null
      }
      if (error instanceof ApiResponseError && (error.fallback || error.status === 501)) {
        abortRef.current = null
        setBrowsing(false)
        return await new Promise<string[] | null>((resolve) => {
          resolverRef.current = resolve
          setFallback({ pick, start, reason: error.message })
        })
      }
      toast.error(error instanceof Error ? error.message : "打开目录选择失败")
      return null
    } finally {
      if (abortRef.current === controller) abortRef.current = null
      setBrowsing(false)
    }
  }, [])

  const dialog = (
    <FolderPickerDialog
      request={active ? fallback : null}
      onPick={(paths) => settleFallback(paths)}
      onCancel={() => settleFallback(null)}
    />
  )

  return { browsing, browse, dialog }
}
