import { describe, expect, it } from 'vitest'
import {
  MAX_SAVED_TAG_SEARCHES,
  TAG_SEARCHES_SETTINGS_DEFAULTS,
  TagSearchSchema,
  parseTagSearches
} from './tag-searches-api'

describe('TagSearchSchema', () => {
  it('accepts a saved multi-tag search', () => {
    expect(
      TagSearchSchema.parse({
        id: 's1',
        name: 'Work + urgent',
        tags: ['work', 'urgent'],
        createdAt: '2026-09-11T00:00:00.000Z'
      }).tags
    ).toEqual(['work', 'urgent'])
  })

  it('rejects an empty tag list', () => {
    expect(
      TagSearchSchema.safeParse({ id: 's1', name: 'x', tags: [], createdAt: '' }).success
    ).toBe(false)
  })
})

describe('parseTagSearches', () => {
  const valid = {
    id: 's1',
    name: 'Work + urgent',
    tags: ['work', 'urgent'],
    createdAt: '2026-09-11T00:00:00.000Z'
  }

  it('defaults to an empty list for a vault that never saved a search', () => {
    expect(parseTagSearches(undefined)).toEqual([])
    expect(parseTagSearches(null)).toEqual([])
    expect(parseTagSearches({})).toEqual([])
    expect(TAG_SEARCHES_SETTINGS_DEFAULTS.searches).toEqual([])
  })

  it('round-trips a persisted blob', () => {
    expect(parseTagSearches({ searches: [valid] })).toEqual([valid])
  })

  it('drops malformed entries instead of failing the whole list', () => {
    expect(parseTagSearches({ searches: [valid, { id: 'bad' }, 7] })).toEqual([valid])
  })

  it('caps the list', () => {
    const many = Array.from({ length: MAX_SAVED_TAG_SEARCHES + 10 }, (_, i) => ({
      ...valid,
      id: `s${i}`
    }))
    expect(parseTagSearches({ searches: many })).toHaveLength(MAX_SAVED_TAG_SEARCHES)
  })

  it('tolerates a non-array searches field', () => {
    expect(parseTagSearches({ searches: 'nope' })).toEqual([])
  })
})
