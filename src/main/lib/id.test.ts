import { describe, it, expect } from 'vitest'
import {
  generateId,
  generateNoteId,
  generateJournalId,
  generateShortId,
  isValidNoteId,
  isValidId,
  isValidJournalId
} from './id'

describe('id utils', () => {
  it('generateId returns a 21-character URL-safe string', () => {
    const id = generateId()
    expect(id).toHaveLength(21)
    expect(id).toMatch(/^[A-Za-z0-9_-]{21}$/)
  })

  it('generateNoteId returns a 12-character lowercase alphanumeric string', () => {
    const id = generateNoteId()
    expect(id).toHaveLength(12)
    expect(id).toMatch(/^[0-9a-z]{12}$/)
  })

  it('generateJournalId returns a j-prefixed date string', () => {
    expect(generateJournalId('2026-01-15')).toBe('j2026-01-15')
  })

  it('generateShortId returns an 8-character lowercase alphanumeric string', () => {
    const id = generateShortId()
    expect(id).toHaveLength(8)
    expect(id).toMatch(/^[0-9a-z]{8}$/)
  })

  it('validators accept valid ids and reject invalid formats', () => {
    const noteId = generateNoteId()
    const generalId = generateId()
    const journalId = generateJournalId('2026-01-15')

    expect(isValidNoteId(noteId)).toBe(true)
    expect(isValidId(generalId)).toBe(true)
    expect(isValidJournalId(journalId)).toBe(true)

    expect(isValidNoteId('ABC123def456')).toBe(false)
    expect(isValidNoteId('short')).toBe(false)
    expect(isValidId('not-url-safe-$$$$')).toBe(false)
    expect(isValidJournalId('j2026-1-15')).toBe(false)
    expect(isValidJournalId('2026-01-15')).toBe(false)
  })
})
