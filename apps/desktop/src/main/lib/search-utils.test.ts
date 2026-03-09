import { describe, it, expect } from 'vitest'
import {
  escapeSearchQuery,
  buildPrefixQuery,
  normalizeScores,
  truncateQuery,
  parseSearchQuery,
  extractSnippet
} from './search-utils'
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

describe('escapeSearchQuery', () => {
  it('strips FTS5 special characters', () => {
    // #given
    const input = 'hello*world"test()'

    // #when
    const result = escapeSearchQuery(input)

    // #then
    expect(result).toBe('hello world test')
  })

  it('trims whitespace', () => {
    expect(escapeSearchQuery('  hello  ')).toBe('hello')
  })

  it('returns empty string for special-chars-only input', () => {
    expect(escapeSearchQuery('***""()')).toBe('')
  })

  it('passes through normal text unchanged', () => {
    expect(escapeSearchQuery('meeting notes')).toBe('meeting notes')
  })
})

describe('buildPrefixQuery', () => {
  it('adds wildcard suffix to each term', () => {
    // #given
    const query = 'hello world'

    // #when
    const result = buildPrefixQuery(query)

    // #then
    expect(result).toBe('"hello"* "world"*')
  })

  it('returns empty string for empty input', () => {
    expect(buildPrefixQuery('')).toBe('')
  })

  it('returns empty string for special-chars-only input', () => {
    expect(buildPrefixQuery('***')).toBe('')
  })

  it('handles single term', () => {
    expect(buildPrefixQuery('meet')).toBe('"meet"*')
  })
})

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
  it('returns empty string for empty input', () => {
    expect(parseSearchQuery('')).toBe('')
    expect(parseSearchQuery('   ')).toBe('')
  })

  it('wraps plain terms with prefix wildcard', () => {
    const result = parseSearchQuery('hello world')
    expect(result).toContain('"hello"*')
    expect(result).toContain('"world"*')
  })

  it('preserves quoted phrases', () => {
    const result = parseSearchQuery('"meeting notes"')
    expect(result).toContain('"meeting notes"')
  })

  it('handles NOT operator', () => {
    const result = parseSearchQuery('meeting NOT personal')
    expect(result).toContain('NOT "personal"*')
  })

  it('handles AND operator', () => {
    const result = parseSearchQuery('meeting AND notes')
    expect(result).toContain('AND')
    expect(result).toContain('"notes"*')
  })

  it('handles OR operator', () => {
    const result = parseSearchQuery('meeting OR notes')
    expect(result).toContain('OR')
  })

  it('ignores dangling operators', () => {
    const result = parseSearchQuery('AND')
    expect(result).toBe('')
  })

  it('combines phrases with operators', () => {
    const result = parseSearchQuery('"exact phrase" AND other')
    expect(result).toContain('"exact phrase"')
    expect(result).toContain('AND')
    expect(result).toContain('"other"*')
  })
})

describe('extractSnippet', () => {
  it('returns content around matched term', () => {
    // #given
    const content =
      'This is a long piece of text where the keyword appears somewhere in the middle of the content for testing.'
    const query = 'keyword'

    // #when
    const result = extractSnippet(content, query, 20)

    // #then
    expect(result).toContain('keyword')
    expect(result.length).toBeLessThan(content.length)
  })

  it('adds ellipsis prefix when match is not at start', () => {
    const content = 'Some prefix text before the searchterm is located here.'
    const result = extractSnippet(content, 'searchterm', 10)
    expect(result.startsWith('...')).toBe(true)
  })

  it('returns start of content when no match found', () => {
    const content = 'Hello world this is content'
    const result = extractSnippet(content, 'xyz', 10)
    expect(result).toBe(content.slice(0, 20))
  })

  it('handles empty query', () => {
    const content = 'Hello world'
    const result = extractSnippet(content, '', 10)
    expect(result).toBe(content.slice(0, 20))
  })

  it('handles empty content', () => {
    const result = extractSnippet('', 'test', 10)
    expect(result).toBe('')
  })
})
