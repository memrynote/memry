import { describe, expect, it } from 'vitest'
import { dateFromDayIndex, dayIndexFromDate, localInputToIso } from './date-utils'

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
