import { describe, it, expect } from 'vitest'
import {
  buildJournalRegex,
  parseJournalDate,
  formatJournalFilename,
  DEFAULT_JOURNAL_DATE_FORMAT
} from './journal-format.ts'

describe('journal-format', () => {
  const cases: { format: string; iso: string; stem: string }[] = [
    { format: 'YYYY-MM-DD', iso: '2026-06-15', stem: '2026-06-15' },
    { format: 'DD-MM-YYYY', iso: '2026-06-15', stem: '15-06-2026' },
    { format: 'YYYYMMDD', iso: '2026-06-15', stem: '20260615' },
    { format: 'YYYY.MM.DD', iso: '2026-06-15', stem: '2026.06.15' },
    { format: 'YYYY_MM_DD', iso: '2026-01-02', stem: '2026_01_02' },
    { format: 'YYYY-MM-DD dddd', iso: '2026-09-26', stem: '2026-09-26 Saturday' },
    { format: 'dddd, DD.MM.YYYY', iso: '2026-06-15', stem: 'Monday, 15.06.2026' },
    { format: 'YYYY-MM-DD ddd', iso: '2026-09-27', stem: '2026-09-27 Sun' }
  ]

  it('round-trips format -> parse for each supported format', () => {
    for (const { format, iso, stem } of cases) {
      expect(formatJournalFilename(iso, format)).toBe(stem)
      expect(parseJournalDate(stem, format)).toBe(iso)
    }
  })

  it('matches the stem with buildJournalRegex', () => {
    for (const { format, stem } of cases) {
      expect(buildJournalRegex(format).test(stem)).toBe(true)
    }
  })

  it('returns null for non-matching stems', () => {
    expect(parseJournalDate('ideas', 'YYYY-MM-DD')).toBeNull()
    expect(parseJournalDate('2026-06', 'YYYY-MM-DD')).toBeNull()
    expect(parseJournalDate('2026-06-15-extra', 'YYYY-MM-DD')).toBeNull()
  })

  it('returns null for out-of-range months/days', () => {
    expect(parseJournalDate('2026-13-01', 'YYYY-MM-DD')).toBeNull()
    expect(parseJournalDate('2026-00-10', 'YYYY-MM-DD')).toBeNull()
    expect(parseJournalDate('2026-06-40', 'YYYY-MM-DD')).toBeNull()
  })

  it('does not match a date-named file under a different format', () => {
    // 15-06-2026 is valid for DD-MM-YYYY but not for YYYY-MM-DD
    expect(parseJournalDate('15-06-2026', 'YYYY-MM-DD')).toBeNull()
  })

  it('supports 2-digit year and single-digit month/day tokens', () => {
    expect(parseJournalDate('26-6-5', 'YY-M-D')).toBe('2026-06-05')
    expect(formatJournalFilename('2026-06-05', 'YY-M-D')).toBe('26-6-5')
  })

  it('renders every weekday name for dddd and ddd', () => {
    const week = [20, 21, 22, 23, 24, 25, 26].map((day) =>
      formatJournalFilename(`2026-09-${day}`, 'dddd/ddd')
    )
    expect(week).toEqual([
      'Sunday/Sun',
      'Monday/Mon',
      'Tuesday/Tue',
      'Wednesday/Wed',
      'Thursday/Thu',
      'Friday/Fri',
      'Saturday/Sat'
    ])
  })

  it('rejects a weekday that does not match the date', () => {
    expect(parseJournalDate('2026-09-26 Friday', 'YYYY-MM-DD dddd')).toBeNull()
    expect(parseJournalDate('2026-09-26 Fri', 'YYYY-MM-DD ddd')).toBeNull()
  })

  it('rejects non-English, lowercase, or mismatched-length weekday names', () => {
    expect(parseJournalDate('2026-09-26 Cumartesi', 'YYYY-MM-DD dddd')).toBeNull()
    expect(parseJournalDate('2026-09-26 saturday', 'YYYY-MM-DD dddd')).toBeNull()
    expect(parseJournalDate('2026-09-26 Sat', 'YYYY-MM-DD dddd')).toBeNull()
    expect(parseJournalDate('2026-09-26 Saturday', 'YYYY-MM-DD ddd')).toBeNull()
  })

  it('keeps lone lowercase d literal', () => {
    expect(formatJournalFilename('2026-06-15', 'YYYY-MM-DD d')).toBe('2026-06-15 d')
    expect(parseJournalDate('2026-06-15 d', 'YYYY-MM-DD d')).toBe('2026-06-15')
  })

  it('falls back to the default format when format is empty', () => {
    expect(formatJournalFilename('2026-06-15', '')).toBe('2026-06-15')
    expect(parseJournalDate('2026-06-15', '')).toBe('2026-06-15')
    expect(DEFAULT_JOURNAL_DATE_FORMAT).toBe('YYYY-MM-DD')
  })
})
