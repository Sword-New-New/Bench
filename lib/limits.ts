// The message when an account's allowance is used up, as it ends a turn.
// Claude Code:
//   You've hit your 5-hour limit · resets 3:30pm (America/Los_Angeles)
//   You've hit your session limit · resets 11am (America/Los_Angeles)
// Codex (its turn.failed error, seen 2026-11-09; the time is the computer's):
//   You’ve hit your usage limit. Visit https://chatgpt.com/settings/usage to
//   purchase more credits or try again at Nov 12th, 2026 7:42 PM.
// Read here for what ran out and when it comes back, so the room can say so
// and wake the seat again then. Only these formats are known; other clients'
// limit messages are not guessed at (Cursor's and Antigravity's were never
// seen: their allowance was not used up when this was written).

export type LimitHit = {
  // What ran out, in words for the page: "5 小时额度".
  label: string
  // The message itself, as Claude Code printed it.
  text: string
  // When it comes back (epoch ms), if the message said.
  resetsAt?: number
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]

const HIT = /You(?:'|’)ve hit your ([^·\n.]*?limit)/i
// "resets 3:30pm", "resets 11am", "resets Nov 12, 3pm", "resets Mon 3pm",
// each with an optional "(America/Los_Angeles)".
const RESETS =
  /resets\s+(?:(?:on\s+)?(?:(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2}),?\s*(?:at\s+)?|(sun|mon|tue|wed|thu|fri|sat)[a-z]*\.?,?\s*(?:at\s+)?))?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*(?:\(([^)]+)\))?/i

// Codex: "try again at Nov 12th, 2026 7:42 PM", on the computer's own clock.
const TRY_AGAIN =
  /try again at\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4}),?\s+(\d{1,2}):(\d{2})\s*(am|pm)/i

function tryAgainTime(text: string): number | undefined {
  const found = TRY_AGAIN.exec(text)
  if (!found) return undefined
  const [, month, day, year, hourText, minute, meridiem] = found
  const hour = (Number(hourText) % 12) + (meridiem.toLowerCase() === "pm" ? 12 : 0)
  const at = new Date(Number(year), MONTHS.indexOf(month.toLowerCase()), Number(day), hour, Number(minute)).getTime()
  return Number.isFinite(at) ? at : undefined
}

function labelOf(phrase: string) {
  const text = phrase.toLowerCase()
  if (/^usage limit$/.test(text)) return "使用额度"
  if (/5[- ]?hour|five[- ]hour/.test(text)) return "5 小时额度"
  if (/session/.test(text)) return "会话额度（5 小时）"
  const weekly = /^(.*?)\s*(?:weekly|7[- ]day|week)\b/i.exec(phrase)
  if (weekly) return weekly[1].trim() ? `${weekly[1].trim()} 每周额度` : "每周额度"
  return phrase.replace(/\s*limit$/i, "").trim() || "额度"
}

// The clock in `zone` at an instant, as { year, month (0-11), day, weekday (0=Sun) }.
function dayIn(at: number, zone?: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    ...(zone ? { timeZone: zone } : {}),
    year: "numeric",
    month: "numeric",
    day: "numeric",
    weekday: "short",
  }).formatToParts(new Date(at))
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? ""
  return { year: Number(get("year")), month: Number(get("month")) - 1, day: Number(get("day")), weekday: DAYS.indexOf(get("weekday").toLowerCase()) }
}

// How far `zone`'s clock is ahead of UTC at an instant.
function offsetAt(at: number, zone?: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    ...(zone ? { timeZone: zone } : {}),
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(new Date(at))
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value)
  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) - Math.floor(at / 1000) * 1000
}

// The instant the clock in `zone` reads year-month-day hour:minute.
function zonedInstant(year: number, month: number, day: number, hour: number, minute: number, zone?: string) {
  const wall = Date.UTC(year, month, day, hour, minute)
  // Twice: the first guess may sit on the other side of a daylight-saving change.
  const first = wall - offsetAt(wall, zone)
  return wall - offsetAt(first, zone)
}

function resetTime(text: string, now: number): number | undefined {
  const found = RESETS.exec(text)
  if (!found) return undefined
  const [, month, date, weekday, hourText, minuteText, meridiem, zoneText] = found
  const hour = (Number(hourText) % 12) + (meridiem.toLowerCase() === "pm" ? 12 : 0)
  const minute = minuteText ? Number(minuteText) : 0
  if (Number(hourText) < 1 || Number(hourText) > 12 || minute > 59) return undefined
  let zone: string | undefined = zoneText?.trim()
  try {
    if (zone) new Intl.DateTimeFormat("en-US", { timeZone: zone })
  } catch {
    zone = undefined
  }
  try {
    const today = dayIn(now, zone)
    // A reset already passed more than a minute ago means the next one.
    const stale = now - 60_000
    if (month && date) {
      const monthIndex = MONTHS.indexOf(month.toLowerCase())
      let at = zonedInstant(today.year, monthIndex, Number(date), hour, minute, zone)
      if (at < stale - 24 * 3600_000) at = zonedInstant(today.year + 1, monthIndex, Number(date), hour, minute, zone)
      return at
    }
    if (weekday) {
      const ahead = (DAYS.indexOf(weekday.toLowerCase()) - today.weekday + 7) % 7
      let at = zonedInstant(today.year, today.month, today.day + ahead, hour, minute, zone)
      if (at < stale) at = zonedInstant(today.year, today.month, today.day + ahead + 7, hour, minute, zone)
      return at
    }
    let at = zonedInstant(today.year, today.month, today.day, hour, minute, zone)
    if (at < stale) at = zonedInstant(today.year, today.month, today.day + 1, hour, minute, zone)
    return at
  } catch {
    return undefined
  }
}

// "15:30", "明天 11:00" or "11/12 15:00": when, in the user's own clock.
export function whenText(at: number, now = Date.now()) {
  const date = new Date(at)
  const pad = (n: number) => String(n).padStart(2, "0")
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  const day = (time: Date) => new Date(time.getFullYear(), time.getMonth(), time.getDate()).getTime()
  const apart = Math.round((day(date) - day(new Date(now))) / 86_400_000)
  if (apart === 0) return clock
  if (apart === 1) return `明天 ${clock}`
  return `${date.getMonth() + 1}/${date.getDate()} ${clock}`
}

export function detectLimit(text: string, now = Date.now()): LimitHit | null {
  const hit = HIT.exec(text)
  if (!hit) return null
  const line = text.split("\n").find((item) => HIT.test(item)) ?? hit[0]
  return { label: labelOf(hit[1]), text: line.trim().slice(0, 300), resetsAt: resetTime(line, now) ?? tryAgainTime(line) }
}
