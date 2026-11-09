import { randomBytes } from "node:crypto"
import { createReadStream, mkdirSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { Readable } from "node:stream"

import { boot } from "@/lib/boot"
import { ApiError, asRecord, asString, handle, json, readBody } from "@/lib/http"
import { mediaKind, mediaType } from "@/lib/media"
import { inRequest, snapshot } from "@/lib/store"

// Things pasted or dropped into the composer. The page can't hand over a
// path for those, so the room keeps a copy under data/uploads and the message
// carries that path. GET serves a message's images, videos and sounds back
// to the page; the players ask for byte ranges to seek.

const UPLOAD_LIMIT = 25 * 1024 * 1024

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
    const kind = mediaKind(name) ?? (type.startsWith("image/") ? "image" : "file")
    return json({ attachment: { kind, name, path: file, size: bytes.length } }, 201)
  } catch (error) {
    return handle(error)
  }
}

// Only media that is in the room: saved uploads, or files a message in this
// project points at.
export async function GET(request: Request) {
  try {
    await boot()
    const url = new URL(request.url)
    const file = path.resolve(url.searchParams.get("path") ?? "")
    const type = mediaType(file)
    if (!type) throw new ApiError(404, "只能看图片、视频和音频")
    const inUploads = file.startsWith(uploadsDir() + path.sep)
    const attached =
      inUploads ||
      inRequest({ project: url.searchParams.get("project") ?? undefined }, () =>
        snapshot().messages.some((message) => message.attachments?.some((item) => item.path === file)),
      )
    if (!attached) throw new ApiError(404, "房间里没有这个文件")
    const stat = statSync(file, { throwIfNoEntry: false })
    if (!stat?.isFile()) throw new ApiError(404, "文件不在了")
    const headers: Record<string, string> = {
      "content-type": type,
      "accept-ranges": "bytes",
      "cache-control": "private, max-age=86400",
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox",
      // 「保存」 asks for it as a file.
      ...(url.searchParams.has("download")
        ? { "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(file))}` }
        : {}),
    }
    // Players ask for a byte range to seek and to read ahead: bytes=a-b, a-
    // or -n (the last n). Anything else gets the whole file.
    const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("range") ?? "")
    if (range && (range[1] || range[2]) && stat.size > 0) {
      const last = stat.size - 1
      const start = range[1] ? Number(range[1]) : Math.max(0, stat.size - Number(range[2]))
      const end = range[1] && range[2] ? Math.min(Number(range[2]), last) : last
      if (start > last || start > end) {
        return new Response(null, { status: 416, headers: { ...headers, "content-range": `bytes */${stat.size}` } })
      }
      return new Response(body(file, start, end), {
        status: 206,
        headers: { ...headers, "content-range": `bytes ${start}-${end}/${stat.size}`, "content-length": String(end - start + 1) },
      })
    }
    return new Response(body(file, 0, Math.max(0, stat.size - 1)), {
      headers: { ...headers, "content-length": String(stat.size) },
    })
  } catch (error) {
    return handle(error)
  }
}

// Streamed, so a long video isn't read into memory for every range.
function body(file: string, start: number, end: number) {
  return Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream<Uint8Array>
}
