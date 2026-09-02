import { describe, it, expect, afterEach } from 'vitest'
import { CalendarDateSchema, isCalendarDate } from './calendar-date'

const originalTimeZone = process.env.TZ

afterEach(() => {
  if (originalTimeZone === undefined) delete process.env.TZ
  else process.env.TZ = originalTimeZone
})

describe('isCalendarDate', () => {
  it.each(['2026-01-15', '2024-02-29', '2026-12-31', '2026-01-01', '0100-01-01'])(
    'accepts %s',
    (value) => {
      expect(isCalendarDate(value)).toBe(true)
    }
  )

  // `new Date(year, ...)` maps a year of 0 through 99 onto 1900 through 1999,
  // so the round trip reads 1901 back for year 1 and refuses it. Years below
  // 0100 are not reachable as a task due date, and widening the predicate to
  // serve them would buy nothing, so the limit is recorded rather than fixed.
  it('refuses a year below 0100, which the Date constructor remaps', () => {
    expect(isCalendarDate('0001-01-01')).toBe(false)
  })

  it.each([
    '2026-02-30',
    '2025-02-29',
    '2026-13-01',
    '2026-00-10',
    '2026-04-31',
    '2026-11-31',
    '2026-01-00',
    '2026-01-32'
  ])('refuses %s', (value) => {
    expect(isCalendarDate(value)).toBe(false)
  })

  it.each(['01-15-2026', '2026-1-15', '2026-01-15T10:00:00Z', '2026-01-15 ', '', 'tomorrow'])(
    'refuses %s, which is not the date-only shape at all',
    (value) => {
      expect(isCalendarDate(value)).toBe(false)
    }
  )

  // The naive check is `new Date(value)` plus the local getters. That parse is
  // UTC, so in any zone west of UTC the first of January reads back as the
  // thirty-first of December and a real date is refused. Building the date from
  // its parts keeps both ends of the comparison in one zone.
  it.each(['Pacific/Pago_Pago', 'Pacific/Kiritimati', 'UTC', 'Asia/Kolkata'])(
    'accepts the year boundary and the leap day in %s',
    (timeZone) => {
      process.env.TZ = timeZone
      expect(isCalendarDate('2026-01-01')).toBe(true)
      expect(isCalendarDate('2026-12-31')).toBe(true)
      expect(isCalendarDate('2024-02-29')).toBe(true)
      expect(isCalendarDate('2025-02-29')).toBe(false)
    }
  )

  // America/Santiago and America/Havana move the clock forward at midnight, so
  // the day has no 00:00 and `new Date(y, m - 1, d)` lands on 01:00. The
  // calendar day is unchanged, which is all this predicate reads.
  it.each(['America/Santiago', 'America/Havana'])(
    'accepts a day whose local midnight does not exist in %s',
    (timeZone) => {
      process.env.TZ = timeZone
      expect(isCalendarDate('2019-09-08')).toBe(true)
      expect(isCalendarDate('2018-03-11')).toBe(true)
    }
  )
})

describe('CalendarDateSchema', () => {
  it('carries a message a user can act on', () => {
    const result = CalendarDateSchema.safeParse('2026-02-30')
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].message).toBe(
        'Date must be a real calendar date in YYYY-MM-DD form'
      )
    }
  })

  it('returns the input unchanged for a date that exists', () => {
    expect(CalendarDateSchema.parse('2024-02-29')).toBe('2024-02-29')
  })
})
