import { describe, it, expect } from 'vitest'
import {
  splitWikiTarget,
  isBlockReference,
  normalizeHeading,
  wikiLinkLabel,
  replaceWikiLinks
} from './wiki-target'

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

describe('wikiLinkLabel', () => {
  it('drops the heading half, keeping the note (#1556)', () => {
    expect(wikiLinkLabel('Sprint Notes#Retro')).toBe('Sprint Notes')
  })

  it('prefers the alias over either half', () => {
    expect(wikiLinkLabel('Sprint Notes#Retro', 'retro')).toBe('retro')
  })

  it('ignores a blank alias', () => {
    expect(wikiLinkLabel('Sprint Notes', '   ')).toBe('Sprint Notes')
  })

  it('reads a self-link as its heading, the only text it carries', () => {
    expect(wikiLinkLabel('#Decisions')).toBe('Decisions')
  })

  it('keeps the note half of a block reference', () => {
    expect(wikiLinkLabel('Meeting#^abc123')).toBe('Meeting')
  })
})

describe('replaceWikiLinks', () => {
  it('renders every run in a sentence', () => {
    expect(replaceWikiLinks('see [[A#B]], [[C|see it]] and [[D]]')).toBe('see A, see it and D')
  })

  // The two `'$2$1'` sites concatenated instead of choosing, so an aliased link
  // came out as alias-then-target welded together.
  it('does not weld the alias onto the target', () => {
    expect(replaceWikiLinks('[[Sprint Notes|retro]]')).toBe('retro')
  })

  it('wraps each label when a renderer is given', () => {
    expect(replaceWikiLinks('[[A#B]] x', (label) => `<i>${label}</i>`)).toBe('<i>A</i> x')
  })

  it('leaves text that is not a link alone', () => {
    expect(replaceWikiLinks('an [[ unclosed and a [link](url)')).toBe(
      'an [[ unclosed and a [link](url)'
    )
  })
})
