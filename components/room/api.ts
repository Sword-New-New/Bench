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

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const read = !init?.method || init.method === "GET"
  const res = await fetch(read ? inOpenProject(path) : path, {
    ...init,
    body: withProject(init?.body),
    cache: "no-store",
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
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
