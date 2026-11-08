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

export async function readBody(request: Request): Promise<unknown> {
  try {
    return await request.json()
  } catch {
    throw new ApiError(400, "需要 JSON 请求体")
  }
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
