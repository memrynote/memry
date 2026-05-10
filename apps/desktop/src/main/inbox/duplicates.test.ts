import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getDatabase: vi.fn(),
  warn: vi.fn()
}))

vi.mock('../database', () => ({
  getDatabase: mocks.getDatabase
}))

vi.mock('../lib/logger', () => ({
  createLogger: () => ({ warn: mocks.warn, error: vi.fn(), info: vi.fn(), debug: vi.fn() })
}))

import { findDuplicateByContent, findDuplicateByUrl } from './duplicates'

function dbWithGet(result: unknown) {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          get: vi.fn(() => result)
        }))
      }))
    }))
  }
}

function dbWithAll(result: unknown[]) {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          all: vi.fn(() => result)
        }))
      }))
    }))
  }
}

describe('inbox duplicate detection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('finds active duplicate URLs and returns null for misses and database failures', () => {
    const match = {
      id: 'item-1',
      title: 'Example',
      createdAt: '2026-05-10T00:00:00.000Z'
    }
    mocks.getDatabase.mockReturnValueOnce(dbWithGet(match))
    expect(findDuplicateByUrl('https://example.com')).toEqual(match)

    mocks.getDatabase.mockReturnValueOnce(dbWithGet(null))
    expect(findDuplicateByUrl('https://missing.example')).toBeNull()

    mocks.getDatabase.mockImplementationOnce(() => {
      throw new Error('closed')
    })
    expect(findDuplicateByUrl('https://error.example')).toBeNull()
    expect(mocks.warn).toHaveBeenCalledWith('Duplicate URL check failed:', expect.any(Error))
  })

  it('compares content hashes for note candidates and handles short, empty, and failed checks', () => {
    const content =
      'This is a long enough inbox note body that should be compared by its normalized hash.'
    const match = {
      id: 'item-2',
      title: 'Same content',
      content,
      createdAt: '2026-05-10T00:00:00.000Z'
    }

    expect(findDuplicateByContent('short')).toBeNull()
    expect(findDuplicateByContent('')).toBeNull()

    mocks.getDatabase.mockReturnValueOnce(
      dbWithAll([
        { id: 'empty', title: 'Empty', content: null, createdAt: '2026-05-09T00:00:00.000Z' },
        match
      ])
    )
    expect(findDuplicateByContent(content)).toEqual({
      id: 'item-2',
      title: 'Same content',
      createdAt: '2026-05-10T00:00:00.000Z'
    })

    mocks.getDatabase.mockReturnValueOnce(
      dbWithAll([{ ...match, id: 'different', content: `${content} changed` }])
    )
    expect(findDuplicateByContent(content)).toBeNull()

    mocks.getDatabase.mockImplementationOnce(() => {
      throw new Error('closed')
    })
    expect(findDuplicateByContent(content)).toBeNull()
    expect(mocks.warn).toHaveBeenCalledWith('Duplicate content check failed:', expect.any(Error))
  })
})
