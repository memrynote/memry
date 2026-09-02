/**
 * The half-open window `[local midnight, next local midnight)` for a `YYYY-MM-DD` local date.
 *
 * The single definition of "one day" for every calendar range query, because the Home board
 * had two: the widget pinned local date components to `T00:00:00.000Z` while the header used
 * a local `setHours(0, 0, 0, 0)`. At UTC+3 that made the header count local 00:00-03:00 events
 * the widget never showed, and at UTC-7 the same gap fell on the local evening (#1920).
 *
 * Local rather than UTC because "today" is the user's wall clock, and because the main process
 * already projects every date-only source at local midnight (`toLocalInstant` /
 * `toLocalAllDayEnd` in `main/calendar/projection.ts`) and reads the window back as local dates.
 *
 * The end comes from calendar fields, not `start + 24h`: a DST transition day is 23 or 25 hours
 * long, so only the platform can resolve the real offset. Offsets like UTC+5:30 and UTC+8:45
 * fall out of the same construction.
 */
export function localDayRange(date: string): { startAt: string; endAt: string } {
  const [year, month, day] = date.split('-').map(Number)
  const start = new Date(year, month - 1, day, 0, 0, 0, 0)
  const end = new Date(year, month - 1, day + 1, 0, 0, 0, 0)
  return { startAt: start.toISOString(), endAt: end.toISOString() }
}
