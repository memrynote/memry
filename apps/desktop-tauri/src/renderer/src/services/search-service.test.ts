import { describe, it, expect, beforeEach, vi } from 'vitest'

const commands = vi.hoisted(() => ({
  searchQuery: vi.fn(),
  searchQuick: vi.fn(),
  searchGetStats: vi.fn(),
  searchGetReasons: vi.fn(),
  searchAddReason: vi.fn(),
  searchClearReasons: vi.fn()
}))

vi.mock('../../../generated/bindings', () => ({ commands }))

import { highlightTerms, searchService, stripMarkTags } from './search-service'

describe('searchService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('asks a quick search for every file type when none is given', async () => {
    commands.searchQuick.mockResolvedValue({ results: [], queryTimeMs: 1 })
    await searchService.quick('road')
    expect(commands.searchQuick).toHaveBeenCalledWith('road', null)
    await searchService.quick('road', ['markdown'])
    expect(commands.searchQuick).toHaveBeenLastCalledWith('road', ['markdown'])
  })

  it('answers a cleared list as the palette expects it', async () => {
    commands.searchClearReasons.mockResolvedValue(null)
    await expect(searchService.clearReasons()).resolves.toEqual({ cleared: true })
  })

  it('lets a refused command reach the caller', async () => {
    const refused = { kind: 'invalid', code: 'invalid', message: 'invalid limit' }
    commands.searchQuery.mockRejectedValue(refused)
    await expect(searchService.query({ text: 'x', limit: 0 })).rejects.toEqual(refused)
  })
})

describe('stripMarkTags', () => {
  it('removes <mark> and </mark> tags', () => {
    expect(stripMarkTags('<mark>hello</mark> world')).toBe('hello world')
  })

  it('handles multiple mark tags', () => {
    expect(stripMarkTags('<mark>a</mark> and <mark>b</mark>')).toBe('a and b')
  })

  it('is case-insensitive', () => {
    expect(stripMarkTags('<MARK>test</MARK>')).toBe('test')
  })

  it('returns unchanged text with no mark tags', () => {
    expect(stripMarkTags('plain text')).toBe('plain text')
  })

  it('handles empty string', () => {
    expect(stripMarkTags('')).toBe('')
  })
})

describe('highlightTerms', () => {
  it('splits text into highlighted and non-highlighted segments', () => {
    // #given
    const text = 'hello world hello'
    const query = 'hello'

    // #when
    const segments = highlightTerms(text, query)

    // #then
    const highlighted = segments.filter((s) => s.highlight)
    expect(highlighted.length).toBeGreaterThanOrEqual(1)
    expect(highlighted[0].text.toLowerCase()).toBe('hello')
  })

  it('returns single non-highlighted segment for empty query', () => {
    const segments = highlightTerms('some text', '')
    expect(segments).toEqual([{ text: 'some text', highlight: false }])
  })

  it('returns single non-highlighted segment for whitespace query', () => {
    const segments = highlightTerms('some text', '   ')
    expect(segments).toEqual([{ text: 'some text', highlight: false }])
  })

  it('handles case-insensitive matching', () => {
    const segments = highlightTerms('Hello World', 'hello')
    const highlighted = segments.filter((s) => s.highlight)
    expect(highlighted.length).toBe(1)
    expect(highlighted[0].text).toBe('Hello')
  })

  it('highlights multiple different terms', () => {
    const segments = highlightTerms('the quick brown fox', 'quick fox')
    const highlighted = segments.filter((s) => s.highlight)
    expect(highlighted).toHaveLength(2)
  })

  it('handles text with no matches', () => {
    const segments = highlightTerms('hello world', 'xyz')
    const highlighted = segments.filter((s) => s.highlight)
    expect(highlighted).toHaveLength(0)
  })

  it('escapes regex special characters in query', () => {
    const segments = highlightTerms('price is $100', '$100')
    expect(segments.some((s) => s.highlight && s.text === '$100')).toBe(true)
  })
})
