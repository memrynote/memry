/**
 * Which template a journal entry starts from, for a given day.
 *
 * Kept as pure functions rather than inline in useJournalEntry so the
 * three-branch rule (weekday override → default → none) and the timezone
 * handling below are testable without mounting the hook.
 *
 * @module lib/journal-template-resolution
 */

// The resolution rule and the weekday order live in
// `@memry/domain-notes/journal`, shared with the iOS core through vectors.
export {
  WEEKDAYS,
  orderedWeekdays,
  resolveJournalTemplateId,
  type JournalTemplateSettings
} from '@memry/domain-notes/journal'

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
