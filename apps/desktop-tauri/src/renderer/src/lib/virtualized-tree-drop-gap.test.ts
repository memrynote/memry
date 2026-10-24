import { describe, it, expect } from 'vitest'
import { dropGapStartIndex } from './virtualized-tree-utils'

const rows = ['a', 'b', 'c']
const indexOf = (id: string): number => rows.indexOf(id)

describe('drop gap start index', () => {
  it('pushes the target row down when dropping before it', () => {
    expect(dropGapStartIndex('b', 'before', indexOf)).toBe(1)
  })

  it('pushes the row below down when dropping after it', () => {
    expect(dropGapStartIndex('b', 'after', indexOf)).toBe(2)
  })

  // Dropping INTO a folder moves the item inside it; nothing slides apart.
  it('opens no gap for an inside drop', () => {
    expect(dropGapStartIndex('b', 'inside', indexOf)).toBeNull()
  })

  it('opens no gap while nothing is being dropped', () => {
    expect(dropGapStartIndex(null, null, indexOf)).toBeNull()
    expect(dropGapStartIndex('b', null, indexOf)).toBeNull()
  })

  // A row can leave the flattened list mid-drag when a folder collapses.
  it('opens no gap for a target that is no longer rendered', () => {
    expect(dropGapStartIndex('gone', 'before', indexOf)).toBeNull()
  })

  it('can open a gap past the last row', () => {
    expect(dropGapStartIndex('c', 'after', indexOf)).toBe(3)
  })
})
