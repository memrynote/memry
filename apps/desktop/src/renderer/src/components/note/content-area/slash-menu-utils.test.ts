import { describe, expect, it } from 'vitest'

import { orderSlashMenuItemsByGroup } from './slash-menu-utils'

const groups = <T extends { group?: string }>(items: T[]) => items.map((i) => i.group)

describe('orderSlashMenuItemsByGroup', () => {
  it('collapses non-contiguous duplicate groups into one contiguous run', () => {
    // The real bug: default "Basic blocks" items appear at the front, while the
    // appended Callout/Task items (also "Basic blocks") land at the back, so the
    // group renders twice with the same React key and leaves ghost headers.
    const items = [
      { title: 'Paragraph', group: 'Basic blocks' },
      { title: 'Image', group: 'Media' },
      { title: 'Callout', group: 'Basic blocks' },
      { title: 'Task', group: 'Basic blocks' }
    ]

    const ordered = orderSlashMenuItemsByGroup(items)

    // "Basic blocks" must appear exactly once in the group sequence.
    expect(groups(ordered)).toEqual(['Basic blocks', 'Basic blocks', 'Basic blocks', 'Media'])
    expect(groups(ordered).filter((g) => g === 'Basic blocks')).toHaveLength(3)
    expect(new Set(groups(ordered)).size).toBe(2)
  })

  it('preserves first-seen group order and within-group order', () => {
    const items = [
      { title: 'a', group: 'B' },
      { title: 'b', group: 'A' },
      { title: 'c', group: 'B' },
      { title: 'd', group: 'A' }
    ]

    const ordered = orderSlashMenuItemsByGroup(items)

    expect(ordered.map((i) => i.title)).toEqual(['a', 'c', 'b', 'd'])
    expect(groups(ordered)).toEqual(['B', 'B', 'A', 'A'])
  })

  it('handles items without a group without throwing', () => {
    const items = [{ title: 'x' }, { title: 'y', group: 'G' }, { title: 'z' }]

    const ordered = orderSlashMenuItemsByGroup(items)

    expect(ordered.map((i) => i.title)).toEqual(['x', 'z', 'y'])
    expect(groups(ordered)).toEqual([undefined, undefined, 'G'])
  })

  it('returns an empty array unchanged', () => {
    expect(orderSlashMenuItemsByGroup([])).toEqual([])
  })
})
