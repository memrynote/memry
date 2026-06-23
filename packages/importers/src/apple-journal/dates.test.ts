import { describe, it, expect } from 'vitest'
import { parseJournalDate } from './dates.ts'

describe('parseJournalDate', () => {
  it('parses "Sunday, 3 November 2024"', () => {
    expect(parseJournalDate('Sunday, 3 November 2024')).toEqual({ iso: '2024-11-03' })
  })

  it('parses without weekday "3 November 2024"', () => {
    expect(parseJournalDate('3 November 2024')).toEqual({ iso: '2024-11-03' })
  })

  it('parses single-digit day "Monday, 7 January 2025"', () => {
    expect(parseJournalDate('Monday, 7 January 2025')).toEqual({ iso: '2025-01-07' })
  })

  it('parses two-digit day "Wednesday, 12 March 2025"', () => {
    expect(parseJournalDate('Wednesday, 12 March 2025')).toEqual({ iso: '2025-03-12' })
  })

  it('returns null for unrecognised text', () => {
    expect(parseJournalDate('Not a date')).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(parseJournalDate('')).toBeNull()
  })
})
