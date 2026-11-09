"use client"

import { useEffect, useState } from "react"

import { api } from "@/components/room/api"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

// The tour's first step asks what the user goes by. It is the one thing the
// tour saves: the name is a setting, the same in every project, and agents
// are told it when they sit down and when they are woken.
export function NameField({ onNext }: { onNext: () => void }) {
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
    if (next === saved) return onNext()
    setBusy(true)
    setError("")
    try {
      await api("/api/v1/user", { method: "POST", body: JSON.stringify({ as: "human", name: next }) })
      setSaved(next)
      onNext()
    } catch (failed) {
      setError(failed instanceof Error ? failed.message : "没存上，再试一次")
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      className="mt-4"
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <label htmlFor="tour-name" className="text-xs font-medium">
        先告诉我，你叫什么名字？
      </label>
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
        <Button type="submit" size="sm" className="h-8 shrink-0" disabled={busy}>
          开始
        </Button>
      </div>
      <p className={`mt-1.5 text-xs ${error ? "text-destructive" : "text-muted-foreground"}`}>
        {error || "AI 会这样称呼你，房间里你说的话也署这个名字。以后可以再改。"}
      </p>
    </form>
  )
}
