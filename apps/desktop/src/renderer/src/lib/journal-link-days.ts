import { isValidJournalDate } from '@memry/contracts/journal-api'
import { toLocalDateString } from '@/components/calendar/date-utils'

/**
 * A journal day answers links by its ISO date, the title every entry is
 * indexed under. A day nobody has written yet is still a real day, so a link
 * or relation to it is a ghost of a page that exists the moment it is written,
 * never a broken link to a note that should be created.
 */
export function isJournalDay(text: string): boolean {
  // `isValidJournalDate` lets `2026-02-31` roll over to March; a day that is
  // not on the calendar is not a journal day.
  return (
    isValidJournalDate(text) && new Date(`${text}T00:00:00.000Z`).toISOString().startsWith(text)
  )
}

const RELATIVE_DAYS = new Map([
  ['today', 0],
  ['journal', 0],
  ['yesterday', -1],
  ['tomorrow', 1]
])

/** The one journal day a query names outright: an ISO date, or today, yesterday or tomorrow. */
export function journalDayOf(query: string, now: Date = new Date()): string | null {
  const text = query.trim().toLowerCase()
  if (isJournalDay(text)) return text
  const offset = RELATIVE_DAYS.get(text)
  if (offset === undefined) return null
  const day = new Date(now)
  day.setDate(day.getDate() + offset)
  return toLocalDateString(day)
}

/** A date being typed (`2026`, `2026-11`, `2026-11-0`): existing days that start with it. */
export function isJournalDayPrefix(query: string): boolean {
  return /^\d{4}(-\d{0,2}(-\d{0,2})?)?$/.test(query.trim())
}
