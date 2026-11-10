import { spawn, type ChildProcess } from "node:child_process"

// How loud the computer is playing right now, band by band, for the rhythm
// beside the thread when nobody is working (components/room/trajectory.tsx).
// Reads the default output's monitor with `parec` (PulseAudio, or PipeWire's
// pulse layer); only band levels leave this file, never the sound itself.
// One capture is shared by every open page and stops a moment after the last
// one goes. BENCH_AUDIO_CMD replaces the command (raw s16le mono at RATE on
// stdout), e.g. to test with a generated tone; elsewhere than Linux, and where
// parec is missing, there are simply no levels.

export const BANDS = 20
const RATE = 22050
const SIZE = 1024 // samples per analysis, ~46ms
const HOP = 735 // a frame every ~33ms, 30 per second
const LOW = 50
const HIGH = 10_000
const STOP_AFTER = 3000

type Listener = (frame: { bands: number[]; level: number }) => void

type Capture = {
  child: ChildProcess | null
  listeners: Set<Listener>
  stopTimer: ReturnType<typeof setTimeout> | null
  failed: boolean
}

const store = globalThis as typeof globalThis & { __benchAudio?: Capture }
function capture(): Capture {
  return (store.__benchAudio ??= { child: null, listeners: new Set(), stopTimer: null, failed: false })
}

export function audioAvailable() {
  return Boolean(process.env.BENCH_AUDIO_CMD) || (process.platform === "linux" && !capture().failed)
}

// Hann window and the FFT bin ranges of each band, worked out once.
const WINDOW = Float64Array.from({ length: SIZE }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (SIZE - 1)))
const EDGES = Array.from({ length: BANDS + 1 }, (_, i) => {
  const hz = LOW * Math.pow(HIGH / LOW, i / BANDS)
  return Math.max(1, Math.round((hz * SIZE) / RATE))
})

// In-place radix-2 FFT over re/im.
function fft(re: Float64Array, im: Float64Array) {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      ;[re[i], re[j]] = [re[j], re[i]]
      ;[im[i], im[j]] = [im[j], im[i]]
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len
    const wr = Math.cos(angle)
    const wi = Math.sin(angle)
    for (let i = 0; i < n; i += len) {
      let cr = 1
      let ci = 0
      for (let k = 0; k < len / 2; k++) {
        const a = i + k
        const b = a + len / 2
        const tr = re[b] * cr - im[b] * ci
        const ti = re[b] * ci + im[b] * cr
        re[b] = re[a] - tr
        im[b] = im[a] - ti
        re[a] += tr
        im[a] += ti
        const next = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = next
      }
    }
  }
}

// One analysis: each band's level in 0..1 on a decibel scale (-70 dB .. 0),
// and the overall loudness the same way.
function analyse(samples: Float64Array) {
  const re = new Float64Array(SIZE)
  const im = new Float64Array(SIZE)
  let power = 0
  for (let i = 0; i < SIZE; i++) {
    re[i] = samples[i] * WINDOW[i]
    power += samples[i] * samples[i]
  }
  fft(re, im)
  const bands: number[] = []
  for (let band = 0; band < BANDS; band++) {
    const from = EDGES[band]
    const to = Math.max(from + 1, EDGES[band + 1])
    let peak = 0
    for (let bin = from; bin < to && bin < SIZE / 2; bin++) peak = Math.max(peak, Math.hypot(re[bin], im[bin]))
    const db = 20 * Math.log10(peak / (SIZE / 4) + 1e-9)
    bands.push(Math.round(Math.min(1, Math.max(0, (db + 70) / 70)) * 100) / 100)
  }
  const rmsDb = 20 * Math.log10(Math.sqrt(power / SIZE) + 1e-9)
  return { bands, level: Math.round(Math.min(1, Math.max(0, (rmsDb + 60) / 60)) * 100) / 100 }
}

function start(cap: Capture) {
  const custom = process.env.BENCH_AUDIO_CMD
  const child = custom
    ? // Its own process group, so stopping it also stops what the shell started.
      spawn("sh", ["-c", custom], { stdio: ["ignore", "pipe", "ignore"], detached: true })
    : spawn(
        "parec",
        ["--device=@DEFAULT_MONITOR@", "--format=s16le", `--rate=${RATE}`, "--channels=1", "--latency-msec=30", "--raw"],
        { stdio: ["ignore", "pipe", "ignore"] },
      )
  cap.child = child
  // The latest SIZE samples, written round and round; unrolled per frame.
  const ring = new Float64Array(SIZE)
  const frameBuf = new Float64Array(SIZE)
  let head = 0
  let filled = 0
  let sinceFrame = 0
  let carry: Buffer | null = null
  child.stdout?.on("data", (chunk: Buffer) => {
    const data: Buffer = carry ? Buffer.concat([carry, chunk]) : chunk
    const whole = data.length - (data.length % 2)
    carry = whole < data.length ? data.subarray(whole) : null
    for (let offset = 0; offset < whole; offset += 2) {
      ring[head] = data.readInt16LE(offset) / 32768
      head = (head + 1) % SIZE
      if (filled < SIZE) filled++
      if (++sinceFrame >= HOP && filled === SIZE) {
        sinceFrame = 0
        frameBuf.set(ring.subarray(head), 0)
        frameBuf.set(ring.subarray(0, head), SIZE - head)
        const frame = analyse(frameBuf)
        for (const listener of cap.listeners) listener(frame)
      }
    }
  })
  const gone = () => {
    if (cap.child === child) cap.child = null
  }
  child.on("error", () => {
    cap.failed = !custom
    gone()
  })
  child.on("exit", gone)
}

function halt(child: ChildProcess) {
  try {
    if (process.env.BENCH_AUDIO_CMD && child.pid) process.kill(-child.pid)
    else child.kill()
  } catch {}
}

// Calls `listener` about 30 times a second until the returned stop is called.
export function listenAudio(listener: Listener) {
  const cap = capture()
  if (cap.stopTimer) {
    clearTimeout(cap.stopTimer)
    cap.stopTimer = null
  }
  cap.listeners.add(listener)
  if (!cap.child) start(cap)
  return () => {
    cap.listeners.delete(listener)
    if (cap.listeners.size > 0 || cap.stopTimer) return
    cap.stopTimer = setTimeout(() => {
      cap.stopTimer = null
      if (cap.listeners.size === 0 && cap.child) {
        halt(cap.child)
        cap.child = null
      }
    }, STOP_AFTER)
  }
}
