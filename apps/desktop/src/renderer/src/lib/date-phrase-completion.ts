/**
 * Inline ghost-text completion for a natural-language date phrase.
 *
 * Shared by the note editor's `@`-mention ghost and the task quick-add field,
 * so a half-typed "@tomo" completes to the same thing in both. Kept in `lib`
 * rather than next to the mention plugin because the editor module graph pulls
 * in BlockNote, which the capture bar has no business importing.
 *
 * The English grammar lives in `@memry/domain-tasks/parsing` (spec 004 D1, D5).
 * This module adds the active locale's weekday and month names on top.
 */

import {
  COMPLETION_MONTHS,
  COMPLETION_WEEKDAYS,
  isTimeInProgress as isTimeInProgressAt,
  predictDateCompletion as predictDateCompletionAt,
  predictTime as predictTimeAt,
  type CompletionLocale
} from '@memry/domain-tasks/parsing'
import { getActiveLocale } from './active-locale'

const WEEKDAYS: readonly string[] = COMPLETION_WEEKDAYS
const MONTHS: readonly string[] = COMPLETION_MONTHS

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

function activeLocale(): CompletionLocale {
  return {
    weekdays: weekdayCandidates(),
    months: monthCandidates(),
    toParserInput
  }
}

// Time-of-day completion for the inline ghost. See the package for the rules.
export function predictTime(query: string, now: Date = new Date()): string | null {
  return predictTimeAt(query, now, activeLocale())
}

// Keeps the inline mention active through time-entry moments that have nothing
// confident to ghost. See the package for the rules.
export function isTimeInProgress(query: string, now: Date = new Date()): boolean {
  return isTimeInProgressAt(query, now, activeLocale())
}

/**
 * Best full completion for the raw text typed after `@`, in canonical casing, or
 * null when the query is not date-ish. The returned string is a case-insensitive
 * superstring of `query`.
 */
export function predictDateCompletion(query: string, now: Date = new Date()): string | null {
  return predictDateCompletionAt(query, now, activeLocale())
}
