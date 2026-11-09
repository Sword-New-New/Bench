import { HUMAN_HEADER, isHumanKey } from "@/lib/human"

export class ApiError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export function json(data: unknown, status = 200) {
  return Response.json(data, { status })
}

export function fail(message: string, status: number) {
  return json({ error: message }, status)
}

export function handle(error: unknown) {
  if (error instanceof ApiError) return fail(error.message, error.status)
  console.error(error)
  return fail("房间内部出错了", 500)
}

// The room runs shell commands from agents.json and on every mention, so a web
// page in some other tab must not be able to post here. Requiring a JSON
// content type forces a CORS preflight the room never answers, and a browser
// Origin from another host is turned away outright.
function guard(request: Request) {
  const type = request.headers.get("content-type") ?? ""
  if (!/^application\/json\b/i.test(type.trim())) {
    throw new ApiError(415, "请求要带 content-type: application/json")
  }
  const origin = request.headers.get("origin")
  if (!origin || origin === "null") return
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host")
  let from = ""
  try {
    from = new URL(origin).host
  } catch {}
  if (!host || from !== host) throw new ApiError(403, "只接受这台电脑上房间页面发来的请求")
}

export async function readBody(request: Request): Promise<unknown> {
  guard(request)
  let body: unknown
  try {
    body = await request.json()
  } catch {
    throw new ApiError(400, "需要 JSON 请求体")
  }
  // Speaking for the user takes the key only the room page has (lib/human.ts).
  if (typeof body === "object" && body !== null && (body as { as?: unknown }).as === "human") {
    if (!isHumanKey(request.headers.get(HUMAN_HEADER))) {
      throw new ApiError(403, "这个页面没有口令或口令不对：用 npm run open 或桌面上的「并坐」图标重新打开房间。agent 和脚本不能代用户操作")
    }
  }
  return body
}

export function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ApiError(400, "请求体要是一个 JSON 对象")
  }
  return value as Record<string, unknown>
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() : undefined
}
