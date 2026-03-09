import { describe, it, expect } from 'vitest'
import { highlightTerms, stripMarkTags } from './search-service'

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
