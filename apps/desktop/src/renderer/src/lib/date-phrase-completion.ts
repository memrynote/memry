/**
 * Inline ghost-text completion for a natural-language date phrase.
 *
 * Shared by the note editor's `@`-mention ghost and the task quick-add field,
 * so a half-typed "@tomo" completes to the same thing in both. Kept in `lib`
 * rather than next to the mention plugin because the editor module graph pulls
 * in BlockNote, which the capture bar has no business importing.
 */

import { parseNaturalDate } from './natural-date-parser'
import { getActiveLocale } from './active-locale'

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

// ---------------------------------------------------------------------------
// Locale weekday / month names
// ---------------------------------------------------------------------------
// The completion tables above are English. A user running the app in another
// language types weekdays and months in THAT language, so the ghost also matches
// the active locale's names — in the locale's own canonical casing, which Intl
// already gives us (French "lundi" stays lowercase, Turkish "Pazartesi" does
// not). English stays in the tables and is always tried first: English date
// words are typed in non-English UIs all the time, and dropping them would be a
// regression.

/** 2023-01-01 is a Sunday, so index 0..6 walks Sunday → Saturday. */
const SUNDAY_REFERENCE = Date.UTC(2023, 0, 1)
const DAY_MS = 86_400_000

export interface LocaleDateNames {
  /** Sunday-first, index-aligned with the English weekday table. */
  weekdays: string[]
  /** January-first, index-aligned with the English month table. */
  months: string[]
}

// predictDateCompletion runs on every keystroke, so the Intl formatting is
// computed once per locale rather than per call.
let localeNamesCache: { locale: string; names: LocaleDateNames } | null = null

export function localeDateNames(): LocaleDateNames {
  const locale = getActiveLocale()
  if (localeNamesCache?.locale === locale) return localeNamesCache.names

  const weekdayFormat = new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' })
  const monthFormat = new Intl.DateTimeFormat(locale, { month: 'long', timeZone: 'UTC' })
  const names: LocaleDateNames = {
    weekdays: Array.from({ length: 7 }, (_, i) =>
      weekdayFormat.format(new Date(SUNDAY_REFERENCE + i * DAY_MS))
    ),
    months: Array.from({ length: 12 }, (_, i) => monthFormat.format(new Date(Date.UTC(2023, i, 1))))
  }
  localeNamesCache = { locale, names }
  return names
}

/** English names first, then any locale name that is not already one of them. */
function withLocaleNames(english: readonly string[], localized: readonly string[]): string[] {
  const seen = new Set(english.map((name) => name.toLowerCase()))
  return [...english, ...localized.filter((name) => !!name && !seen.has(name.toLowerCase()))]
}

function weekdayCandidates(): string[] {
  return withLocaleNames(WEEKDAYS, localeDateNames().weekdays)
}

function monthCandidates(): string[] {
  return withLocaleNames(MONTHS, localeDateNames().months)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Rewrites the active locale's weekday/month names to their English equivalents.
 *
 * `parseNaturalDate` only knows English day/month words, so without this a
 * locale-language phrase — typed by hand or accepted from the ghost — would
 * complete visually and then resolve to nothing. Whole words only, and a no-op
 * whenever the locale's names already are the English ones (so English input,
 * and every existing test, goes through byte-identical).
 */
export function toParserInput(query: string): string {
  const names = localeDateNames()
  const pairs: Array<[string, string]> = [
    ...names.weekdays.map((name, i): [string, string] => [name, WEEKDAYS[i]]),
    ...names.months.map((name, i): [string, string] => [name, MONTHS[i]])
  ]
  // Longest first, so a locale whose names share a leading word (Vietnamese
  // "Thứ Hai" / "Thứ Ba") cannot be half-replaced by the shorter one.
  pairs.sort((a, b) => b[0].length - a[0].length)

  let out = query
  for (const [localized, english] of pairs) {
    if (!localized || localized.toLowerCase() === english.toLowerCase()) continue
    const pattern = new RegExp(
      `(^|[^\\p{L}\\p{N}])${escapeRegExp(localized)}(?=$|[^\\p{L}\\p{N}])`,
      'giu'
    )
    out = out.replace(pattern, (_match, lead: string) => `${lead}${english}`)
  }
  return out
}

function startsWithCI(candidate: string, query: string): boolean {
  return candidate.toLowerCase().startsWith(query.toLowerCase())
}

function matchWeekday(prefix: string): string | null {
  if (!prefix) return null
  return weekdayCandidates().find((w) => w.toLowerCase().startsWith(prefix)) ?? null
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
    if (h >= 0 && h <= 23 && parseNaturalDate(toParserInput(dated[1])).success) {
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
  if (connector) return parseNaturalDate(toParserInput(connector[1])).success

  const q = query.trimEnd()

  // "<date> [at] H:M" with a single minute digit still being typed.
  const dated = q.match(/^(.*?\S)\s+(?:at\s+)?(\d{1,2}):(\d)$/i)
  if (dated) {
    const h = parseInt(dated[2], 10)
    return h >= 0 && h <= 23 && parseNaturalDate(toParserInput(dated[1])).success
  }

  // "<date> [at] H[:MM]" + a meridiem still being typed ("today 2p",
  // "today at 14pm", "next monday 2:30p").
  const meridiem = q.match(/^(.*?\S)\s+(?:at\s+)?(\d{1,2})(?::\d{2})?\s*([ap]m?)$/i)
  if (meridiem) {
    const h = parseInt(meridiem[2], 10)
    return h >= 0 && h <= 23 && parseNaturalDate(toParserInput(meridiem[1])).success
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

  for (const candidate of [...RELATIVE, ...weekdayCandidates(), ...monthCandidates()]) {
    if (startsWithCI(candidate, query)) return candidate
  }
  return null
}
