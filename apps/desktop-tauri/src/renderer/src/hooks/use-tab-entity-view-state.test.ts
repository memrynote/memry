import { describe, expect, it } from 'vitest'

import { readStampedTabValue } from './use-tab-entity-view-state'

describe('readStampedTabValue', () => {
  it('returns the stored value for the entity it was written against', () => {
    expect(readStampedTabValue({ entityId: 'file-a', value: 5 }, 'file-a', 1)).toBe(5)
  })

  it('refuses a value stamped with another entity', () => {
    // A preview file tab keeps its id and its viewState while the file inside
    // it changes; page 5 of the previous PDF must not be applied to the next.
    expect(readStampedTabValue({ entityId: 'file-a', value: 5 }, 'file-b', 1)).toBe(1)
  })

  it('matches an unstamped value only against an entity-less tab', () => {
    // Journal, Calendar and Tags tabs carry no entityId at all.
    expect(readStampedTabValue({ value: 5 }, undefined, 1)).toBe(5)
    expect(readStampedTabValue({ value: 5 }, 'file-a', 1)).toBe(1)
    expect(readStampedTabValue({ entityId: 'file-a', value: 5 }, undefined, 1)).toBe(1)
  })

  it('falls back when nothing is stored', () => {
    expect(readStampedTabValue(undefined, 'file-a', 1)).toBe(1)
  })

  it('returns a stored falsy value rather than the fallback', () => {
    // `0` is a real playback position and `false` a real sidebar state; the
    // read must not be guarded on truthiness.
    expect(readStampedTabValue({ entityId: 'f', value: 0 }, 'f', 42)).toBe(0)
    expect(readStampedTabValue({ entityId: 'f', value: false }, 'f', true)).toBe(false)
    expect(readStampedTabValue({ entityId: 'f', value: null }, 'f', 3)).toBeNull()
  })
})
