import { describe, expect, it } from 'vitest'

import {
  TAGS_HUB_SCROLL_KEY,
  TAGS_HUB_VIEW_STATE_KEYS,
  parseTagsHubQuery
} from './tags-hub-view-state'

describe('tags hub view state', () => {
  it('persists nothing the hub already owns as data', () => {
    // Categories, their order and every tag's placement round-trip through IPC.
    // Mirroring any of them into tab state gives one value two owners.
    const owned = ['categories', 'uncategorized', 'order', 'tags']
    for (const key of Object.values(TAGS_HUB_VIEW_STATE_KEYS)) {
      expect(owned).not.toContain(key)
    }
  })

  it('keeps the search key and the scroll key apart', () => {
    expect(Object.values(TAGS_HUB_VIEW_STATE_KEYS)).not.toContain(TAGS_HUB_SCROLL_KEY)
  })

  it('keeps an empty query, which is not the same as unset', () => {
    expect(parseTagsHubQuery('proj')).toBe('proj')
    expect(parseTagsHubQuery('')).toBe('')
    expect(parseTagsHubQuery(null)).toBeUndefined()
    expect(parseTagsHubQuery(3)).toBeUndefined()
  })
})
