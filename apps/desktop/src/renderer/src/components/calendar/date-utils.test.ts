import { describe, expect, it } from 'vitest'
import {
  dateFromDayIndex,
  dayIndexFromDate,
  isMultiDaySpan,
  localInputToIso,
  spanCoversDate,
  spanDateKeys,
  spanEndDateKey
} from './date-utils'

// Local instants keep these tests timezone-independent: the projection writes
// local midnights, so the helpers must read them back as local days.
function localIso(year: number, month: number, day: number, hour = 0, minute = 0): string {
  return new Date(year, month - 1, day, hour, minute, 0, 0).toISOString()
}

describe('multi-day span helpers', () => {
  it('treats a single-day all-day item as one day', () => {
    // #given an all-day item whose end is the next local midnight (exclusive)
    const item = { startAt: localIso(2026, 5, 10), endAt: localIso(2026, 5, 11), isAllDay: true }
    // #then
    expect(spanEndDateKey(item)).toBe('2026-05-10')
    expect(isMultiDaySpan(item)).toBe(false)
    expect(spanDateKeys(item)).toEqual(['2026-05-10'])
  })

  it('covers every day of an all-day span, start and end inclusive', () => {
    // #given May 10 through May 12, stored as an exclusive May 13 midnight
    const item = { startAt: localIso(2026, 5, 10), endAt: localIso(2026, 5, 13), isAllDay: true }
    // #then
    expect(isMultiDaySpan(item)).toBe(true)
    expect(spanDateKeys(item)).toEqual(['2026-05-10', '2026-05-11', '2026-05-12'])
    expect(spanCoversDate(item, '2026-05-11')).toBe(true)
    expect(spanCoversDate(item, '2026-05-13')).toBe(false)
  })

  it('includes the end day of a timed span that finishes mid-day', () => {
    // #given a timed event running from May 10 09:00 to May 12 11:00
    const item = {
      startAt: localIso(2026, 5, 10, 9),
      endAt: localIso(2026, 5, 12, 11),
      isAllDay: false
    }
    // #then
    expect(spanEndDateKey(item)).toBe('2026-05-12')
    expect(spanDateKeys(item)).toHaveLength(3)
  })

  it('excludes a timed span that ends exactly at midnight from the next day', () => {
    // #given an event ending on the stroke of May 11
    const item = {
      startAt: localIso(2026, 5, 10, 22),
      endAt: localIso(2026, 5, 11),
      isAllDay: false
    }
    // #then
    expect(spanEndDateKey(item)).toBe('2026-05-10')
    expect(isMultiDaySpan(item)).toBe(false)
  })

  it('falls back to the start day for a missing or inverted end', () => {
    // #given items with no end, and with an end before the start
    const open = { startAt: localIso(2026, 5, 10, 9), endAt: null }
    const inverted = { startAt: localIso(2026, 5, 10, 9), endAt: localIso(2026, 5, 8, 9) }
    // #then
    expect(spanEndDateKey(open)).toBe('2026-05-10')
    expect(spanEndDateKey(inverted)).toBe('2026-05-10')
  })
})

describe('localInputToIso', () => {
  it('converts a timed local input into an ISO 8601 UTC string ending in Z', () => {
    const result = localInputToIso('2026-04-17T09:30', false)
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  })

  it('prepends midnight for all-day inputs and returns a valid ISO string', () => {
    const result = localInputToIso('2026-04-17', true)
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  })

  it('throws when the input cannot be parsed as a date', () => {
    expect(() => localInputToIso('not-a-date', false)).toThrow(/invalid/i)
  })
})

describe('dayIndexFromDate / dateFromDayIndex', () => {
  it('returns 0 for the epoch date', () => {
    // #given / #when
    const index = dayIndexFromDate('2020-01-01')
    // #then
    expect(index).toBe(0)
  })

  it('maps dateFromDayIndex(0) back to epoch', () => {
    // #given / #when
    const date = dateFromDayIndex(0)
    // #then
    expect(date).toBe('2020-01-01')
  })

  it('round-trips arbitrary local dates stably', () => {
    // #given
    const samples = ['2020-01-01', '2021-03-01', '2024-02-29', '2026-04-17', '2030-12-31']
    // #when / #then
    for (const value of samples) {
      expect(dateFromDayIndex(dayIndexFromDate(value))).toBe(value)
    }
  })

  it('increments by one per calendar day across a DST boundary', () => {
    // #given — spring forward in US: 2026-03-08
    const before = dayIndexFromDate('2026-03-07')
    const after = dayIndexFromDate('2026-03-08')
    // #then
    expect(after - before).toBe(1)
  })

  it('supports negative indices (dates before the epoch)', () => {
    // #given / #when
    const index = dayIndexFromDate('2019-12-31')
    // #then
    expect(index).toBe(-1)
    expect(dateFromDayIndex(-1)).toBe('2019-12-31')
  })

  it('returns 7 days between two dates one week apart', () => {
    // #given / #when
    const diff = dayIndexFromDate('2026-04-24') - dayIndexFromDate('2026-04-17')
    // #then
    expect(diff).toBe(7)
  })
})
