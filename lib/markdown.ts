// The Markdown agents write, read into a small tree the page draws
// (components/room/bits.tsx MessageBody). Only what shows up in chat: fenced
// code, headings, lists (nested by indent), quotes, tables, rules and
// paragraphs; inline code, bold, italic, strikethrough and links. A single
// line break stays a line break, as in a chat. Nothing here outputs HTML, so
// a message can't inject any; what isn't recognised stays as plain text.

export type Inline =
  | { t: "text"; v: string }
  | { t: "code"; v: string }
  | { t: "strong" | "em" | "del"; c: Inline[] }
  | { t: "link"; href: string; c: Inline[] }

export type Align = "left" | "center" | "right" | null

export type Block =
  | { t: "para"; text: string }
  | { t: "heading"; level: number; text: string }
  | { t: "code"; lang: string; text: string }
  | { t: "hr" }
  | { t: "quote"; c: Block[] }
  | { t: "list"; ordered: boolean; start: number; items: Block[][] }
  | { t: "table"; align: Align[]; head: string[]; rows: string[][] }

const FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*([\w+#.-]*)[^\n]*$/
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/
const QUOTE = /^ {0,3}>[ \t]?/
const ITEM = /^( {0,3})([-*+]|\d{1,9}[.)])([ \t]+|$)(.*)$/
const TABLE_RULE = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/

function cells(line: string) {
  let row = line.trim()
  if (row.startsWith("|")) row = row.slice(1)
  if (row.endsWith("|") && !row.endsWith("\\|")) row = row.slice(0, -1)
  // Split on | not inside `code` and not escaped.
  const out: string[] = []
  let cell = ""
  let inCode = false
  for (let i = 0; i < row.length; i++) {
    const ch = row[i]
    if (ch === "\\" && row[i + 1] === "|") {
      cell += "|"
      i++
    } else if (ch === "`") {
      inCode = !inCode
      cell += ch
    } else if (ch === "|" && !inCode) {
      out.push(cell.trim())
      cell = ""
    } else cell += ch
  }
  out.push(cell.trim())
  return out
}

function isTableStart(lines: string[], i: number) {
  return lines[i].includes("|") && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1]) && lines[i + 1].includes("|")
}

// Whether a line starts some block other than a paragraph (it ends a paragraph).
function opensBlock(lines: string[], i: number) {
  const line = lines[i]
  return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || ITEM.test(line) || isTableStart(lines, i)
}

function indentOf(line: string) {
  return line.length - line.replace(/^[ \t]+/, "").length
}

export function parseMarkdown(text: string): Block[] {
  return blocks(text.replace(/\r\n?/g, "\n").split("\n"))
}

function blocks(lines: string[]): Block[] {
  const out: Block[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) {
      i++
      continue
    }

    const fence = FENCE.exec(line)
    if (fence) {
      const mark = fence[1]
      const end = lines.findIndex((other, index) => index > i && other.trim().startsWith(mark[0].repeat(mark.length)) && /^[`~]+$/.test(other.trim()))
      // An unclosed fence is just text.
      if (end > i) {
        const indent = indentOf(line)
        out.push({
          t: "code",
          lang: fence[2].toLowerCase(),
          text: lines
            .slice(i + 1, end)
            .map((body) => body.slice(Math.min(indent, indentOf(body))))
            .join("\n"),
        })
        i = end + 1
        continue
      }
    }

    const heading = HEADING.exec(line)
    if (heading) {
      out.push({ t: "heading", level: heading[1].length, text: heading[2] })
      i++
      continue
    }

    if (RULE.test(line)) {
      out.push({ t: "hr" })
      i++
      continue
    }

    if (QUOTE.test(line)) {
      const inner: string[] = []
      while (i < lines.length && lines[i].trim() && QUOTE.test(lines[i])) {
        inner.push(lines[i].replace(QUOTE, ""))
        i++
      }
      out.push({ t: "quote", c: blocks(inner) })
      continue
    }

    if (isTableStart(lines, i)) {
      const head = cells(line)
      const align = cells(lines[i + 1]).map((rule): Align => {
        const left = rule.startsWith(":")
        const right = rule.endsWith(":")
        return left && right ? "center" : right ? "right" : left ? "left" : null
      })
      i += 2
      const rows: string[][] = []
      while (i < lines.length && lines[i].trim() && lines[i].includes("|")) {
        rows.push(cells(lines[i]))
        i++
      }
      out.push({ t: "table", align, head, rows })
      continue
    }

    const item = ITEM.exec(line)
    if (item) {
      const ordered = /\d/.test(item[2])
      const base = item[1].length
      const items: string[][] = []
      let current: string[] = []
      let contentIndent = base + item[2].length + Math.max(1, item[3].length)
      let blank = false
      while (i < lines.length) {
        const here = lines[i]
        const next = ITEM.exec(here)
        if (!here.trim()) {
          blank = true
          current.push("")
          i++
          continue
        }
        if (next && next[1].length <= base + 1 && /\d/.test(next[2]) === ordered) {
          if (current.length) items.push(current)
          current = [next[4]]
          contentIndent = next[1].length + next[2].length + Math.max(1, next[3].length)
          blank = false
          i++
          continue
        }
        if (indentOf(here) >= Math.min(contentIndent, base + 2)) {
          current.push(here.slice(Math.min(contentIndent, indentOf(here))))
          blank = false
          i++
          continue
        }
        // A line that isn't indented: after a blank line, or when it starts
        // something else, the list is over; otherwise it carries on the item.
        if (blank || opensBlock(lines, i)) break
        current.push(here.trim())
        i++
      }
      if (current.length) items.push(current)
      out.push({
        t: "list",
        ordered,
        start: ordered ? Number.parseInt(item[2], 10) || 1 : 1,
        items: items.map((body) => blocks(body)),
      })
      continue
    }

    const para: string[] = []
    while (i < lines.length && lines[i].trim() && (para.length === 0 || !opensBlock(lines, i))) {
      para.push(lines[i])
      i++
    }
    out.push({ t: "para", text: para.join("\n") })
  }
  return out
}

// ---- inline

const INLINE: { kind: "esc" | "code" | "strong" | "em" | "del" | "link" | "auto"; re: RegExp }[] = [
  { kind: "esc", re: /\\([\\`*_{}[\]()#+\-.!|~>])/ },
  { kind: "code", re: /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/ },
  { kind: "link", re: /\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/ },
  { kind: "auto", re: /<?(https?:\/\/[\x21-\x7e]*[\w/#=&%~+-])>?/ },
  { kind: "strong", re: /\*\*(?=\S)([\s\S]*?\S)\*\*|(?<![\p{L}\p{N}_])__(?=\S)([\s\S]*?\S)__(?![\p{L}\p{N}_])/u },
  { kind: "del", re: /~~(?=\S)([\s\S]*?\S)~~/ },
  { kind: "em", re: /(?<![*\p{L}\p{N}])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?!\*)|(?<![\p{L}\p{N}_])_(?=\S)([^_\n]*?\S)_(?![\p{L}\p{N}_])/u },
]

export function parseInline(text: string): Inline[] {
  const out: Inline[] = []
  let rest = text
  while (rest) {
    let best: { kind: (typeof INLINE)[number]["kind"]; match: RegExpExecArray } | null = null
    for (const rule of INLINE) {
      const match = rule.re.exec(rest)
      if (match && (!best || match.index < best.match.index)) best = { kind: rule.kind, match }
    }
    if (!best) {
      push(out, rest)
      break
    }
    const { kind, match } = best
    if (match.index > 0) push(out, rest.slice(0, match.index))
    if (kind === "esc") push(out, match[1])
    else if (kind === "code") out.push({ t: "code", v: match[2].replace(/^ (.*) $/, "$1") })
    else if (kind === "link") out.push({ t: "link", href: match[2], c: parseInline(match[1]) })
    else if (kind === "auto") out.push({ t: "link", href: match[1], c: [{ t: "text", v: match[1] }] })
    else out.push({ t: kind, c: parseInline(match[1] ?? match[2]) })
    rest = rest.slice(match.index + match[0].length)
  }
  return out
}

function push(out: Inline[], text: string) {
  const value = text
  const last = out[out.length - 1]
  if (last?.t === "text") last.v += value
  else out.push({ t: "text", v: value })
}

// Links the page may open: the web and mail. Others (file://, javascript:)
// are shown as text.
export function safeHref(href: string) {
  return /^(https?:\/\/|mailto:)/i.test(href) ? href : null
}

// ---- things in a message the page can open: a message or task id, a commit,
// a file (with a line). Found in plain text, in `code` that is nothing but
// one of them, and in links to file:// or a path.

export type Ref =
  | { kind: "message" | "task"; id: string }
  | { kind: "commit"; hash: string }
  | { kind: "file"; path: string; line?: number }

const SEG = "[\\p{L}\\p{N}_.@+-]+"
const LINE = "(?::(\\d+)(?:[:-]\\d+)?|#L(\\d+)(?:-L?\\d+)?)?"
const REFS: { kind: "id" | "commit" | "abs" | "rel"; re: RegExp }[] = [
  { kind: "id", re: /(?<![A-Za-z0-9_])([mt])_[0-9a-f]{8}(?![A-Za-z0-9_])/ },
  // Absolute paths only under the usual roots, so an API route like
  // /api/v1/quota isn't taken for a file.
  { kind: "abs", re: new RegExp(`(?<![\\p{L}\\p{N}_./-])((?:~|/(?:home|tmp|media|mnt|opt|usr|etc|var|srv|root))(?:/${SEG})+)${LINE}(?![\\p{L}\\p{N}_/])`, "u") },
  // Relative: at least one folder and a file extension (lib/quota.ts:12).
  { kind: "rel", re: new RegExp(`(?<![\\p{L}\\p{N}_./~-])((?:${SEG}/)+[\\p{L}\\p{N}_@+-][\\p{L}\\p{N}_.@+-]*\\.[A-Za-z][A-Za-z0-9]{0,7})${LINE}(?![A-Za-z0-9_/])`, "u") },
  { kind: "commit", re: /(?<![A-Za-z0-9_\-./])(?=[0-9a-f]*[a-f])(?=[0-9a-f]*[0-9])[0-9a-f]{7,40}(?![A-Za-z0-9_\-])/ },
]

function refFrom(kind: (typeof REFS)[number]["kind"], match: RegExpExecArray): Ref {
  if (kind === "id") return { kind: match[1] === "m" ? "message" : "task", id: match[0] }
  if (kind === "commit") return { kind: "commit", hash: match[0] }
  const line = Number(match[2] ?? match[3])
  return { kind: "file", path: match[1].replace(/\.$/, ""), ...(line > 0 ? { line } : {}) }
}

export function splitRefs(text: string): { text: string; ref?: Ref }[] {
  const out: { text: string; ref?: Ref }[] = []
  let rest = text
  while (rest) {
    let best: { kind: (typeof REFS)[number]["kind"]; match: RegExpExecArray } | null = null
    for (const rule of REFS) {
      const match = rule.re.exec(rest)
      if (match && (!best || match.index < best.match.index)) best = { kind: rule.kind, match }
    }
    if (!best) {
      out.push({ text: rest })
      break
    }
    const { kind, match } = best
    let whole = match[0]
    // A sentence's full stop after a path isn't part of it.
    if ((kind === "abs" || kind === "rel") && whole.endsWith(".")) whole = whole.slice(0, -1)
    if (match.index > 0) out.push({ text: rest.slice(0, match.index) })
    out.push({ text: whole, ref: refFrom(kind, match) })
    rest = rest.slice(match.index + whole.length)
  }
  return out
}

// The whole string is one ref (for `code` spans), or null.
export function refOf(text: string): Ref | null {
  const parts = splitRefs(text.trim())
  return parts.length === 1 && parts[0].ref ? parts[0].ref : null
}

// A link's target when it points at a file: file:///path#L12 (Antigravity
// writes these) or a bare path.
export function fileTarget(href: string): Ref | null {
  let target = href
  if (/^file:\/\//i.test(target)) {
    target = target.replace(/^file:\/\//i, "")
    try {
      target = decodeURIComponent(target)
    } catch {}
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return null
  const [file, hash = ""] = target.split("#")
  if (!file) return null
  const line = Number(/^L(\d+)/.exec(hash)?.[1] ?? /:(\d+)(?::\d+)?$/.exec(file)?.[1])
  const path = file.replace(/:(\d+)(?::\d+)?$/, "")
  return { kind: "file", path, ...(line > 0 ? { line } : {}) }
}
