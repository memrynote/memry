/**
 * Which template a journal entry starts from, for a given day.
 *
 * Kept as pure functions rather than inline in useJournalEntry so the
 * three-branch rule (weekday override → default → none) and the timezone
 * handling below are testable without mounting the hook.
 *
 * @module lib/journal-template-resolution
 */

import { parseISODate } from './journal-utils'

export interface JournalTemplateSettings {
  defaultTemplate: string | null
  weekdayTemplates?: Record<string, string | null>
}

/** Sunday-first, matching JS `getDay()`. */
export const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const

/**
 * Resolve the template id for `isoDate` (`YYYY-MM-DD`).
 *
 * Templates are bound to the *absolute* weekday, never to a position within the
 * week: the first-day-of-week preference only reorders the settings rows, so
 * flipping it between Sunday and Monday can never move a template onto a
 * different day.
 *
 * `parseISODate` is required over `new Date(isoDate)` — the latter parses a
 * bare date as UTC midnight, which in any negative-offset timezone reads back
 * as the *previous* local day and would open Monday with Sunday's template.
 */
export function resolveJournalTemplateId(
  settings: JournalTemplateSettings,
  isoDate: string
): string | null {
  const weekday = String(parseISODate(isoDate).getDay())
  const perDay = settings.weekdayTemplates?.[weekday]
  // A `null` entry is an explicit "clear this day", which falls back to the
  // default just like an absent entry does.
  if (perDay) return perDay
  return settings.defaultTemplate ?? null
}

/**
 * The seven weekdays in display order for a first-day-of-week preference.
 * `weekStartsOn` is 0 (Sunday) or 1 (Monday), matching useWeekStartsOn().
 */
export function orderedWeekdays(weekStartsOn: 0 | 1): number[] {
  return WEEKDAYS.map((day) => (day + weekStartsOn) % 7)
}

// 2024-01-07 was a Sunday, so this reference week maps day 0..6 onto real
// dates. Constructed with local Y/M/D parts for the same reason parseISODate
// exists — a UTC-parsed reference would name the wrong day west of Greenwich.
const REFERENCE_SUNDAY = { year: 2024, month: 0, day: 7 }

/**
 * Localized weekday name. Derived from Intl rather than translation keys: the
 * app ships 30+ locales and day names are exactly the kind of data Intl already
 * carries correctly, including capitalization rules we would otherwise get
 * wrong per language.
 */
export function weekdayLabel(weekday: number, locale: string): string {
  const date = new Date(
    REFERENCE_SUNDAY.year,
    REFERENCE_SUNDAY.month,
    REFERENCE_SUNDAY.day + weekday
  )
  return new Intl.DateTimeFormat(locale, { weekday: 'long' }).format(date)
}
