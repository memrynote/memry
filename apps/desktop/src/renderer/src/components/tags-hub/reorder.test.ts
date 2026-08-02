import { describe, it, expect } from 'vitest'
import { moveTag, moveCategory, applyTagAssignments, applyCategoryOrder } from './reorder'

const tag = (t: string, sortOrder: number) => ({
  tag: t,
  color: 'blue',
  icon: null,
  count: 1,
  sortOrder
})

const state = {
  categories: [
    { id: 'work', name: 'Work', sortOrder: 0, tags: [tag('meetings', 0), tag('okr', 1)] },
    { id: 'books', name: 'Books', sortOrder: 1, tags: [tag('general', 0)] }
  ],
  uncategorized: [tag('idea', 0)]
}

describe('moveTag', () => {
  it('moves a tag into another category at the requested index', () => {
    const result = moveTag(state, 'idea', 'work', 1)

    expect(result).toContainEqual({ tag: 'idea', categoryId: 'work', sortOrder: 1 })
    expect(result).toContainEqual({ tag: 'okr', categoryId: 'work', sortOrder: 2 })
  })

  it('reorders within a category without changing membership', () => {
    const result = moveTag(state, 'okr', 'work', 0)

    expect(result).toContainEqual({ tag: 'okr', categoryId: 'work', sortOrder: 0 })
    expect(result).toContainEqual({ tag: 'meetings', categoryId: 'work', sortOrder: 1 })
  })

  it('moves a tag out to uncategorized', () => {
    const result = moveTag(state, 'meetings', null, 0)

    expect(result).toContainEqual({ tag: 'meetings', categoryId: null, sortOrder: 0 })
    expect(result).toContainEqual({ tag: 'idea', categoryId: null, sortOrder: 1 })
  })

  it('emits contiguous sort orders for every touched category', () => {
    const result = moveTag(state, 'idea', 'work', 0)
    const work = result.filter((a) => a.categoryId === 'work').map((a) => a.sortOrder)
    expect(work.sort()).toEqual([0, 1, 2])
  })

  it('returns an empty list when the tag is unknown', () => {
    expect(moveTag(state, 'nope', 'work', 0)).toEqual([])
  })
})

describe('moveCategory', () => {
  it('renumbers categories from zero after a move', () => {
    const result = moveCategory(state.categories, 1, 0)
    expect(result).toEqual([
      { id: 'books', sortOrder: 0 },
      { id: 'work', sortOrder: 1 }
    ])
  })
})

describe('applyTagAssignments (optimistic render helper)', () => {
  it('moves a tag between buckets and preserves its color/icon/count', () => {
    const result = moveTag(state, 'idea', 'work', 1)
    const applied = applyTagAssignments(state.categories, state.uncategorized, result)

    const work = applied.categories.find((c) => c.id === 'work')!
    expect(work.tags.map((t) => t.tag)).toEqual(['meetings', 'idea', 'okr'])
    expect(work.tags.find((t) => t.tag === 'idea')).toMatchObject({
      color: 'blue',
      icon: null,
      count: 1
    })
    expect(applied.uncategorized).toEqual([])
  })

  it('is a no-op for an empty assignment list', () => {
    const applied = applyTagAssignments(state.categories, state.uncategorized, [])
    expect(applied.categories).toBe(state.categories)
    expect(applied.uncategorized).toBe(state.uncategorized)
  })
})

describe('applyCategoryOrder (optimistic render helper)', () => {
  it('re-sorts categories by the new sortOrder', () => {
    const result = moveCategory(state.categories, 1, 0)
    const applied = applyCategoryOrder(state.categories, result)
    expect(applied.map((c) => c.id)).toEqual(['books', 'work'])
  })

  it('is a no-op for an empty order list', () => {
    expect(applyCategoryOrder(state.categories, [])).toBe(state.categories)
  })
})
