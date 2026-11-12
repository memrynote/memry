import { describe, it, expect } from 'vitest'
import { normalizeScores, truncateQuery, parseSearchQuery } from './search-utils'
import type { SearchResultItem } from '@memry/contracts/search-api'

function makeItem(overrides: Partial<SearchResultItem>): SearchResultItem {
  return {
    id: 'test-1',
    type: 'note',
    title: 'Test',
    snippet: '',
    score: 0,
    normalizedScore: 0,
    matchType: 'exact',
    modifiedAt: '2026-01-01T00:00:00Z',
    metadata: { type: 'note', path: '/test', tags: [], emoji: null },
    ...overrides
  }
}

describe('normalizeScores', () => {
  it('normalizes scores to 0-1 range', () => {
    // #given
    const items = [
      makeItem({ score: 10 }),
      makeItem({ id: 'test-2', score: 5 }),
      makeItem({ id: 'test-3', score: 0 })
    ]

    // #when
    const result = normalizeScores(items)

    // #then
    expect(result[0].normalizedScore).toBe(1)
    expect(result[1].normalizedScore).toBe(0.5)
    expect(result[2].normalizedScore).toBe(0)
  })

  it('returns all 1s when all scores are equal', () => {
    const items = [makeItem({ score: 5 }), makeItem({ id: 'test-2', score: 5 })]

    const result = normalizeScores(items)

    expect(result[0].normalizedScore).toBe(1)
    expect(result[1].normalizedScore).toBe(1)
  })

  it('returns empty array for empty input', () => {
    expect(normalizeScores([])).toEqual([])
  })

  it('does not mutate original items', () => {
    const items = [makeItem({ score: 10 })]
    const original = { ...items[0] }
    normalizeScores(items)
    expect(items[0]).toEqual(original)
  })
})

describe('truncateQuery', () => {
  it('returns short queries unchanged', () => {
    expect(truncateQuery('hello')).toBe('hello')
  })

  it('truncates at 500 characters by default', () => {
    const long = 'a'.repeat(600)
    expect(truncateQuery(long)).toHaveLength(500)
  })

  it('respects custom maxLength', () => {
    expect(truncateQuery('hello world', 5)).toBe('hello')
  })
})

describe('parseSearchQuery', () => {
  // Query, match, phrase. The same rows as the table in
  // crates/memry-core/src/domain/search/query.rs.
  const cases: [string, string, string][] = [
    ['pass', '"pass"*', ''],
    ['hello world', '"hello"* "world"*', '"hello world"*'],
    ['"meeting notes"', '"meeting notes"', ''],
    ['meeting NOT personal', '"meeting"* NOT "personal"*', ''],
    ['meeting AND notes', '"meeting"* AND "notes"*', ''],
    ['meeting OR notes', '"meeting"* OR "notes"*', ''],
    ['foo OR "a b"', '"foo"* OR "a b"', ''],
    ['"exact phrase" AND other', '"exact phrase" AND "other"*', ''],
    ['a or not b', '"a"* "or"* "not"* "b"*', '"a or not b"*'],
    ['NOT foo', '"foo"*', ''],
    ['OR foo', '"foo"*', ''],
    ['foo NOT', '"foo"*', ''],
    ['foo OR', '"foo"*', ''],
    ['a OR NOT b', '"a"* NOT "b"*', ''],
    ['a AND OR b', '"a"* OR "b"*', ''],
    ['title:foo', '"title foo"*', ''],
    ['wi-fi router', '"wi fi"* "router"*', '"wi fi router"*'],
    ['he said "hello', '"he"* "said"* "hello"*', '"he said hello"*'],
    ['a"b c"d', '"a"* "b c" "d"*', ''],
    ['(chapter OR twelve)', '"chapter"* OR "twelve"*', ''],
    ['şifre café', '"şifre"* "café"*', '"şifre café"*']
  ]

  it.each(cases)('%s', (query, match, phrase) => {
    expect(parseSearchQuery(query)).toEqual({ match, phrase })
  })

  it.each(['', '   ', '"', '""', '*', ':', '()', '--', 'AND', 'OR', 'NOT', 'NOT OR AND'])(
    'builds nothing from %j',
    (query) => {
      expect(parseSearchQuery(query)).toEqual({ match: '', phrase: '' })
    }
  )
})
