import { describe, expect, it } from 'vitest'
import { extractInlineTagsFromMarkdown } from './inline-tags'

describe('extractInlineTagsFromMarkdown', () => {
  it('extracts a single tag', () => {
    expect(extractInlineTagsFromMarkdown('Hello #world')).toEqual(['world'])
  })

  it('extracts multiple tags', () => {
    expect(extractInlineTagsFromMarkdown('#foo and #bar')).toEqual(['foo', 'bar'])
  })

  it('deduplicates repeated tags', () => {
    expect(extractInlineTagsFromMarkdown('#foo then #foo again')).toEqual(['foo'])
  })

  it('preserves case as typed', () => {
    expect(extractInlineTagsFromMarkdown('#Work #URGENT')).toEqual(['Work', 'URGENT'])
  })

  it('deduplicates case variants, first occurrence wins', () => {
    expect(extractInlineTagsFromMarkdown('#Work then #work again')).toEqual(['Work'])
  })

  it('skips tags inside fenced code blocks', () => {
    const content = 'before #real\n```\n#fake\n```\nafter #also-real'
    expect(extractInlineTagsFromMarkdown(content)).toEqual(['real', 'also-real'])
  })

  it('skips tags inside inline code', () => {
    expect(extractInlineTagsFromMarkdown('use `#hidden` but #visible')).toEqual(['visible'])
  })

  it('requires whitespace or start-of-string before #', () => {
    expect(extractInlineTagsFromMarkdown('email@user#tag')).toEqual([])
  })

  it('matches tag after newline', () => {
    expect(extractInlineTagsFromMarkdown('line one\n#tag')).toEqual(['tag'])
  })

  it('rejects tags starting with a digit', () => {
    expect(extractInlineTagsFromMarkdown('#123 #456abc')).toEqual([])
  })

  it('allows hyphens and underscores', () => {
    expect(extractInlineTagsFromMarkdown('#my-tag #my_tag')).toEqual(['my-tag', 'my_tag'])
  })

  it('returns empty array for empty string', () => {
    expect(extractInlineTagsFromMarkdown('')).toEqual([])
  })

  it('handles tag at very start of content', () => {
    expect(extractInlineTagsFromMarkdown('#first word')).toEqual(['first'])
  })

  it('extracts hierarchical tags with slashes', () => {
    expect(extractInlineTagsFromMarkdown('#movies/oscar and #movies/grammy')).toEqual([
      'movies/oscar',
      'movies/grammy'
    ])
  })

  it('extracts deeply nested hierarchical tags', () => {
    expect(extractInlineTagsFromMarkdown('#a/b/c/d')).toEqual(['a/b/c/d'])
  })

  it('does not capture trailing slash', () => {
    expect(extractInlineTagsFromMarkdown('#movies/ rest')).toEqual(['movies'])
  })
})
