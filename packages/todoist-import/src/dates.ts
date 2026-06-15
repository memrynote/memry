export interface ResolvedDate {
  date: string // YYYY-MM-DD
  time: string | null // HH:mm
}

export interface DateOptions {
  now: Date
  lang?: string
}

const MONTHS: Record<string, number> = {
  jan: 0,
  january: 0,
  feb: 1,
  february: 1,
  mar: 2,
  march: 2,
  apr: 3,
  april: 3,
  may: 4,
  jun: 5,
  june: 5,
  jul: 6,
  july: 6,
  aug: 7,
  august: 7,
  sep: 8,
  sept: 8,
  september: 8,
  oct: 9,
  october: 9,
  nov: 10,
  november: 10,
  dec: 11,
  december: 11
}

const WEEKDAYS: Record<string, number> = {
  sun: 0,
  sunday: 0,
  mon: 1,
  monday: 1,
  tue: 2,
  tues: 2,
  tuesday: 2,
  wed: 3,
  weds: 3,
  wednesday: 3,
  thu: 4,
  thur: 4,
  thurs: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6
}

const pad = (n: number) => String(n).padStart(2, '0')
const fmt = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)
const addMonths = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth() + n, d.getDate())

/** Best-effort parse of a Todoist DATE string into a Memry due date (English only). */
export function resolveDueDate(raw: string, { now, lang }: DateOptions): ResolvedDate | null {
  const s = raw.trim()
  if (!s) return null
  if (lang && lang.toLowerCase() !== 'en') return null

  const lower = s.toLowerCase()
  if (lower.startsWith('every ')) return null // recurring — out of scope (v1)

  if (lower === 'today') return { date: fmt(now), time: null }
  if (lower === 'tomorrow') return { date: fmt(addDays(now, 1)), time: null }
  if (lower === 'yesterday') return { date: fmt(addDays(now, -1)), time: null }

  // ISO date / datetime
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/)
  if (iso) {
    return { date: `${iso[1]}-${iso[2]}-${iso[3]}`, time: iso[4] ? `${iso[4]}:${iso[5]}` : null }
  }

  // "in N day|week|month(s)"
  const rel = lower.match(/^in\s+(\d+)\s+(day|days|week|weeks|month|months)$/)
  if (rel) {
    const n = parseInt(rel[1], 10)
    const unit = rel[2]
    let d: Date
    if (unit.startsWith('day')) d = addDays(now, n)
    else if (unit.startsWith('week')) d = addDays(now, n * 7)
    else d = addMonths(now, n)
    return { date: fmt(d), time: null }
  }

  // weekday name → next occurrence (today counts)
  if (WEEKDAYS[lower] !== undefined) {
    const target = WEEKDAYS[lower]
    const delta = (target - now.getDay() + 7) % 7
    return { date: fmt(addDays(now, delta)), time: null }
  }

  // named month: "Jun 20", "20 June", "June 20 2026", "20 Jun 2027"
  const named = parseNamedMonth(lower, now)
  if (named) return { date: named, time: null }

  return null
}

function parseNamedMonth(lower: string, now: Date): string | null {
  const tokens = lower.replace(/,/g, ' ').split(/\s+/).filter(Boolean)
  let month = -1
  let day = -1
  let year = -1
  for (const tok of tokens) {
    if (MONTHS[tok] !== undefined) month = MONTHS[tok]
    else if (/^\d{4}$/.test(tok)) year = parseInt(tok, 10)
    else if (/^\d{1,2}$/.test(tok)) day = parseInt(tok, 10)
  }
  if (month < 0 || day < 1 || day > 31) return null
  if (year < 0) {
    year = now.getFullYear()
    const candidate = new Date(year, month, day)
    // forward-looking: if it already passed this year, roll to next year
    if (candidate < new Date(now.getFullYear(), now.getMonth(), now.getDate())) year += 1
  }
  return `${year}-${pad(month + 1)}-${pad(day)}`
}
