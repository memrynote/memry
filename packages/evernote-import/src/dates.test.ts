import { describe, it, expect } from 'vitest'
import { parseEnexDate } from './dates.ts'

describe('parseEnexDate', () => {
  it('converts a valid Evernote date to ISO 8601', () => {
    expect(parseEnexDate('20231015T143022Z')).toBe('2023-10-15T14:30:22Z')
  })

  it('handles midnight', () => {
    expect(parseEnexDate('20240101T000000Z')).toBe('2024-01-01T00:00:00Z')
  })

  it('returns undefined for empty string', () => {
    expect(parseEnexDate('')).toBeUndefined()
  })

  it('returns undefined for null', () => {
    expect(parseEnexDate(null)).toBeUndefined()
  })

  it('returns undefined for undefined', () => {
    expect(parseEnexDate(undefined)).toBeUndefined()
  })

  it('returns undefined for malformed input', () => {
    expect(parseEnexDate('2023-10-15')).toBeUndefined()
    expect(parseEnexDate('20231015')).toBeUndefined()
    expect(parseEnexDate('not-a-date')).toBeUndefined()
  })
})
