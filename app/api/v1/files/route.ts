import { randomBytes } from "node:crypto"
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"

import { boot } from "@/lib/boot"
import { ApiError, asRecord, asString, handle, json, readBody } from "@/lib/http"
import { inRequest, snapshot } from "@/lib/store"

// Things pasted or dropped into the composer. The page can't hand over a
// path for those, so the room keeps a copy under data/uploads and the message
// carries that path. GET serves a message's images back to the page.

const UPLOAD_LIMIT = 25 * 1024 * 1024
const TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".avif": "image/avif",
}

function uploadsDir() {
  return path.join(process.cwd(), "data", "uploads")
}

// Keep the name readable but safe as one path segment.
function safeName(name: string) {
  const clean = path.basename(name).replace(/[\0/\\]/g, "").replace(/^\.+/, "").slice(-120)
  return clean || "粘贴的文件"
}

export async function POST(request: Request) {
  try {
    await boot()
    const body = asRecord(await readBody(request))
    if (body.as !== "human") throw new ApiError(400, "只有这台电脑上的人能传文件")
    const data = asString(body.data)
    if (!data) throw new ApiError(400, "文件是空的")
    const bytes = Buffer.from(data, "base64")
    if (bytes.length > UPLOAD_LIMIT) throw new ApiError(413, "文件太大了，超过 25 MB 的请用回形针从磁盘选，房间只传路径")
    const type = asString(body.type) ?? ""
    const name = safeName(asString(body.name) ?? "")
    const day = new Date().toISOString().slice(0, 10)
    const dir = path.join(uploadsDir(), day)
    mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `${randomBytes(3).toString("hex")}-${name}`)
    writeFileSync(file, bytes)
    const image = type.startsWith("image/") || path.extname(name).toLowerCase() in TYPES
    return json({ attachment: { kind: image ? "image" : "file", name, path: file, size: bytes.length } }, 201)
  } catch (error) {
    return handle(error)
  }
}

// Only images that are in the room: saved uploads, or ones a message in this
// project points at.
export async function GET(request: Request) {
  try {
    await boot()
    const url = new URL(request.url)
    const file = path.resolve(url.searchParams.get("path") ?? "")
    const type = TYPES[path.extname(file).toLowerCase()]
    if (!type) throw new ApiError(404, "只能看图片")
    const inUploads = file.startsWith(uploadsDir() + path.sep)
    const attached =
      inUploads ||
      inRequest({ project: url.searchParams.get("project") ?? undefined }, () =>
        snapshot().messages.some((message) => message.attachments?.some((item) => item.path === file)),
      )
    if (!attached) throw new ApiError(404, "房间里没有这张图")
    if (!statSync(file, { throwIfNoEntry: false })?.isFile()) throw new ApiError(404, "图片不在了")
    return new Response(readFileSync(file), {
      headers: {
        "content-type": type, "cache-control": "private, max-age=86400", "x-content-type-options": "nosniff",
        "content-security-policy": "sandbox",
        // 「保存」 in the image viewer asks for it as a file.
        ...(url.searchParams.has("download")
          ? { "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(file))}` }
          : {}),
      },
    })
  } catch (error) {
    return handle(error)
  }
}
