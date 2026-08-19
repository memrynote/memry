import { describe, expect, it } from 'vitest'

import {
  FOLDER_SCROLL_KEYS,
  FOLDER_VIEW_STATE_KEYS,
  folderScrollKey,
  parseSearchOpen,
  parseSearchQuery,
  parseViewName
} from './folder-view-state'

describe('folder view-state keys', () => {
  it('uses a distinct key per persisted value', () => {
    const keys = Object.values(FOLDER_VIEW_STATE_KEYS)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('persists nothing that `.folder.md` already owns', () => {
    // The view type, columns, filters, order, groupBy, limit and showSummaries
    // all live in the folder's own config and are written back through
    // `updateView`. Mirroring any of them into tab state gives one value two
    // owners that overwrite each other on reload.
    const owned = [
      'type',
      'columns',
      'filters',
      'order',
      'groupBy',
      'collapsed',
      'limit',
      'showSummaries',
      'columnBorders'
    ]
    for (const name of Object.values(FOLDER_VIEW_STATE_KEYS)) {
      expect(owned).not.toContain(name)
    }
  })
})

describe('folderScrollKey', () => {
  it('gives every render mode its own scroller identity', () => {
    const keys = [
      folderScrollKey('table', false),
      folderScrollKey('table', true),
      folderScrollKey('list', false),
      folderScrollKey('grid', false)
    ]
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('separates the grouped table from the plain table', () => {
    // Different components with different row heights: applying one's offset to
    // the other lands on an unrelated row.
    expect(folderScrollKey('table', true)).toBe(FOLDER_SCROLL_KEYS.grouped)
    expect(folderScrollKey('table', false)).toBe(FOLDER_SCROLL_KEYS.table)
  })

  it('maps list and grid to their own non-virtualized panes', () => {
    expect(folderScrollKey('list', false)).toBe(FOLDER_SCROLL_KEYS.list)
    expect(folderScrollKey('grid', false)).toBe(FOLDER_SCROLL_KEYS.gallery)
  })

  it('grouping wins over nothing else: list and grid ignore it', () => {
    // `groupBy` only splits the TABLE. A grouped list still renders
    // `FolderListView`, so it must keep the list's key.
    expect(folderScrollKey('list', true)).toBe(FOLDER_SCROLL_KEYS.list)
    expect(folderScrollKey('grid', true)).toBe(FOLDER_SCROLL_KEYS.gallery)
  })

  it('treats an unknown render mode as the table it falls back to', () => {
    // `viewType` comes out of `.folder.md` and can name a mode this build does
    // not have; the page renders the table for it, so the key must match.
    expect(folderScrollKey('timeline', false)).toBe(FOLDER_SCROLL_KEYS.table)
  })
})

describe('folder view-state readers', () => {
  it('tells "no pinned view" apart from "nothing stored"', () => {
    // `null` is the user having no view pinned; it must reach the caller as a
    // value so the folder's own default is used rather than a stale name.
    expect(parseViewName('Board')).toBe('Board')
    expect(parseViewName(null)).toBeNull()
    expect(parseViewName(3)).toBeUndefined()
    expect(parseViewName(undefined)).toBeUndefined()
    expect(parseViewName({ name: 'Board' })).toBeUndefined()
  })

  it('keeps an empty search query, which is not the same as unset', () => {
    expect(parseSearchQuery('todo')).toBe('todo')
    expect(parseSearchQuery('')).toBe('')
    expect(parseSearchQuery(null)).toBeUndefined()
    expect(parseSearchQuery(7)).toBeUndefined()
  })

  it('accepts only real booleans for the search toggle', () => {
    expect(parseSearchOpen(true)).toBe(true)
    expect(parseSearchOpen(false)).toBe(false)
    expect(parseSearchOpen('true')).toBeUndefined()
    expect(parseSearchOpen(1)).toBeUndefined()
  })
})
