import { describe, it, expect } from 'vitest'
import { isTreeNavKey, resolveTreeNavIntent, type TreeNavRow } from './tree-keyboard-nav'

/**
 * folder-work            (expanded)
 *   folder-work/specs    (collapsed, has children)
 *   note-a
 * folder-empty           (expanded, no children)
 * note-root
 */
const rows: TreeNavRow[] = [
  { id: 'folder-work', level: 0, isExpandable: true, isExpanded: true },
  { id: 'folder-work/specs', level: 1, isExpandable: true, isExpanded: false },
  { id: 'note-a', level: 1, isExpandable: false, isExpanded: false },
  { id: 'folder-empty', level: 0, isExpandable: true, isExpanded: true },
  { id: 'note-root', level: 0, isExpandable: false, isExpanded: false }
]

describe('isTreeNavKey', () => {
  it('claims the four arrows and nothing else', () => {
    expect(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].every(isTreeNavKey)).toBe(true)
    expect(isTreeNavKey('Enter')).toBe(false)
    expect(isTreeNavKey('a')).toBe(false)
  })
})

describe('resolveTreeNavIntent', () => {
  it('steps down and up the visible rows regardless of depth', () => {
    expect(resolveTreeNavIntent(rows, 'folder-work', 'ArrowDown')).toEqual({
      type: 'move',
      id: 'folder-work/specs',
      index: 1
    })
    expect(resolveTreeNavIntent(rows, 'folder-empty', 'ArrowUp')).toEqual({
      type: 'move',
      id: 'note-a',
      index: 2
    })
  })

  it('stops at the ends instead of wrapping', () => {
    expect(resolveTreeNavIntent(rows, 'folder-work', 'ArrowUp')).toBeNull()
    expect(resolveTreeNavIntent(rows, 'note-root', 'ArrowDown')).toBeNull()
  })

  it('enters the list from an empty selection, but only on a vertical arrow', () => {
    expect(resolveTreeNavIntent(rows, null, 'ArrowDown')).toEqual({
      type: 'move',
      id: 'folder-work',
      index: 0
    })
    expect(resolveTreeNavIntent(rows, null, 'ArrowRight')).toBeNull()
    expect(resolveTreeNavIntent(rows, 'gone', 'ArrowUp')).toEqual({
      type: 'move',
      id: 'folder-work',
      index: 0
    })
  })

  it('opens a closed folder with Right, then steps into it', () => {
    expect(resolveTreeNavIntent(rows, 'folder-work/specs', 'ArrowRight')).toEqual({
      type: 'expand',
      id: 'folder-work/specs'
    })
    expect(resolveTreeNavIntent(rows, 'folder-work', 'ArrowRight')).toEqual({
      type: 'move',
      id: 'folder-work/specs',
      index: 1
    })
  })

  it('leaves Right alone on a note and on an open folder with nothing inside', () => {
    expect(resolveTreeNavIntent(rows, 'note-a', 'ArrowRight')).toBeNull()
    expect(resolveTreeNavIntent(rows, 'folder-empty', 'ArrowRight')).toBeNull()
  })

  it('closes an open folder with Left, then walks out to the parent', () => {
    expect(resolveTreeNavIntent(rows, 'folder-work', 'ArrowLeft')).toEqual({
      type: 'collapse',
      id: 'folder-work'
    })
    expect(resolveTreeNavIntent(rows, 'note-a', 'ArrowLeft')).toEqual({
      type: 'move',
      id: 'folder-work',
      index: 0
    })
    expect(resolveTreeNavIntent(rows, 'folder-work/specs', 'ArrowLeft')).toEqual({
      type: 'move',
      id: 'folder-work',
      index: 0
    })
  })

  it('has nothing to do for Left on a root-level leaf', () => {
    expect(resolveTreeNavIntent(rows, 'note-root', 'ArrowLeft')).toBeNull()
  })

  it('does nothing on an empty tree or an unhandled key', () => {
    expect(resolveTreeNavIntent([], 'note-a', 'ArrowDown')).toBeNull()
    expect(resolveTreeNavIntent(rows, 'note-a', 'Enter')).toBeNull()
  })
})
