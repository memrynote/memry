/**
 * "This day in other years": the days the On this day section and the All
 * years view put next to a journal day, and the day one year away.
 *
 * Feb 29 has no day of its own in a non-leap year. Its entries show on Feb 28
 * of a non-leap year, and a Feb 29 shows the Feb 28 of non-leap years, so a
 * leap-day entry never drops out of sight for three years.
 *
 * Dates are `YYYY-MM-DD`.
 *
 * @module journal/same-day
 */

const LEAP_DAY = '02-29'
const DAY_BEFORE_LEAP_DAY = '02-28'

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

function splitDate(date: string): { year: number; monthDay: string } {
  return { year: Number(date.slice(0, 4)), monthDay: date.slice(5) }
}

/** The `MM-DD` values whose entries can match `date` in another year. */
export function sameDayMonthDays(date: string): string[] {
  const { year, monthDay } = splitDate(date)
  if (monthDay === LEAP_DAY) return [LEAP_DAY, DAY_BEFORE_LEAP_DAY]
  if (monthDay === DAY_BEFORE_LEAP_DAY && !isLeapYear(year)) {
    return [DAY_BEFORE_LEAP_DAY, LEAP_DAY]
  }
  return [monthDay]
}

/** True when `candidate` is in another year and shows as the same day as `date`. */
export function isSameDayInOtherYear(date: string, candidate: string): boolean {
  const target = splitDate(date)
  const other = splitDate(candidate)
  if (other.year === target.year) return false
  if (other.monthDay === target.monthDay) return true
  if (target.monthDay === LEAP_DAY) {
    return other.monthDay === DAY_BEFORE_LEAP_DAY && !isLeapYear(other.year)
  }
  if (target.monthDay === DAY_BEFORE_LEAP_DAY && !isLeapYear(target.year)) {
    return other.monthDay === LEAP_DAY
  }
  return false
}

/** The same day `years` years away. A Feb 29 lands on Feb 28 in a non-leap year. */
export function shiftJournalYear(date: string, years: number): string {
  const { year, monthDay } = splitDate(date)
  const nextYear = year + years
  const nextMonthDay =
    monthDay === LEAP_DAY && !isLeapYear(nextYear) ? DAY_BEFORE_LEAP_DAY : monthDay
  return `${String(nextYear).padStart(4, '0')}-${nextMonthDay}`
}
