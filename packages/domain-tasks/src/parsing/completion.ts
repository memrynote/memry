/**
 * Inline ghost-text completion for a natural-language date phrase.
 *
 * English tables only (spec 004 D1). The renderer layers the active locale's
 * weekday and month names on top through {@link CompletionLocale}; with no
 * locale supplied every function here behaves exactly as the English-only
 * renderer did. `now` is the caller's clock.
 */

import { parseNaturalDate } from './natural-date.ts'

// Canonical display casing for completions: relative words and weekdays/months
// are capitalized; "next"/"last" stay lowercase so the weekday reads as the
// emphasized token (e.g. "next Saturday").
export const COMPLETION_WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday'
] as const
export const COMPLETION_MONTHS = [
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
] as const
// Priority order for single-token relative completions (so "@t"/"@to" → Today,
// not Tomorrow/Tuesday/Thursday).
const RELATIVE = ['Today', 'Tomorrow', 'Yesterday']

/**
 * Extra candidates from a non-English UI, and the rewrite that turns them back
 * into the English words the parser understands. The desktop note editor
 * supplies one; the task surfaces and the iOS core do not.
 */
export interface CompletionLocale {
  /** Weekday candidates, English first then any locale-only names. */
  weekdays: readonly string[]
  /** Month candidates, English first then any locale-only names. */
  months: readonly string[]
  toParserInput: (query: string) => string
}

const ENGLISH: CompletionLocale = {
  weekdays: COMPLETION_WEEKDAYS,
  months: COMPLETION_MONTHS,
  toParserInput: (query) => query
}

function startsWithCI(candidate: string, query: string): boolean {
  return candidate.toLowerCase().startsWith(query.toLowerCase())
}

function matchWeekday(prefix: string, locale: CompletionLocale): string | null {
  if (!prefix) return null
  return locale.weekdays.find((w) => w.toLowerCase().startsWith(prefix)) ?? null
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
export function predictTime(
  query: string,
  now: Date,
  locale: CompletionLocale = ENGLISH
): string | null {
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
    if (h >= 0 && h <= 23 && parseNaturalDate(locale.toParserInput(dated[1]), now).success) {
      return dated[3] ? `${q}00` : `${q}:00`
    }
  }
  return null
}

// Keeps the inline mention active through time-entry moments that have nothing
// confident to ghost: a freshly typed "at" connector after a date, or a single
// (still ambiguous) minute digit. Pure structural check — trailing non-time text
// ("next monday foo") stays inactive, matching predictTime's date anchoring.
export function isTimeInProgress(
  query: string,
  now: Date,
  locale: CompletionLocale = ENGLISH
): boolean {
  // "<date> at" — connector typed, before any time ("today at", "today at ").
  const connector = query.match(/^(.*\S)\s+at\s*$/i)
  if (connector) return parseNaturalDate(locale.toParserInput(connector[1]), now).success

  const q = query.trimEnd()

  // "<date> [at] H:M" with a single minute digit still being typed.
  const dated = q.match(/^(.*?\S)\s+(?:at\s+)?(\d{1,2}):(\d)$/i)
  if (dated) {
    const h = parseInt(dated[2], 10)
    return h >= 0 && h <= 23 && parseNaturalDate(locale.toParserInput(dated[1]), now).success
  }

  // "<date> [at] H[:MM]" + a meridiem still being typed ("today 2p",
  // "today at 14pm", "next monday 2:30p").
  const meridiem = q.match(/^(.*?\S)\s+(?:at\s+)?(\d{1,2})(?::\d{2})?\s*([ap]m?)$/i)
  if (meridiem) {
    const h = parseInt(meridiem[2], 10)
    return h >= 0 && h <= 23 && parseNaturalDate(locale.toParserInput(meridiem[1]), now).success
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
export function predictDateCompletion(
  query: string,
  now: Date,
  locale: CompletionLocale = ENGLISH
): string | null {
  if (query.trim() === '') return 'Today'

  const time = predictTime(query, now, locale)
  if (time) return time

  const tokens = query.trim().toLowerCase().split(/\s+/)
  const first = tokens[0]

  // "next"/"last" (+ weekday). Defaults to today's weekday; respects a partial
  // second token ("next m" → "next Monday").
  for (const conn of ['next', 'last']) {
    if (conn.startsWith(first) || first === conn) {
      const weekday = matchWeekday(tokens[1] ?? '', locale) ?? COMPLETION_WEEKDAYS[now.getDay()]
      const candidate = `${conn} ${weekday}`
      if (startsWithCI(candidate, query)) return candidate
    }
  }

  for (const candidate of [...RELATIVE, ...locale.weekdays, ...locale.months]) {
    if (startsWithCI(candidate, query)) return candidate
  }
  return null
}
