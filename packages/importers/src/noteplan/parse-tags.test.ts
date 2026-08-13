import { describe, it, expect } from 'vitest'
import { parseTags } from './parse-tags.ts'

describe('parseTags', () => {
  it('extracts hierarchical hashtags', () => {
    expect(parseTags('Source: #blogs/jamesclear, [[A Thousand Brains]]')).toEqual([
      'blogs/jamesclear'
    ])
  })

  it('extracts several tags and sorts them, deduplicated', () => {
    expect(parseTags('#books/decisive and #books/happinesshypothesis and #books/decisive')).toEqual(
      ['books/decisive', 'books/happinesshypothesis']
    )
  })

  it('does not treat markdown headings as tags', () => {
    expect(parseTags('# Heading\n## Sub heading')).toEqual([])
  })

  it('does not treat a mid-word hash as a tag', () => {
    expect(parseTags('issue no#42 here')).toEqual([])
  })

  it('ignores hashtags inside fenced code blocks', () => {
    expect(parseTags('```\nconst x = 1 // #nottag\n```\ntext #real')).toEqual(['real'])
  })
})
