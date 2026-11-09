// The project the page has open. Every request carries it: a ?project= on
// reads, a `project` field in JSON bodies (unless the call names one itself).
let openProject: string | null = null

export function setOpenProject(id: string | null) {
  openProject = id
}

export function inOpenProject(path: string) {
  if (!openProject) return path
  return `${path}${path.includes("?") ? "&" : "?"}project=${encodeURIComponent(openProject)}`
}

function withProject(body: BodyInit | null | undefined) {
  if (!openProject || typeof body !== "string") return body
  try {
    const parsed: unknown = JSON.parse(body)
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) && !("project" in parsed)) {
      return JSON.stringify({ ...parsed, project: openProject })
    }
  } catch {}
  return body
}

// The key that makes a request the user's own (lib/human.ts). The page never
// carries it: it comes in once as ?key=… on the link the launchers open
// (scripts/open-room.mjs), is kept in this browser, and is taken out of the
// address bar. Sent on every request; the room only checks it where the body
// says as:"human".
const KEY_STORE = "bench-human-key"
let humanKey: string | undefined
export function storedHumanKey(): string {
  if (humanKey !== undefined) return humanKey
  if (typeof window === "undefined") return ""
  const url = new URL(window.location.href)
  const given = url.searchParams.get("key")
  if (given) {
    try {
      localStorage.setItem(KEY_STORE, given)
    } catch {}
    url.searchParams.delete("key")
    window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash)
    humanKey = given
    return humanKey
  }
  try {
    humanKey = localStorage.getItem(KEY_STORE) ?? ""
  } catch {
    humanKey = ""
  }
  return humanKey
}
function human(): Record<string, string> {
  const key = storedHumanKey()
  return key ? { "x-bench-human": key } : {}
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const read = !init?.method || init.method === "GET"
  const res = await fetch(read ? inOpenProject(path) : path, {
    ...init,
    body: withProject(init?.body),
    cache: "no-store",
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...human(),
      ...init?.headers,
    },
  })
  const data: unknown = await res.json().catch(() => ({}))
  if (!res.ok) {
    const message =
      typeof data === "object" &&
      data !== null &&
      "error" in data &&
      typeof data.error === "string"
        ? data.error
        : "房间没有接住这次请求"
    throw new Error(message)
  }
  return data as T
}

export type AdapterInfo = {
  name: string
  command: string
  reply: "stdout" | "none"
  installed: boolean
  // The model a wake runs on, when the command or the client's config says.
  model: string | null
}
