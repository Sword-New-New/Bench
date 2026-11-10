// Background worker that scans local session transcripts for token output speed
// and token usage across Claude Code, Codex, Antigravity, and DeepSeek Harness.
// Runs off the Next.js event loop so multi-GB histories never stall the room,
// and keeps an incremental byte-offset cache in data/speed-cache.json.

import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import { parentPort } from "node:worker_threads"
import zlib from "node:zlib"

const AGENTS = ["claude", "codex", "antigravity", "dsh"]
const AGENT_INDEX = { claude: 0, codex: 1, antigravity: 2, dsh: 3 }
const RANGES = { "1h": 3600, "24h": 86400, "7d": 7 * 86400, "30d": 30 * 86400, all: null }
const MIN_SUMMARY_TOKENS = 100
const SUMMARY_LAST = 30
const WIN_USERS = "/media/AverageJoe/系统1/Users"
const CACHE_VERSION = 2

const TS_RE = /"timestamp":"([^"]+)"/
const CWD_RE = /"cwd":"((?:[^"\\]|\\.)*)"/
const TTFT_RE = /"time_to_first_token_ms":(\d+)/

const CHUNK_SIZE = 512 * 1024
const sharedBuf = Buffer.allocUnsafe(CHUNK_SIZE)

const B_ASSISTANT = Buffer.from('"type":"assistant"')
const B_API_REQ = Buffer.from('"type":"api-request"')
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

// Compact stored tuple indices:
// [0:agent, 1:start, 2:end, 3:out, 4:model, 5:project, 6:reasoning, 7:ttft, 8:inp, 9:cread, 10:cwrite, 11?:dedupId]

function cachePath() {
  return path.join(process.cwd(), "data", "speed-cache.json")
}

function parseTs(iso) {
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? ms / 1000 : null
}

function projectName(cwd) {
  if (!cwd) return ""
  const trimmed = String(cwd).replace(/[\\/]+$/, "")
  const parts = trimmed.split(/[\\/]/)
  return parts[parts.length - 1] || trimmed
}

function homes() {
  const out = [{ dir: os.homedir(), tag: "" }]
  if (process.platform !== "win32" && fs.existsSync(WIN_USERS)) {
    try {
      for (const entry of fs.readdirSync(WIN_USERS, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isDirectory()) continue
        const h = path.join(WIN_USERS, entry.name)
        if (
          fs.existsSync(path.join(h, ".claude")) ||
          fs.existsSync(path.join(h, ".codex")) ||
          fs.existsSync(path.join(h, ".gemini", "antigravity")) ||
          fs.existsSync(path.join(h, ".dsh"))
        ) {
          out.push({ dir: h, tag: " · Win" })
        }
      }
    } catch {}
  }
  return out
}

function walkFiles(root, match, out = []) {
  let entries
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) walkFiles(full, match, out)
    else if (entry.isFile() && match(entry.name, full)) out.push(full)
  }
  return out
}

// Node's zlib.zstdDecompressSync stops after the first zstd frame, whereas
// DeepSeek Harness appends one independent zstd frame per event. Walk every
// concatenated frame in `buf` without shelling out to a `zstd` binary: if a
// candidate magic offset happens to occur inside compressed payload bytes,
// zstdDecompressSync throws on the truncated slice and we advance to the next.
function eachZstdFrame(buf, onChunk) {
  let pos = 0
  while (pos < buf.length) {
    if (
      pos + 8 <= buf.length &&
      (buf[pos] & 0xf0) === 0x50 &&
      buf[pos + 1] === 0x2a &&
      buf[pos + 2] === 0x4d &&
      buf[pos + 3] === 0x18
    ) {
      pos += 8 + buf.readUInt32LE(pos + 4)
      continue
    }
    let next = buf.indexOf(ZSTD_MAGIC, pos + 4)
    while (true) {
      const end = next === -1 ? buf.length : next
      try {
        onChunk(zlib.zstdDecompressSync(buf.subarray(pos, end)))
        pos = end
        break
      } catch (error) {
        if (next === -1) throw error
        next = buf.indexOf(ZSTD_MAGIC, next + 1)
      }
    }
  }
}

function feedBufferLines(buf, carryHolder, onLine) {
  let start = 0
  let nl = buf.indexOf(10, start)
  if (nl === -1) {
    carryHolder.buf = carryHolder.buf ? Buffer.concat([carryHolder.buf, buf]) : Buffer.from(buf)
    return
  }
  if (carryHolder.buf) {
    onLine(Buffer.concat([carryHolder.buf, buf.subarray(0, nl)]))
    carryHolder.buf = null
    start = nl + 1
    nl = buf.indexOf(10, start)
  }
  while (nl !== -1) {
    if (nl > start) onLine(buf.subarray(start, nl))
    start = nl + 1
    nl = buf.indexOf(10, start)
  }
  if (start < buf.length) {
    carryHolder.buf = Buffer.from(buf.subarray(start))
  }
}

// ---- Minimal protobuf wire decoder for Antigravity SQLite blobs ----

function pbFields(buf) {
  const out = new Map()
  let i = 0
  const n = buf.length
  while (i < n) {
    let key = 0n
    let shift = 0n
    while (true) {
      if (i >= n) throw new Error("truncated varint")
      const x = buf[i++]
      key |= BigInt(x & 0x7f) << shift
      shift += 7n
      if (x < 0x80) break
    }
    const wt = Number(key & 7n)
    const field = Number(key >> 3n)
    let val
    if (wt === 0 || wt === 2) {
      let v = 0n
      shift = 0n
      while (true) {
        if (i >= n) throw new Error("truncated varint")
        const x = buf[i++]
        v |= BigInt(x & 0x7f) << shift
        shift += 7n
        if (x < 0x80) break
      }
      if (wt === 2) {
        const len = Number(v)
        if (i + len > n) throw new Error("truncated bytes")
        val = buf.subarray(i, i + len)
        i += len
      } else {
        val = Number(v)
      }
    } else if (wt === 1) {
      if (i + 8 > n) throw new Error("truncated fixed64")
      val = buf.subarray(i, i + 8)
      i += 8
    } else if (wt === 5) {
      if (i + 4 > n) throw new Error("truncated fixed32")
      val = buf.subarray(i, i + 4)
      i += 4
    } else {
      throw new Error("bad wire type")
    }
    let arr = out.get(field)
    if (!arr) {
      arr = []
      out.set(field, arr)
    }
    arr.push(val)
  }
  return out
}

function pbTime(buf) {
  const f = pbFields(buf)
  const sec = f.get(1)?.[0] ?? 0
  const nanos = f.get(2)?.[0] ?? 0
  return sec + nanos / 1e9
}

function pbStr(buf) {
  return buf ? Buffer.from(buf).toString("utf8") : ""
}

// ---- Per-format line / file parsers ----

function createClaudeState() {
  return { cwd: "", pending: null, openId: null }
}

function feedClaudeLine(lineBuf, rows, st) {
  if (!lineBuf.includes(B_ASSISTANT) && !lineBuf.includes(B_API_REQ)) return
  let d
  try {
    d = JSON.parse(lineBuf.toString("utf8"))
  } catch {
    return
  }
  const type = d?.type
  const stamp = d?.timestamp
  if (!stamp) return
  if (d.cwd) st.cwd = d.cwd
  if (type === "api-request") {
    const ts = parseTs(stamp)
    if (ts !== null) st.pending = ts
    return
  }
  if (type !== "assistant") return
  const m = d.message
  if (!m || !m.id || m.model === "<synthetic>") return
  const now = parseTs(stamp)
  if (now === null) return
  const u = m.usage || {}
  const out = u.output_tokens || 0
  let row = st.openId === m.id && rows.length > 0 ? rows[rows.length - 1] : null
  if (!row) {
    const ttft = st.pending !== null && now >= st.pending ? now - st.pending : null
    row = [AGENT_INDEX.claude, st.pending, now, out, m.model || "?", projectName(st.cwd), 0, ttft, 0, 0, 0]
    rows.push(row)
    st.openId = m.id
    st.pending = null
  } else {
    if (now > row[2]) row[2] = now
    if (out > row[3]) row[3] = out
  }
  const cread = u.cache_read_input_tokens || 0
  const cwrite = u.cache_creation_input_tokens || 0
  row[9] = cread
  row[10] = cwrite
  row[8] = (u.input_tokens || 0) + cread + cwrite
  row[6] = u.output_tokens_details?.thinking_tokens || 0
}

function createCodexState() {
  return { model: "?", cwd: "", start: null, turnOpen: false, turnRowIdx: -1 }
}

function feedCodexLine(lineBuf, rows, st) {
  const head = lineBuf.subarray(0, Math.min(260, lineBuf.length)).toString("utf8")
  const m = TS_RE.exec(head)
  if (!m) return
  if (head.includes('"type":"response_item","payload":{"type":"')) {
    if (head.slice(0, 200).includes('_call_output"')) {
      const ts = parseTs(m[1])
      if (ts !== null) st.start = ts
    }
    return
  }
  if (head.includes('"type":"item_completed"')) {
    const sub = lineBuf.subarray(0, Math.min(640, lineBuf.length)).toString("utf8")
    if (sub.includes('"item":{"type":"UserMessage"')) {
      const ts = parseTs(m[1])
      if (ts !== null) st.start = ts
    }
    return
  }
  if (head.includes('"type":"task_started"') || head.includes('"type":"compacted"')) {
    const ts = parseTs(m[1])
    if (ts !== null) st.start = ts
    if (head.includes('"type":"task_started"')) {
      st.turnOpen = true
      st.turnRowIdx = -1
    }
    return
  }
  if (head.includes('"type":"task_complete"')) {
    if (st.turnRowIdx >= 0 && st.turnRowIdx < rows.length) {
      const full = lineBuf.toString("utf8")
      const tm = TTFT_RE.exec(full)
      if (tm) rows[st.turnRowIdx][7] = Number(tm[1]) / 1000
    }
    st.turnRowIdx = -1
    return
  }
  if (head.includes('"type":"session_meta"')) {
    const sub = lineBuf.subarray(0, Math.min(4096, lineBuf.length)).toString("utf8")
    const cm = CWD_RE.exec(sub)
    if (cm) {
      try {
        st.cwd = JSON.parse(`"${cm[1]}"`)
      } catch {}
    }
    return
  }
  if (!head.includes('"type":"token_usage_record"') && !head.includes('"type":"turn_context"')) return
  let d
  try {
    d = JSON.parse(lineBuf.toString("utf8"))
  } catch {
    return
  }
  const p = d?.payload || {}
  const now = parseTs(m[1])
  if (now === null) return
  if (d.type === "turn_context") {
    if (p.model) st.model = p.model
    if (p.cwd) st.cwd = p.cwd
    return
  }
  const usage = p.usage
  if (usage && typeof usage === "object") {
    const start = st.start !== null && now > st.start ? st.start : null
    rows.push([
      AGENT_INDEX.codex,
      start,
      now,
      usage.output_tokens || 0,
      st.model,
      projectName(st.cwd),
      usage.reasoning_output_tokens || 0,
      null,
      usage.input_tokens || 0,
      usage.cached_input_tokens || 0,
      usage.cache_write_input_tokens || 0,
    ])
    if (st.turnOpen) {
      st.turnRowIdx = rows.length - 1
      st.turnOpen = false
    }
    st.start = now
  }
}

function feedDshLine(lineBuf, rows, st) {
  const head = lineBuf.subarray(0, Math.min(48, lineBuf.length)).toString("utf8")
  if (
    !head.includes('"type":"session"') &&
    !head.includes('"type":"step/start"') &&
    !head.includes('"type":"assistant/message"')
  ) {
    return
  }
  let d
  try {
    d = JSON.parse(lineBuf.toString("utf8"))
  } catch {
    return
  }
  const type = d?.type
  if (type === "session") {
    st.cwd = d.cwd || ""
    return
  }
  if (type === "step/start") {
    if (typeof d.time === "number") st.start = d.time / 1000
    return
  }
  const x = d?.data || {}
  const m = x.message || {}
  const u = x.usage
  if (!u || typeof u !== "object" || !m.id || typeof d.time !== "number") return
  const src = m.source || {}
  const resp = src.replayState?.response || {}
  const end = d.time / 1000
  const start = st.start !== null && end > st.start ? st.start : null
  const s = x.stream || []
  const firstRaw = s[0]?.time || s[0]?.time0
  const first = typeof firstRaw === "number" ? firstRaw / 1000 : null
  const cread = u.cacheReadTokens || 0
  const cwrite = u.cacheWriteTokens || 0
  const ttft = start !== null && first !== null && first >= start ? first - start : null
  rows.push([
    AGENT_INDEX.dsh,
    start,
    end,
    u.outputTokens || 0,
    resp.responseModel || src.model || "?",
    projectName(st.cwd),
    0,
    ttft,
    (u.inputTokens || 0) + cread + cwrite,
    cread,
    cwrite,
    `dsh:${m.id}`,
  ])
  st.start = null
}

function antigravityProjects(root) {
  const out = new Map()
  const dbFile = path.join(root, "conversation_summaries.db")
  if (!fs.existsSync(dbFile)) return out
  let db
  try {
    db = new DatabaseSync(dbFile, { readOnly: true })
    const rows = db.prepare("select conversation_id, workspace_uris from conversation_summaries").all()
    for (const row of rows) {
      try {
        const list = JSON.parse(String(row.workspace_uris || "[]"))
        const first = list?.[0]
        if (!first) continue
        const p = first.startsWith("file://") ? fileURLToPath(first) : first
        out.set(String(row.conversation_id), projectName(p))
      } catch {}
    }
  } catch {
  } finally {
    try {
      db?.close()
    } catch {}
  }
  return out
}

function readAntigravityDb(dbPath, projects) {
  const cid = path.basename(dbPath, ".db")
  const project = projects.get(cid) || ""
  let db
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
    const models = new Map()
    let lastModel = "?"
    for (const row of db.prepare("select data from gen_metadata").all()) {
      try {
        const top = pbFields(row.data)
        const m = pbFields(top.get(1)[0])
        const rid = pbStr(pbFields(m.get(4)[0]).get(11)?.[0])
        const model = pbStr(m.get(19)[0])
        if (model) {
          models.set(rid, model)
          lastModel = model
        }
      } catch {}
    }
    const rows = []
    for (const row of db.prepare("select idx, metadata from steps where step_type = 15 order by idx").all()) {
      try {
        const m = pbFields(row.metadata)
        if (!m.has(7) || !m.has(9)) continue
        const u = pbFields(m.get(9)[0])
        const start = pbTime(m.get(1)[0])
        const end = pbTime(m.get(7)[0])
        const first = m.has(6) ? pbTime(m.get(6)[0]) : null
        const rid = pbStr(u.get(11)?.[0])
        const cread = u.get(5)?.[0] ?? 0
        const ttft = first !== null && first >= start ? first - start : null
        rows.push([
          AGENT_INDEX.antigravity,
          start,
          end,
          u.get(3)?.[0] ?? 0,
          (rid && models.get(rid)) || lastModel,
          project,
          u.get(9)?.[0] ?? 0,
          ttft,
          (u.get(2)?.[0] ?? 0) + cread,
          cread,
          0,
          rid ? `agy:${rid}` : `agy:${cid}:${row.idx}:${start.toFixed(6)}`,
        ])
      } catch {}
    }
    return rows
  } finally {
    try {
      db?.close()
    } catch {}
  }
}

function readPlainLinesFrom(filePath, startOffset, onLine) {
  let fd
  try {
    fd = fs.openSync(filePath, "r")
  } catch {
    return startOffset
  }
  let pos = startOffset
  let carry = null
  try {
    while (true) {
      const bytesRead = fs.readSync(fd, sharedBuf, 0, CHUNK_SIZE, pos)
      if (bytesRead <= 0) break
      const slice = sharedBuf.subarray(0, bytesRead)
      let lineStart = 0
      let nl = slice.indexOf(10, lineStart)
      if (nl === -1) {
        carry = carry ? Buffer.concat([carry, slice]) : Buffer.from(slice)
        pos += bytesRead
        continue
      }
      if (carry) {
        const full = Buffer.concat([carry, slice.subarray(0, nl)])
        carry = null
        onLine(full)
        lineStart = nl + 1
        nl = slice.indexOf(10, lineStart)
      }
      while (nl !== -1) {
        onLine(slice.subarray(lineStart, nl))
        lineStart = nl + 1
        nl = slice.indexOf(10, lineStart)
      }
      if (lineStart < bytesRead) {
        carry = Buffer.from(slice.subarray(lineStart, bytesRead))
      }
      pos += bytesRead
    }
  } finally {
    try {
      fs.closeSync(fd)
    } catch {}
  }
  return carry ? pos - carry.length : pos
}

// ---- Incremental store ----

class SpeedStore {
  constructor() {
    this.files = new Map()
    this.version = ""
    this.dirty = false
    this.lastSaveAt = 0
    this.lastScanAt = 0
    this.load()
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(cachePath(), "utf8"))
      if (raw?.v !== CACHE_VERSION || typeof raw.files !== "object" || !raw.files) return
      for (const [p, entry] of Object.entries(raw.files)) {
        if (entry && Array.isArray(entry.rows)) this.files.set(p, entry)
      }
    } catch {}
  }

  save(force = false) {
    if (!this.dirty) return
    const now = Date.now()
    if (!force && now - this.lastSaveAt < 30_000) return
    try {
      const target = cachePath()
      fs.mkdirSync(path.dirname(target), { recursive: true })
      const tmp = `${target}.tmp`
      const obj = { v: CACHE_VERSION, files: Object.fromEntries(this.files) }
      fs.writeFileSync(tmp, JSON.stringify(obj))
      fs.renameSync(tmp, target)
      this.dirty = false
      this.lastSaveAt = now
    } catch {}
  }

  discover() {
    const list = []
    for (const { dir: home, tag } of homes()) {
      for (const p of walkFiles(path.join(home, ".claude", "projects"), (n) => n.endsWith(".jsonl"))) {
        list.push({ path: p, kind: "claude", tag })
      }
      for (const sub of ["sessions", "archived_sessions"]) {
        const plain = new Set()
        const root = path.join(home, ".codex", sub)
        for (const p of walkFiles(root, (n) => n.endsWith(".jsonl"))) {
          plain.add(p)
          list.push({ path: p, kind: "codex", tag })
        }
        for (const p of walkFiles(root, (n) => n.endsWith(".jsonl.zst"))) {
          if (!plain.has(p.slice(0, -4))) list.push({ path: p, kind: "codex-zst", tag })
        }
      }
      const summaries = new Map([
        ...antigravityProjects(path.join(home, ".gemini", "antigravity")),
        ...antigravityProjects(path.join(home, ".gemini", "antigravity-cli")),
      ])
      for (const sub of ["antigravity", "antigravity-cli"]) {
        const convDir = path.join(home, ".gemini", sub, "conversations")
        for (const p of walkFiles(convDir, (n) => n.endsWith(".db"))) {
          list.push({ path: p, kind: "antigravity", tag, summaries })
        }
      }
      for (const p of walkFiles(path.join(home, ".dsh", "sessions"), (n) => n === "session.v4.jsonl.zstd")) {
        list.push({ path: p, kind: "dsh", tag })
      }
    }
    return list
  }

  updateOne(item) {
    let st
    try {
      st = fs.statSync(item.path)
    } catch {
      return
    }
    let sig = `${Math.trunc(st.mtimeMs)}:${st.size}`
    if (item.kind === "antigravity") {
      try {
        const wal = fs.statSync(`${item.path}-wal`)
        sig += `:${Math.trunc(wal.mtimeMs)}:${wal.size}`
      } catch {}
    }
    const prev = this.files.get(item.path)
    if (prev && prev.sig === sig && prev.kind === item.kind) return

    if (item.kind === "antigravity") {
      let rows
      try {
        rows = readAntigravityDb(item.path, item.summaries)
      } catch {
        return
      }
      this.files.set(item.path, { kind: item.kind, tag: item.tag, sig, offset: rows.length, state: null, rows })
      this.dirty = true
      return
    }

    if (item.kind === "codex-zst" || item.kind === "dsh") {
      const rows = []
      const pState = item.kind === "dsh" ? { start: null, cwd: "" } : createCodexState()
      const feed = item.kind === "dsh" ? feedDshLine : feedCodexLine
      const carry = { buf: null }
      try {
        const raw = fs.readFileSync(item.path)
        eachZstdFrame(raw, (chunk) => {
          feedBufferLines(chunk, carry, (line) => feed(line, rows, pState))
        })
        if (carry.buf && carry.buf.length > 0) feed(carry.buf, rows, pState)
      } catch {
        return
      }
      this.files.set(item.path, { kind: item.kind, tag: item.tag, sig, offset: st.size, state: null, rows })
      this.dirty = true
      return
    }

    let entry = prev
    if (!entry || entry.kind !== item.kind || st.size < (entry.offset || 0)) {
      entry = {
        kind: item.kind,
        tag: item.tag,
        sig: "",
        offset: 0,
        state: item.kind === "claude" ? createClaudeState() : createCodexState(),
        rows: [],
      }
    }
    const feed = item.kind === "claude" ? feedClaudeLine : feedCodexLine
    const nextOffset = readPlainLinesFrom(item.path, entry.offset, (lineBuf) => {
      if (lineBuf.length > 0) feed(lineBuf, entry.rows, entry.state)
    })
    entry.offset = nextOffset
    entry.tag = item.tag
    entry.sig = nextOffset === st.size ? sig : ""
    this.files.set(item.path, entry)
    this.dirty = true
  }

  scan(forceSave = false) {
    const found = this.discover()
    const alive = new Set()
    for (const item of found) {
      alive.add(item.path)
      this.updateOne(item)
    }
    for (const p of [...this.files.keys()]) {
      if (!alive.has(p) && !fs.existsSync(p)) {
        this.files.delete(p)
        this.dirty = true
      }
    }
    const hash = crypto.createHash("md5")
    for (const [p, e] of [...this.files.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      hash.update(`${p}:${e.offset}:${e.rows.length}\n`)
    }
    this.version = hash.digest("hex").slice(0, 12)
    this.lastScanAt = Date.now()
    this.save(forceSave)
  }

  *allRows() {
    const seen = new Set()
    for (const entry of this.files.values()) {
      const tag = entry.tag || ""
      for (const r of entry.rows) {
        const dedupId = r[11]
        if (dedupId) {
          if (seen.has(dedupId)) continue
          seen.add(dedupId)
        }
        yield { row: r, tag }
      }
    }
  }

  summary() {
    const byAgent = [[], [], [], []]
    for (const { row } of this.allRows()) {
      byAgent[row[0]]?.push(row)
    }
    const speeds = []
    AGENTS.forEach((kind, index) => {
      const mine = byAgent[index]
      if (!mine || mine.length === 0) return
      mine.sort((a, b) => a[2] - b[2])
      const cutoff = Date.now() / 1000 - 86400
      const recent = mine.filter((r) => r[2] >= cutoff)
      if (recent.length === 0) return
      const timed = recent.filter((r) => r[3] >= MIN_SUMMARY_TOKENS && r[1] !== null && r[2] > r[1]).slice(-SUMMARY_LAST)
      if (timed.length === 0) return
      const rate = (r) => r[3] / (r[2] - r[1])
      const last = timed[timed.length - 1]
      const sortedRates = timed.map(rate).sort((a, b) => a - b)
      const mid = sortedRates.length >> 1
      const med = sortedRates.length % 2 ? sortedRates[mid] : (sortedRates[mid - 1] + sortedRates[mid]) / 2
      const waited = recent.findLast((r) => r[7] !== null && r[7] !== undefined)
      speeds.push({
        kind,
        tps: Math.round(rate(last) * 10) / 10,
        median: Math.round(med),
        model: String(last[4] || "?"),
        at: Math.round(last[2] * 1000),
        ttft: waited ? Math.round(waited[7] * 100) / 100 : null,
        firstChunk: kind === "claude" || kind === "antigravity",
      })
    })
    return { speeds, up: true }
  }

  query(range = "24h", clientVersion = "") {
    const rng = Object.hasOwn(RANGES, range) ? range : "24h"
    const span = RANGES[rng]
    const key = `${this.version}|${rng}${rng === "all" ? "" : `|${Math.trunc(Date.now() / 30_000)}`}`
    if (clientVersion && clientVersion === key) {
      return { unchanged: true, v: key }
    }
    const now = Date.now() / 1000
    const since = span ? now - span : 0
    const models = new Map()
    const projects = new Map()
    const rows = []
    for (const { row: r, tag } of this.allRows()) {
      if (r[2] < since) continue
      const modelName = r[4] || "?"
      let mi = models.get(modelName)
      if (mi === undefined) {
        mi = models.size
        models.set(modelName, mi)
      }
      const projName = (r[5] || "") + tag
      let pi = projects.get(projName)
      if (pi === undefined) {
        pi = projects.size
        projects.set(projName, pi)
      }
      const start = r[1] !== null && r[2] > r[1] ? Math.round(r[1] * 1000) / 1000 : null
      rows.push([
        r[0],
        start,
        Math.round(r[2] * 1000) / 1000,
        r[3],
        mi,
        pi,
        r[6] || 0,
        r[7] !== null && r[7] !== undefined ? Math.round(r[7] * 100) / 100 : null,
        r[8] || 0,
        r[9] || 0,
        r[10] || 0,
      ])
    }
    rows.sort((a, b) => a[2] - b[2])
    return {
      v: key,
      now,
      since: since || null,
      models: [...models.keys()],
      projects: [...projects.keys()],
      rows,
    }
  }
}

const store = new SpeedStore()

function handleRequest(msg, reply) {
  try {
    const now = Date.now()
    const maxAge = msg.fresh ? 0 : msg.op === "summary" ? 15_000 : 2500
    if (now - store.lastScanAt >= maxAge) {
      store.scan(Boolean(msg.fresh))
    }
    const result = msg.op === "query" ? store.query(msg.range, msg.v) : store.summary()
    reply({ id: msg.id, ok: true, result })
  } catch (error) {
    reply({ id: msg.id, ok: false, error: error?.message || String(error) })
  }
}

if (parentPort) {
  parentPort.on("message", (msg) => handleRequest(msg, (out) => parentPort.postMessage(out)))
  setImmediate(() => {
    try {
      store.scan(true)
    } catch {}
  })
} else if (typeof process.send === "function") {
  process.on("message", (msg) => handleRequest(msg, (out) => process.send?.(out)))
  process.on("disconnect", () => process.exit(0))
  setImmediate(() => {
    try {
      store.scan(true)
    } catch {}
  })
} else if (process.argv.includes("--bench-selftest")) {
  store.scan(true)
  const t1 = Date.now()
  store.scan(false)
  const incMs = Date.now() - t1
  const sum = store.summary()
  const q24 = store.query("24h")
  const qAll = store.query("all")
  console.log(
    JSON.stringify(
      {
        files: store.files.size,
        incScanMs: incMs,
        rssMB: Math.round(process.memoryUsage().rss / 1048576),
        summary: sum,
        rows24h: q24.rows.length,
        rowsAll: qAll.rows.length,
        modelsCount: qAll.models.length,
        projectsCount: qAll.projects.length,
      },
      null,
      2,
    ),
  )
}
