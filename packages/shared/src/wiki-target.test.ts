import { describe, it, expect } from 'vitest'
import { splitWikiTarget, isBlockReference, normalizeHeading } from './wiki-target'

describe('splitWikiTarget', () => {
  it('leaves a plain target alone', () => {
    expect(splitWikiTarget('My Note')).toEqual({ note: 'My Note', heading: null })
  })

  it('splits note and heading', () => {
    expect(splitWikiTarget('Meeting#Decisions')).toEqual({
      note: 'Meeting',
      heading: 'Decisions'
    })
  })

  it('trims either half', () => {
    expect(splitWikiTarget('  Meeting # Decisions  ')).toEqual({
      note: 'Meeting',
      heading: 'Decisions'
    })
  })

  it('takes the last segment of a nested heading path', () => {
    expect(splitWikiTarget('Meeting#Q3#Decisions')).toEqual({
      note: 'Meeting',
      heading: 'Decisions'
    })
  })

  it('reports an empty note half for a same-note link', () => {
    expect(splitWikiTarget('#Decisions')).toEqual({ note: '', heading: 'Decisions' })
  })

  it('keeps a block reference in the heading half rather than the note half', () => {
    expect(splitWikiTarget('Meeting#^abc123')).toEqual({
      note: 'Meeting',
      heading: '^abc123'
    })
  })

  it('distinguishes "no heading" from "empty heading"', () => {
    expect(splitWikiTarget('Meeting').heading).toBeNull()
    expect(splitWikiTarget('Meeting#').heading).toBe('')
  })

  // The `Sprint #4` case: splitting alone is wrong, which is why callers keep
  // the raw string as a fallback. This asserts what the split reports, not what
  // the caller concludes.
  it('splits a title that merely contains a hash', () => {
    expect(splitWikiTarget('Sprint #4')).toEqual({ note: 'Sprint', heading: '4' })
  })
})

describe('isBlockReference', () => {
  it('recognises a block reference', () => {
    expect(isBlockReference('^abc123')).toBe(true)
  })

  it('does not mistake a heading for one', () => {
    expect(isBlockReference('Decisions')).toBe(false)
  })
})

describe('normalizeHeading', () => {
  it('folds case and trims', () => {
    expect(normalizeHeading('  Decisions ')).toBe(normalizeHeading('decisions'))
  })
})
