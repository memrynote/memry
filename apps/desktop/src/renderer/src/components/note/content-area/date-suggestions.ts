/**
 * Builds the "Date" suggestion group shown by both the `@` mention menu and the
 * `/date` · `/remind` slash items: a plain-date row plus a "Remind me" row whose
 * default fires at the parsed instant — or, if that instant has already passed,
 * tomorrow at 09:00 (so `@Today` suggests "Tomorrow 9am" but `@next sunday`
 * suggests that Sunday's date).
 */

import { parseNaturalDate } from '@/lib/natural-date-parser'
import { getActiveLocale } from '@/lib/active-locale'
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
  const month = d.toLocaleDateString(getActiveLocale(), { month: 'long' })
  return `${d.getDate()} ${month} ${d.getFullYear()}`
}

function remindSubtitle(d: Date, withTime: boolean, bumped: boolean, now: Date): string {
  if (bumped) return `Tomorrow ${friendlyTime(d)}`
  if (withTime)
    return `${formatDateMentionLabel(d.toISOString(), false, { now })} ${friendlyTime(d)}`
  return longDate(d)
}

export function buildDateSuggestions(query: string, now: Date = new Date()): DateSuggestion | null {
  const parsed = parseNaturalDate(toParserInput(query.trim() || 'today'))
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
  // Locale weekday/month names count too, so a half-typed date in the app's
  // language holds the menu open exactly like a half-typed English one.
  const names = localeDateNames()
  const keywords = [...DATE_KEYWORDS, ...names.weekdays, ...names.months].map((kw) =>
    kw.toLowerCase()
  )
  return keywords.some((kw) => kw.startsWith(first) || first.startsWith(kw))
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

interface LocaleDateNames {
  /** Sunday-first, index-aligned with {@link WEEKDAYS}. */
  weekdays: string[]
  /** January-first, index-aligned with {@link MONTHS}. */
  months: string[]
}

// predictDateCompletion runs on every keystroke, so the Intl formatting is
// computed once per locale rather than per call.
let localeNamesCache: { locale: string; names: LocaleDateNames } | null = null

function localeDateNames(): LocaleDateNames {
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
function toParserInput(query: string): string {
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
