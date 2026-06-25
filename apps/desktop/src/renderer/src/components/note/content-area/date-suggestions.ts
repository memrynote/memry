/**
 * Builds the "Date" suggestion group shown by both the `@` mention menu and the
 * `/date` · `/remind` slash items: a plain-date row plus a "Remind me" row whose
 * default fires at the parsed instant — or, if that instant has already passed,
 * tomorrow at 09:00 (so `@Today` suggests "Tomorrow 9am" but `@next sunday`
 * suggests that Sunday's date).
 */

import { parseNaturalDate } from '@/lib/natural-date-parser'
import { formatDateMentionLabel } from './date-mention'
import type { DateMentionValue } from './date-mention-popover'

export interface DateSuggestion {
  dateLabel: string
  dateValue: DateMentionValue
  remindSubtitle: string
  remindValue: DateMentionValue
}

function friendlyTime(d: Date): string {
  let h = d.getHours()
  const m = d.getMinutes()
  const meridiem = h < 12 ? 'am' : 'pm'
  h = h % 12 || 12
  return m ? `${h}:${String(m).padStart(2, '0')}${meridiem}` : `${h}${meridiem}`
}

function longDate(d: Date): string {
  const month = d.toLocaleDateString(undefined, { month: 'long' })
  return `${d.getDate()} ${month} ${d.getFullYear()}`
}

function remindSubtitle(d: Date, withTime: boolean, bumped: boolean, now: Date): string {
  if (bumped) return `Tomorrow ${friendlyTime(d)}`
  if (withTime)
    return `${formatDateMentionLabel(d.toISOString(), false, { now })} ${friendlyTime(d)}`
  return longDate(d)
}

export function buildDateSuggestions(query: string, now: Date = new Date()): DateSuggestion | null {
  const parsed = parseNaturalDate(query.trim() || 'today')
  if (!parsed.success) return null

  const time = parsed.result.time
  const hasTime = time !== null
  const base = new Date(parsed.result.date)
  if (time) {
    const [h, mi] = time.split(':').map(Number)
    base.setHours(h, mi, 0, 0)
  } else {
    base.setHours(9, 0, 0, 0)
  }

  const dateValue: DateMentionValue = {
    dateISO: base.toISOString(),
    hasTime,
    dateFormat: 'relative',
    remind: 'none',
    timeFormat: 'system'
  }
  const dateLabel = formatDateMentionLabel(base.toISOString(), hasTime, {
    dateFormat: 'relative',
    now
  })

  // Reminder defaults to the parsed instant; if it's already passed, bump to
  // tomorrow 09:00.
  let remindBase = base
  let remindHasTime = hasTime
  let bumped = false
  if (base.getTime() <= now.getTime()) {
    const tomorrow = new Date(now)
    tomorrow.setDate(now.getDate() + 1)
    tomorrow.setHours(9, 0, 0, 0)
    remindBase = tomorrow
    remindHasTime = false
    bumped = true
  }

  const remindValue: DateMentionValue = {
    dateISO: remindBase.toISOString(),
    hasTime: remindHasTime,
    dateFormat: 'relative',
    remind: 'at',
    timeFormat: 'system'
  }

  return {
    dateLabel,
    dateValue,
    remindSubtitle: remindSubtitle(remindBase, remindHasTime, bumped, now),
    remindValue
  }
}

// Leading tokens that signal "a date is being typed" but may not parse on their
// own yet (connectors that need a completion, plus partial weekday/month words).
const DATE_KEYWORDS = [
  'today',
  'tomorrow',
  'tmrw',
  'tmr',
  'yesterday',
  'next',
  'last',
  'this',
  'in',
  'week',
  'weekend',
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december'
]

function looksDateish(query: string): boolean {
  const first = query.trim().toLowerCase().split(/\s+/)[0]
  if (!first) return false
  if (/^\d/.test(first)) return true
  return DATE_KEYWORDS.some((kw) => kw.startsWith(first) || first.startsWith(kw))
}

// Longest leading token-prefix that parses (so "today 12p" still resolves to
// "today" while the time is mid-typed).
function bestEffortSuggestion(query: string, now: Date): DateSuggestion | null {
  const trimmed = query.trim()
  const full = buildDateSuggestions(trimmed, now)
  if (full) return full

  const tokens = trimmed.split(/\s+/)
  for (let n = tokens.length - 1; n >= 1; n--) {
    const prefix = tokens.slice(0, n).join(' ')
    const s = buildDateSuggestions(prefix, now)
    if (s) return s
  }
  return null
}

export interface DateMentionEntry {
  /** Full date+remind suggestion, or null when nothing (yet) parses. */
  suggestion: DateSuggestion | null
  /** Query looks date-ish but does not parse yet → hold the menu open. */
  hint: boolean
}

/**
 * Resilient variant of {@link buildDateSuggestions} for the `@` mention menu:
 * keeps the Date group alive through intermediate keystrokes so the user can
 * finish typing a phrase (e.g. "next monday 14:32") without the menu closing.
 */
export function buildDateMentionEntry(query: string, now: Date = new Date()): DateMentionEntry {
  const suggestion = bestEffortSuggestion(query, now)
  if (suggestion) return { suggestion, hint: false }
  return { suggestion: null, hint: looksDateish(query) }
}

// ---------------------------------------------------------------------------
// Inline ghost-text autocomplete
// ---------------------------------------------------------------------------

// Canonical display casing for completions: relative words and weekdays/months
// are capitalized; "next"/"last" stay lowercase so the weekday reads as the
// emphasized token (e.g. "next Saturday").
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December'
]
// Priority order for single-token relative completions (so "@t"/"@to" → Today,
// not Tomorrow/Tuesday/Thursday).
const RELATIVE = ['Today', 'Tomorrow', 'Yesterday']

function startsWithCI(candidate: string, query: string): boolean {
  return candidate.toLowerCase().startsWith(query.toLowerCase())
}

function matchWeekday(prefix: string): string | null {
  if (!prefix) return null
  return WEEKDAYS.find((w) => w.toLowerCase().startsWith(prefix)) ?? null
}

// Time-of-day completion for the inline ghost. Supports an optional "at"
// connector and a mid-typed colon, always preserving the typed text verbatim so
// the ghost remainder is exactly the padding (":00" / "00"):
//   "12" / "12:"                    → "12:00"
//   "today 12" / "today 12:"        → "today 12:00"
//   "today at 12" / "today at 12:"  → "today at 12:00"
// Stays date-anchored: a number after a non-date word ("meeting 12") is left
// alone. A single, still-ambiguous minute digit ("12:3") is not ghosted — that
// state is held open by {@link isTimeInProgress} instead.
export function predictTime(query: string): string | null {
  const q = query.trimEnd()

  // Bare time at the caret: "12" or "12:".
  const bare = q.match(/^(\d{1,2})(:?)$/)
  if (bare) {
    const h = parseInt(bare[1], 10)
    if (h < 0 || h > 23) return null
    return bare[2] ? `${q}00` : `${q}:00`
  }

  // Date (+ optional "at") + time: "today 12", "today at 12", "today 12:".
  const dated = q.match(/^(.*?\S)\s+(?:at\s+)?(\d{1,2})(:?)$/i)
  if (dated) {
    const h = parseInt(dated[2], 10)
    if (h >= 0 && h <= 23 && parseNaturalDate(dated[1]).success) {
      return dated[3] ? `${q}00` : `${q}:00`
    }
  }
  return null
}

// Keeps the inline mention active through time-entry moments that have nothing
// confident to ghost: a freshly typed "at" connector after a date, or a single
// (still ambiguous) minute digit. Pure structural check — trailing non-time text
// ("next monday foo") stays inactive, matching predictTime's date anchoring.
export function isTimeInProgress(query: string): boolean {
  // "<date> at" — connector typed, before any time ("today at", "today at ").
  const connector = query.match(/^(.*\S)\s+at\s*$/i)
  if (connector) return parseNaturalDate(connector[1]).success

  const q = query.trimEnd()

  // "<date> [at] H:M" with a single minute digit still being typed.
  const dated = q.match(/^(.*?\S)\s+(?:at\s+)?(\d{1,2}):(\d)$/i)
  if (dated) {
    const h = parseInt(dated[2], 10)
    return h >= 0 && h <= 23 && parseNaturalDate(dated[1]).success
  }

  // "<date> [at] H[:MM]" + a meridiem still being typed ("today 2p",
  // "today at 14pm", "next monday 2:30p").
  const meridiem = q.match(/^(.*?\S)\s+(?:at\s+)?(\d{1,2})(?::\d{2})?\s*([ap]m?)$/i)
  if (meridiem) {
    const h = parseInt(meridiem[2], 10)
    return h >= 0 && h <= 23 && parseNaturalDate(meridiem[1]).success
  }

  // Bare "H:M" with a single minute digit ("23:3").
  const bare = q.match(/^(\d{1,2}):(\d)$/)
  if (bare) {
    const h = parseInt(bare[1], 10)
    return h >= 0 && h <= 23
  }

  return false
}

/**
 * Best full completion for the raw text typed after `@`, in canonical casing, or
 * null when the query is not date-ish. The returned string is a case-insensitive
 * superstring of `query` (callers display `prediction.slice(query.length)` as the
 * ghost remainder and replace the query with the full string on accept).
 */
export function predictDateCompletion(query: string, now: Date = new Date()): string | null {
  if (query.trim() === '') return 'Today'

  const time = predictTime(query)
  if (time) return time

  const tokens = query.trim().toLowerCase().split(/\s+/)
  const first = tokens[0]

  // "next"/"last" (+ weekday). Defaults to today's weekday; respects a partial
  // second token ("next m" → "next Monday").
  for (const conn of ['next', 'last']) {
    if (conn.startsWith(first) || first === conn) {
      const weekday = matchWeekday(tokens[1] ?? '') ?? WEEKDAYS[now.getDay()]
      const candidate = `${conn} ${weekday}`
      if (startsWithCI(candidate, query)) return candidate
    }
  }

  for (const candidate of [...RELATIVE, ...WEEKDAYS, ...MONTHS]) {
    if (startsWithCI(candidate, query)) return candidate
  }
  return null
}
