import { describe, it, expect } from 'vitest'
import { parseInfo } from './parse-info.ts'

describe('parseInfo', () => {
  it('parses a full bear info object', () => {
    const raw = {
      creatorIdentifier: 'net.shinyfrog.bear',
      'net.shinyfrog.bear': {
        uniqueIdentifier: 'ABC-123',
        creationDate: '2024-01-15T10:00:00.000Z',
        modificationDate: '2024-03-05T12:00:00.000Z',
        archived: 0,
        trashed: 0
      }
    }
    const result = parseInfo(raw)
    expect(result.uniqueIdentifier).toBe('ABC-123')
    expect(result.archived).toBe(false)
    expect(result.trashed).toBe(false)
    expect(result.created).toBeInstanceOf(Date)
    expect(result.modified).toBeInstanceOf(Date)
  })

  it('handles archived flag as numeric 1', () => {
    const raw = {
      'net.shinyfrog.bear': {
        archived: 1,
        trashed: 0
      }
    }
    const result = parseInfo(raw)
    expect(result.archived).toBe(true)
    expect(result.trashed).toBe(false)
  })

  it('handles archived/trashed as numeric 1/0', () => {
    const raw = {
      'net.shinyfrog.bear': {
        archived: 0,
        trashed: 1
      }
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
