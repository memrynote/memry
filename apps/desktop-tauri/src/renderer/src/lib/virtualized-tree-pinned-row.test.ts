/**
 * Pinned virtual row (#1986).
 *
 * The sidebar icon picker is a popover rendered inside its row, so a row the
 * virtualizer drops while scrolling takes the open panel down with it and the
 * picker looks like it closed itself. The virtualizer's `rangeExtractor` runs
 * this to keep that one row rendered wherever the list is scrolled.
 */

import { describe, it, expect } from 'vitest'
import { withPinnedIndex } from './virtualized-tree-utils'

describe('withPinnedIndex', () => {
  it('adds the pinned row when the virtual window scrolled past it', () => {
    expect(withPinnedIndex([40, 41, 42], 5)).toEqual([5, 40, 41, 42])
  })

  it('keeps the result ascending when the pinned row is below the window', () => {
    expect(withPinnedIndex([10, 11, 12], 99)).toEqual([10, 11, 12, 99])
  })

  it('returns the window untouched while the pinned row is still in it', () => {
    const indexes = [4, 5, 6]
    expect(withPinnedIndex(indexes, 5)).toBe(indexes)
  })

  // -1 is "no picker open" — the common case, and it must not add a row.
  it('returns the window untouched when nothing is pinned', () => {
    const indexes = [4, 5, 6]
    expect(withPinnedIndex(indexes, -1)).toBe(indexes)
  })
})
