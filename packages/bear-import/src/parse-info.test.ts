import { describe, it, expect } from 'vitest'
import { parseInfo } from './parse-info.ts'

describe('parseInfo', () => {
  it('parses a full bear info object', () => {
    const raw = {
      'net.shinyfrog.bear.uniqueIdentifier': 'ABC-123',
      'net.shinyfrog.bear.note-creation-date': '2024-01-15T10:00:00.000Z',
      'net.shinyfrog.bear.note-modification-date': '2024-03-05T12:00:00.000Z',
      'net.shinyfrog.bear.note-archived': false,
      'net.shinyfrog.bear.note-trashed': false
    }
    const result = parseInfo(raw)
    expect(result.uniqueIdentifier).toBe('ABC-123')
    expect(result.archived).toBe(false)
    expect(result.trashed).toBe(false)
    expect(result.created).toBeInstanceOf(Date)
    expect(result.modified).toBeInstanceOf(Date)
  })

  it('handles archived flag as boolean true', () => {
    const raw = {
      'net.shinyfrog.bear.note-archived': true,
      'net.shinyfrog.bear.note-trashed': false
    }
    const result = parseInfo(raw)
    expect(result.archived).toBe(true)
    expect(result.trashed).toBe(false)
  })

  it('handles archived/trashed as numeric 1/0', () => {
    const raw = {
      'net.shinyfrog.bear.note-archived': 0,
      'net.shinyfrog.bear.note-trashed': 1
    }
    const result = parseInfo(raw)
    expect(result.archived).toBe(false)
    expect(result.trashed).toBe(true)
  })

  it('returns defaults when keys are missing', () => {
    const result = parseInfo({})
    expect(result.archived).toBe(false)
    expect(result.trashed).toBe(false)
    expect(result.uniqueIdentifier).toBeUndefined()
    expect(result.created).toBeUndefined()
    expect(result.modified).toBeUndefined()
  })

  it('returns defaults for non-object input (null)', () => {
    const result = parseInfo(null)
    expect(result.archived).toBe(false)
    expect(result.trashed).toBe(false)
  })

  it('returns defaults for non-object input (string)', () => {
    const result = parseInfo('invalid')
    expect(result.archived).toBe(false)
    expect(result.trashed).toBe(false)
  })

  it('returns defaults for array input', () => {
    const result = parseInfo([1, 2, 3])
    expect(result.archived).toBe(false)
    expect(result.trashed).toBe(false)
  })
})
