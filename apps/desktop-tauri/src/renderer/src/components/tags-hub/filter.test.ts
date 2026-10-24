import { describe, it, expect } from 'vitest'
import { filterHub } from './filter'

const tag = (t: string) => ({ tag: t, color: 'blue', icon: null, count: 1, sortOrder: 0 })

const state = {
  categories: [
    { id: 'work', name: 'Work', sortOrder: 0, tags: [tag('meetings'), tag('okr')] },
    { id: 'books', name: 'Books', sortOrder: 1, tags: [tag('general')] }
  ],
  uncategorized: [tag('work-backlog'), tag('idea')]
}

describe('filterHub', () => {
  it('returns everything for an empty query', () => {
    expect(filterHub(state, '')).toEqual(state)
  })

  it('keeps every tag of a category whose name matches', () => {
    const result = filterHub(state, 'work')
    expect(result.categories.find((c) => c.id === 'work')?.tags).toHaveLength(2)
  })

  it('keeps only matching tags in a non-matching category', () => {
    const result = filterHub(state, 'work')
    expect(result.uncategorized.map((t) => t.tag)).toEqual(['work-backlog'])
  })

  it('drops categories with no match at all', () => {
    const result = filterHub(state, 'work')
    expect(result.categories.map((c) => c.id)).toEqual(['work'])
  })

  it('is case-insensitive', () => {
    expect(filterHub(state, 'WORK').categories.map((c) => c.id)).toEqual(['work'])
  })
})
