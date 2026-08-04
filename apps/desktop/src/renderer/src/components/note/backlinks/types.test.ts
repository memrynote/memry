import { describe, expect, it } from 'vitest'
import { backlinkId } from './types'

describe('backlinkId', () => {
  it('uses the bare sourceId for a wiki-link entry (via undefined)', () => {
    expect(backlinkId('note-a', undefined)).toBe('note-a')
  })

  it('suffixes the sourceId with the property name for a relation-property entry', () => {
    expect(backlinkId('note-a', { kind: 'property', propertyName: 'father' })).toBe(
      'note-a:property:father'
    )
  })

  it('produces two different ids for a source referenced both ways', () => {
    // This is the exact shape the page transforms (note.tsx, journal.tsx) hand
    // to BacklinksSection as `id` — it must stay unique per reference so
    // React doesn't key two sibling BacklinkCards identically.
    const wikiId = backlinkId('note-a', undefined)
    const propertyId = backlinkId('note-a', { kind: 'property', propertyName: 'father' })

    expect(wikiId).not.toBe(propertyId)
  })
})
