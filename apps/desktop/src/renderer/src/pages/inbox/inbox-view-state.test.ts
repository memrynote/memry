import { describe, expect, it } from 'vitest'

import {
  INBOX_ITEM_TYPES,
  INBOX_NAV_KEYS,
  INBOX_SCROLL_KEYS,
  INBOX_VIEW_STATE_KEYS,
  parseBoolean,
  parseInboxView,
  parseItemId,
  parseTypeFilter
} from './inbox-view-state'

describe('inbox view-state keys', () => {
  it('never reuses a one-shot navigation key', () => {
    // `focusInboxItemId` / `focusedAt` / `focusCaptureAt` are written by OTHER
    // surfaces and consumed once through a nonce guard. Persisting our own
    // state under one of those names would re-fire their effect on restore.
    const persisted = Object.values(INBOX_VIEW_STATE_KEYS)
    for (const navKey of INBOX_NAV_KEYS) {
      expect(persisted).not.toContain(navKey)
    }
  })

  it('gives the list pane and the archived pane separate detail keys', () => {
    // The archived view has its own detail panel; sharing a key would open an
    // archived item in the list pane's drawer and vice versa.
    expect(INBOX_VIEW_STATE_KEYS.detailItemId).not.toBe(INBOX_VIEW_STATE_KEYS.archivedDetailItemId)
  })

  it('uses a distinct key per persisted value', () => {
    const persisted = Object.values(INBOX_VIEW_STATE_KEYS)
    expect(new Set(persisted).size).toBe(persisted.length)
  })

  it('uses a distinct scroll key per pane', () => {
    // One scroll record per tab: identical keys would apply the list's offset
    // to the insights pane.
    const keys = Object.values(INBOX_SCROLL_KEYS)
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe('inbox view-state readers', () => {
  it('accepts every sub-view name and rejects anything else', () => {
    expect(parseInboxView('inbox')).toBe('inbox')
    expect(parseInboxView('archived')).toBe('archived')
    expect(parseInboxView('insights')).toBe('insights')
    expect(parseInboxView('reminders')).toBeUndefined()
    expect(parseInboxView(2)).toBeUndefined()
    expect(parseInboxView(null)).toBeUndefined()
    expect(parseInboxView(undefined)).toBeUndefined()
  })

  it('keeps the known types in a filter and drops the rest', () => {
    expect(parseTypeFilter(['link', 'note'])).toEqual(['link', 'note'])
    // A type removed in a later build must not reach the filter.
    expect(parseTypeFilter(['link', 'telepathy', 7])).toEqual(['link'])
    expect(parseTypeFilter([])).toEqual([])
    expect(parseTypeFilter('link')).toBeUndefined()
    expect(parseTypeFilter(null)).toBeUndefined()
  })

  it('covers every item type the page can filter by', () => {
    expect(parseTypeFilter(INBOX_ITEM_TYPES)).toEqual(INBOX_ITEM_TYPES)
  })

  it('accepts only real booleans', () => {
    expect(parseBoolean(true)).toBe(true)
    expect(parseBoolean(false)).toBe(false)
    expect(parseBoolean('true')).toBeUndefined()
    expect(parseBoolean(1)).toBeUndefined()
  })

  it('treats null as "no item open" rather than "nothing stored"', () => {
    expect(parseItemId('item-1')).toBe('item-1')
    expect(parseItemId(null)).toBeNull()
    expect(parseItemId(12)).toBeUndefined()
    expect(parseItemId({ id: 'item-1' })).toBeUndefined()
  })
})
