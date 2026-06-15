import { describe, it, expect } from 'vitest'
import {
  detectDailyNote,
  formatJournalFilename,
  parseDailyNoteTitle,
  parseDailyNoteUid
} from './dates.ts'

describe('parseDailyNoteTitle', () => {
  it('parses long-form Roam daily titles with ordinal suffix', () => {
    expect(parseDailyNoteTitle('January 1st, 2024')).toBe('2024-01-01')
    expect(parseDailyNoteTitle('March 22nd, 2024')).toBe('2024-03-22')
    expect(parseDailyNoteTitle('December 3rd, 2023')).toBe('2023-12-03')
  })

  it('parses long-form titles without ordinal suffix', () => {
    expect(parseDailyNoteTitle('July 4, 2024')).toBe('2024-07-04')
  })

  it('returns null for non-date titles', () => {
    expect(parseDailyNoteTitle('My Project')).toBeNull()
    expect(parseDailyNoteTitle('Notmonth 5th, 2024')).toBeNull()
  })

  it('rejects impossible dates', () => {
    expect(parseDailyNoteTitle('February 30th, 2024')).toBeNull()
  })
})

describe('parseDailyNoteUid', () => {
  it('parses MM-DD-YYYY uids', () => {
    expect(parseDailyNoteUid('01-01-2024')).toBe('2024-01-01')
    expect(parseDailyNoteUid('03-22-2024')).toBe('2024-03-22')
  })

  it('returns null for non-date uids', () => {
    expect(parseDailyNoteUid('abc123')).toBeNull()
    expect(parseDailyNoteUid(undefined)).toBeNull()
  })
})

describe('detectDailyNote', () => {
  it('prefers the title over the uid', () => {
    expect(detectDailyNote('January 1st, 2024', '99-99-9999')).toBe('2024-01-01')
  })

  it('falls back to the uid when the title is not a date', () => {
    expect(detectDailyNote('Random Page', '03-22-2024')).toBe('2024-03-22')
  })

  it('returns null when neither is a date', () => {
    expect(detectDailyNote('Random Page', 'abc')).toBeNull()
  })
})

describe('formatJournalFilename', () => {
  it('formats ISO dates with the default YYYY-MM-DD', () => {
    expect(formatJournalFilename('2024-01-01')).toBe('2024-01-01')
  })

  it('honors a custom format', () => {
    expect(formatJournalFilename('2024-03-22', 'YYYY/MM/DD')).toBe('2024/03/22')
    expect(formatJournalFilename('2024-03-22', 'M-D-YY')).toBe('3-22-24')
  })
})
