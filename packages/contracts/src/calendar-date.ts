/**
 * A `YYYY-MM-DD` string the calendar actually has.
 *
 * The shape regex alone accepts `2026-02-30`, `2025-02-29` and `2026-13-01`,
 * so a date a user typed by hand or an importer read out of someone else's
 * markdown lands in the database and is rendered from there. `completedAt` is
 * a `z.string().datetime()` and zod already refuses the impossible instant,
 * which is the asymmetry this closes.
 *
 * The round trip goes through the LOCAL constructor and the local getters, the
 * same pair `localMidnight` uses in the Obsidian import. `new Date('2026-01-01')`
 * parses as UTC midnight, so reading `getDate()` off it answers 31 December in
 * any zone west of UTC and a perfectly real date is refused. Building the date
 * from its parts keeps the comparison inside one zone, and a zone whose clocks
 * skip local midnight still lands on the same calendar day.
 */

import { z } from 'zod'

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/

export function isCalendarDate(value: string): boolean {
  if (!DATE_ONLY.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const at = new Date(year, month - 1, day)
  return at.getFullYear() === year && at.getMonth() === month - 1 && at.getDate() === day
}

/**
 * Said on every field that stores a written calendar date. The message reaches
 * the user through the IPC error envelope and `extractErrorMessage`, so it
 * names the two ways the value can be wrong rather than echoing the input.
 */
export const CalendarDateSchema = z
  .string()
  .refine(isCalendarDate, 'Date must be a real calendar date in YYYY-MM-DD form')
