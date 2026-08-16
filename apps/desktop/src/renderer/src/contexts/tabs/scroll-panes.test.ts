import { describe, expect, it } from 'vitest'

import { MAX_SCROLL_PANES, mergeScrollPanes, readScrollPane } from './scroll-panes'
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
    let panes: TabScrollPanes = { keeper: entry(10) }
    for (let i = 0; i < MAX_SCROLL_PANES; i += 1) {
      panes = mergeScrollPanes(panes, { [`pane-${i}`]: entry(i) })
      panes = mergeScrollPanes(panes, { keeper: entry(10 + i) })
    }

    expect(panes.keeper).toEqual(entry(10 + MAX_SCROLL_PANES - 1))
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
