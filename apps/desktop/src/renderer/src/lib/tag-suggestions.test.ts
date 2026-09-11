import { describe, expect, it } from 'vitest'

import { rankTagSuggestions, type TagSuggestion } from './tag-suggestions'

const tags: TagSuggestion[] = [
  { name: 'work', color: 'blue', count: 12 },
  { name: 'work/design', count: 7 },
  { name: 'homework', count: 30 },
  { name: 'personal', color: '#ff0000', count: 9 },
  { name: 'projects/website', count: 4 }
]

describe('rankTagSuggestions', () => {
  it('offers the most-used tags when nothing is typed', () => {
    expect(rankTagSuggestions(tags, '', 3).map((t) => t.name)).toEqual([
      'homework',
      'work',
      'personal'
    ])
  })

  it('puts an exact match first, then prefixes, then leaf and substring matches', () => {
    // `homework` has the highest count but only matches as a substring, so it
    // must rank below every prefix match.
    expect(rankTagSuggestions(tags, 'work', 5).map((t) => t.name)).toEqual([
      'work',
      'work/design',
      'homework'
    ])
  })

  it('finds a nested tag by its leaf segment', () => {
    expect(rankTagSuggestions(tags, 'des', 5).map((t) => t.name)).toEqual(['work/design'])
  })

  it('ignores case and a leading hash', () => {
    expect(rankTagSuggestions(tags, '  #PERSONAL ', 5).map((t) => t.name)).toEqual(['personal'])
  })

  it('drops non-matching tags and respects the limit', () => {
    expect(rankTagSuggestions(tags, 'zzz', 5)).toEqual([])
    expect(rankTagSuggestions(tags, '', 2)).toHaveLength(2)
    expect(rankTagSuggestions(tags, '', 0)).toEqual([])
  })

  it('collapses duplicate names differing only by case and skips blanks', () => {
    const dupes: TagSuggestion[] = [
      { name: 'Work', count: 3 },
      { name: 'work', count: 99 },
      { name: '   ', count: 50 }
    ]
    expect(rankTagSuggestions(dupes, '', 5)).toEqual([{ name: 'Work', count: 3 }])
  })
})
