import { describe, expect, it } from 'vitest'
import { isSameDayInOtherYear, sameDayMonthDays, shiftJournalYear } from './same-day.ts'

describe('same day in other years', () => {
  it('matches the same month and day in another year only', () => {
    expect(sameDayMonthDays('2026-11-10')).toEqual(['11-10'])
    expect(isSameDayInOtherYear('2026-11-10', '2025-11-10')).toBe(true)
    expect(isSameDayInOtherYear('2026-11-10', '2026-11-10')).toBe(false)
    expect(isSameDayInOtherYear('2026-11-10', '2025-11-11')).toBe(false)
  })

  it('shows a leap day on Feb 28 of a non-leap year', () => {
    expect(sameDayMonthDays('2027-02-28')).toEqual(['02-28', '02-29'])
    expect(isSameDayInOtherYear('2027-02-28', '2024-02-29')).toBe(true)
    expect(isSameDayInOtherYear('2027-02-28', '2024-02-28')).toBe(true)
  })

  it('keeps a leap year Feb 28 to its own day', () => {
    expect(sameDayMonthDays('2028-02-28')).toEqual(['02-28'])
    expect(isSameDayInOtherYear('2028-02-28', '2024-02-29')).toBe(false)
  })

  it('shows non-leap Feb 28s on a leap day, but not leap-year Feb 28s', () => {
    expect(sameDayMonthDays('2028-02-29')).toEqual(['02-29', '02-28'])
    expect(isSameDayInOtherYear('2028-02-29', '2024-02-29')).toBe(true)
    expect(isSameDayInOtherYear('2028-02-29', '2027-02-28')).toBe(true)
    expect(isSameDayInOtherYear('2028-02-29', '2024-02-28')).toBe(false)
  })

  it('moves a day by whole years, landing a leap day on Feb 28', () => {
    expect(shiftJournalYear('2026-11-10', -1)).toBe('2025-11-10')
    expect(shiftJournalYear('2024-02-29', 1)).toBe('2025-02-28')
    expect(shiftJournalYear('2024-02-29', 4)).toBe('2028-02-29')
  })
})
