"use client"

import { useEffect, useState } from "react"

import { api } from "@/components/room/api"
import { Button } from "@/components/ui/button"
import { DialogFooter } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

// The tour's first step (and the settings menu's 「你的名字」 dialog) asks
// what the user goes by: the same name in every project, told to agents when
// they sit down and when they are woken.
export function NameField({
  onNext,
  label = "先告诉我，你叫什么名字？",
  submitLabel = "开始",
  hint = "AI 会这样称呼你，房间里你说的话也署这个名字。以后可以再改。",
  onCancel,
  className = "mt-4",
}: {
  onNext: (changed?: boolean) => void
  label?: string
  submitLabel?: string
  hint?: string
  onCancel?: () => void
  className?: string
}) {
  const [name, setName] = useState("")
  const [saved, setSaved] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  useEffect(() => {
    let live = true
    api<{ name: string }>("/api/v1/user")
      .then((data) => {
        if (!live) return
        setSaved(data.name)
        setName((typed) => typed || data.name)
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [])

  const submit = async () => {
    const next = name.trim()
    if (!next) return setError("写一个名字，AI 会这样叫你")
    if (next === saved) return onNext(false)
    setBusy(true)
    setError("")
    try {
      await api("/api/v1/user", { method: "POST", body: JSON.stringify({ as: "human", name: next }) })
      setSaved(next)
      onNext(true)
    } catch (failed) {
      setError(failed instanceof Error ? failed.message : "没存上，再试一次")
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      className={className}
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <Label htmlFor="tour-name" className="text-xs font-medium">
        {label}
      </Label>
      <div className="mt-1.5 flex gap-2">
        <Input
          id="tour-name"
          autoFocus
          maxLength={24}
          value={name}
          placeholder="比如 小明"
          onChange={(event) => {
            setName(event.target.value)
            setError("")
          }}
        />
        {!onCancel ? (
          <Button type="submit" size="sm" className="h-8 shrink-0" disabled={busy}>
            {submitLabel}
          </Button>
        ) : null}
      </div>
      {error || hint ? (
        <p className={`mt-1.5 text-xs ${error ? "text-destructive" : "text-muted-foreground"}`}>{error || hint}</p>
      ) : null}
      {onCancel ? (
        <DialogFooter className="mt-4">
          <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>
            取消
          </Button>
          <Button type="submit" disabled={busy || !name.trim()}>
            {submitLabel}
          </Button>
        </DialogFooter>
      ) : null}
    </form>
  )
}
