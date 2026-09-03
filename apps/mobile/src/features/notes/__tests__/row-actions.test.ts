import { describe, expect, it } from 'vitest'

import {
  bookmarkRefFor,
  rowActionGroups,
  targetLabel,
  type RowActionId,
  type RowTarget
} from '@/features/notes/row-actions'

const note: RowTarget = {
  kind: 'note',
  id: 'n1',
  title: 'Sync protocol',
  folderPath: 'Work'
}
const folder: RowTarget = {
  kind: 'folder',
  path: 'Work/Interviews',
  name: 'Interviews',
  noteCount: 14
}

function ids(target: RowTarget, opts = { bookmarked: false, readOnly: false }): RowActionId[] {
  return rowActionGroups(target, opts)
    .flat()
    .map((action) => action.id)
}

describe('rowActionGroups', () => {
  it('offers the folder verbs only on a folder', () => {
    expect(ids(folder)).toEqual([
      'new-note',
      'new-folder',
      'duplicate',
      'move',
      'rename',
      'search-in-folder',
      'bookmark',
      'delete'
    ])
    expect(ids(note)).toEqual(['duplicate', 'move', 'rename', 'share', 'bookmark', 'delete'])
  })

  it('never puts a folder-only verb on a note', () => {
    for (const id of ids(note)) {
      expect(['new-note', 'new-folder', 'search-in-folder']).not.toContain(id)
    }
  })

  it('flips the bookmark verb instead of adding a second one', () => {
    const bookmarked = ids(note, { bookmarked: true, readOnly: false })
    expect(bookmarked).toContain('unbookmark')
    expect(bookmarked).not.toContain('bookmark')
  })

  it('drops every write in read-only mode and keeps the reads', () => {
    // Read-only is the server saying "no writes", not "no reading": search and
    // share still answer, so refusing them would be punishing the user for a
    // kill switch they did not flip.
    expect(ids(folder, { bookmarked: false, readOnly: true })).toEqual([
      'search-in-folder',
      'bookmark'
    ])
    expect(ids(note, { bookmarked: false, readOnly: true })).toEqual(['share', 'bookmark'])
  })

  it('leaves no empty group for the menu to draw a band around', () => {
    for (const target of [note, folder]) {
      for (const readOnly of [false, true]) {
        const groups = rowActionGroups(target, { bookmarked: false, readOnly })
        expect(groups.every((group) => group.length > 0)).toBe(true)
      }
    }
  })

  it('puts the one destructive action alone at the end', () => {
    for (const target of [note, folder]) {
      const groups = rowActionGroups(target, { bookmarked: false, readOnly: false })
      const last = groups[groups.length - 1]
      expect(last).toHaveLength(1)
      expect(last[0].destructive).toBe(true)
      expect(
        groups
          .slice(0, -1)
          .flat()
          .some((action) => action.destructive)
      ).toBe(false)
    }
  })
})

describe('bookmarkRefFor', () => {
  it('bookmarks a note by id and a folder by path', () => {
    expect(bookmarkRefFor(note)).toEqual({ itemType: 'note', itemId: 'n1' })
    expect(bookmarkRefFor(folder)).toEqual({ itemType: 'folder', itemId: 'Work/Interviews' })
  })
})

describe('targetLabel', () => {
  it('uses the leaf name for a folder, not its path', () => {
    expect(targetLabel(folder)).toBe('Interviews')
    expect(targetLabel(note)).toBe('Sync protocol')
  })
})
