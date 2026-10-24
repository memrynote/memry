import { describe, expect, it } from 'vitest'

import {
  MAX_SCROLL_PANES,
  isRestorableEntry,
  mergeScrollPanes,
  readScrollPane
} from './scroll-panes'
import type { Tab, TabScrollPanes } from './types'

const entry = (offset: number): { offset: number } => ({ offset })

describe('mergeScrollPanes', () => {
  it('merges a pane patch without disturbing the other panes', () => {
    const current: TabScrollPanes = { list: entry(250), archived: entry(700) }

    expect(mergeScrollPanes(current, { list: entry(310) })).toEqual({
      list: entry(310),
      archived: entry(700)
    })
  })

  it('drops the least recently written pane once the map is over the bound', () => {
    // The session is serialised to local storage, which has a size ceiling the
    // user gets toasted about — a tab cannot accumulate a pane per view forever.
    let panes: TabScrollPanes = {}
    for (let i = 0; i < MAX_SCROLL_PANES + 3; i += 1) {
      panes = mergeScrollPanes(panes, { [`pane-${i}`]: entry(i) })
    }

    expect(Object.keys(panes)).toHaveLength(MAX_SCROLL_PANES)
    expect(panes['pane-0']).toBeUndefined()
    expect(panes['pane-2']).toBeUndefined()
    expect(panes['pane-3']).toEqual(entry(3))
    expect(panes[`pane-${MAX_SCROLL_PANES + 2}`]).toEqual(entry(MAX_SCROLL_PANES + 2))
  })

  it('re-writing a pane keeps it alive against eviction', () => {
    // The pane the user keeps coming back to must not be evicted just because
    // it was the FIRST one they ever scrolled — a write is a use.
    let panes: TabScrollPanes = { keeper: entry(10) }
    for (let i = 0; i < MAX_SCROLL_PANES; i += 1) {
      // Re-written BEFORE the newcomer, so only recency (not insertion) saves it.
      panes = mergeScrollPanes(panes, { keeper: entry(10 + i) })
      panes = mergeScrollPanes(panes, { [`pane-${i}`]: entry(i) })
    }

    expect(Object.keys(panes)).toHaveLength(MAX_SCROLL_PANES)
    expect(panes.keeper).toEqual(entry(10 + MAX_SCROLL_PANES - 1))
    expect(panes['pane-0']).toBeUndefined()
  })
})

describe('readScrollPane', () => {
  it('prefers the pane map over a legacy record for the same pane', () => {
    const tab = {
      scrollPanes: { list: { offset: 250, entityId: 'note-1' } },
      scrollState: { offset: 900, entityId: 'note-1', key: 'list' }
    } as unknown as Tab

    expect(readScrollPane(tab, 'list')).toEqual({ offset: 250, entityId: 'note-1' })
  })

  it('reads a legacy record as the entry for the pane it names', () => {
    const tab = { scrollState: { offset: 900, entityId: 'note-1', key: 'list' } } as unknown as Tab

    expect(readScrollPane(tab, 'list')).toEqual({ offset: 900, entityId: 'note-1' })
    expect(readScrollPane(tab, 'archived')).toBeUndefined()
    expect(readScrollPane(tab)).toBeUndefined()
  })
})

describe('isRestorableEntry', () => {
  it("accepts an entry stamped with the tab's current entity", () => {
    expect(isRestorableEntry({ offset: 120, entityId: 'note-1' }, 'note-1')).toBe(true)
    expect(isRestorableEntry({ offset: 120 }, undefined)).toBe(true)
  })

  it('rejects an entry whose entity the tab has navigated away from', () => {
    expect(isRestorableEntry({ offset: 120, entityId: 'note-1' }, 'note-2')).toBe(false)
    expect(isRestorableEntry({ offset: 120 }, 'note-2')).toBe(false)
    expect(isRestorableEntry({ offset: 120, entityId: 'note-1' }, undefined)).toBe(false)
  })

  it('accepts `0`, which is a position and not an absence', () => {
    expect(isRestorableEntry({ offset: 0 }, undefined)).toBe(true)
  })

  it('rejects nothing stored, and a non-finite offset written by an older build', () => {
    expect(isRestorableEntry(undefined, undefined)).toBe(false)
    expect(isRestorableEntry({ offset: Number.NaN }, undefined)).toBe(false)
    expect(isRestorableEntry({ offset: Number.POSITIVE_INFINITY }, undefined)).toBe(false)
  })
})
