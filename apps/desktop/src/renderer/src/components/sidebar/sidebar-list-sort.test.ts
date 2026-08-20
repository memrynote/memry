import { describe, it, expect } from 'vitest'
import { compareListItems, isReorderable, type SortableListItem } from './sidebar-list-sort'

// Stored order, name order and creation order all disagree, so a comparator
// reading the wrong field cannot pass by coincidence.
const ITEMS: SortableListItem[] = [
  { name: 'Beta', position: 0, created: 300 },
  { name: 'alpha', position: 1, created: 100 },
  { name: 'Gamma', position: 2, created: 200 }
]

const order = (mode: Parameters<typeof compareListItems>[0]): string[] =>
  [...ITEMS].sort(compareListItems(mode)).map((i) => i.name)

describe('sidebar list sort', () => {
  it('uses the stored position in manual mode', () => {
    expect(order('manual')).toEqual(['Beta', 'alpha', 'Gamma'])
  })

  it('sorts by name in both directions', () => {
    expect(order('name-asc')).toEqual(['alpha', 'Beta', 'Gamma'])
    expect(order('name-desc')).toEqual(['Gamma', 'Beta', 'alpha'])
  })

  it('sorts by creation time in both directions', () => {
    expect(order('created-desc')).toEqual(['Beta', 'Gamma', 'alpha'])
    expect(order('created-asc')).toEqual(['alpha', 'Gamma', 'Beta'])
  })

  // Projects and bookmarks carry no modification time. Falling back to the
  // stored order keeps the list stable instead of shuffling it arbitrarily.
  it('falls back to the stored order when the mode reads a field the item lacks', () => {
    expect(order('modified-desc')).toEqual(['Beta', 'alpha', 'Gamma'])
    expect(order('modified-asc')).toEqual(['Beta', 'alpha', 'Gamma'])
  })

  it('breaks a position tie by name so the order never flickers', () => {
    const tied: SortableListItem[] = [
      { name: 'zeta', position: 0 },
      { name: 'apple', position: 0 }
    ]
    expect([...tied].sort(compareListItems('manual')).map((i) => i.name)).toEqual(['apple', 'zeta'])
  })

  // Dragging a row that a sort mode placed would write a position the mode then
  // ignores — the reorder would appear to do nothing.
  it('allows drag-to-reorder only in manual mode', () => {
    expect(isReorderable('manual')).toBe(true)
    for (const mode of ['name-asc', 'name-desc', 'created-desc', 'modified-asc'] as const) {
      expect(isReorderable(mode)).toBe(false)
    }
  })
})
