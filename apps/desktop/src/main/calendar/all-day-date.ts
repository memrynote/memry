const UTC_MIDNIGHT = /T00:00:00(\.0+)?Z$/
const BARE_DATE = /^\d{4}-\d{2}-\d{2}$/

function toLocalDateString(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function addUtcDays(date: string, days: number): string {
  const next = new Date(`${date}T00:00:00.000Z`)
  next.setUTCDate(next.getUTCDate() + days)
  return next.toISOString().slice(0, 10)
}

/**
 * The calendar day of a stored all-day instant, as `YYYY-MM-DD`.
 *
 * Provider mirrors (Google, CalDAV, ICS, EventKit) store an all-day date as UTC
 * midnight of that day; events created in memrynote store local midnight. Local
 * midnight equals UTC midnight only at a zero offset, where both read the same
 * day, so the shape tells which reading to use.
 */
export function allDayDate(value: string): string {
  if (BARE_DATE.test(value)) return value
  return UTC_MIDNIGHT.test(value) ? value.slice(0, 10) : toLocalDateString(new Date(value))
}

/**
 * The first day and the exclusive end day a provider expects for an all-day
 * event. A missing end, or one on or before the start (the event form saves a
 * one-day event with end = start), ends the next day.
 */
export function allDayDateRange(
  startAt: string,
  endAt: string | null
): { startDate: string; endDate: string } {
  const startDate = allDayDate(startAt)
  const endDate = endAt ? allDayDate(endAt) : null
  return {
    startDate,
    endDate: endDate && endDate > startDate ? endDate : addUtcDays(startDate, 1)
  }
}
