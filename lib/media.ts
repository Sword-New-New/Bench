// What the page can show inline, told by the file's extension: pictures it
// opens over the page, video and sound it plays in place. Shared by the room (which
// serves them back) and the page (which picks the player). A new kind of
// media is a table here plus its player in components/room/attachments.tsx.

export const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".avif": "image/avif",
}

// Only what browsers play themselves: no .mkv, .avi or .wmv.
export const VIDEO_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".ogv": "video/ogg",
}

export const AUDIO_TYPES: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".opus": "audio/ogg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".weba": "audio/webm",
}

function extension(file: string) {
  const base = file.split(/[\\/]/).pop() ?? ""
  const dot = base.lastIndexOf(".")
  return dot > 0 ? base.slice(dot).toLowerCase() : ""
}

export function mediaKind(file: string): "image" | "video" | "audio" | undefined {
  const ext = extension(file)
  if (ext in IMAGE_TYPES) return "image"
  if (ext in VIDEO_TYPES) return "video"
  if (ext in AUDIO_TYPES) return "audio"
  return undefined
}

export function mediaType(file: string): string | undefined {
  const ext = extension(file)
  return IMAGE_TYPES[ext] ?? VIDEO_TYPES[ext] ?? AUDIO_TYPES[ext]
}
