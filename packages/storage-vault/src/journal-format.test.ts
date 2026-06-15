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
    { format: 'YYYY_MM_DD', iso: '2026-01-02', stem: '2026_01_02' }
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

  it('falls back to the default format when format is empty', () => {
    expect(formatJournalFilename('2026-06-15', '')).toBe('2026-06-15')
    expect(parseJournalDate('2026-06-15', '')).toBe('2026-06-15')
    expect(DEFAULT_JOURNAL_DATE_FORMAT).toBe('YYYY-MM-DD')
  })
})
