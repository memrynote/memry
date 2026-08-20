import { describe, it, expect } from 'vitest'
import {
  splitWikiTarget,
  isBlockReference,
  normalizeHeading,
  wikiLinkLabel,
  replaceWikiLinks,
  resolveWikiTarget
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

describe('resolveWikiTarget', () => {
  const meeting = { id: 'note_meeting', title: 'Meeting' }
  const sprint = { id: 'note_sprint', title: 'Sprint #4' }

  /** A title lookup over a fixed set of notes, recording what it was asked. */
  function vault(...notes: Array<{ id: string; title: string }>) {
    const asked: string[] = []
    const lookup = async (title: string) => {
      asked.push(title)
      return notes.find((note) => note.title === title) ?? null
    }
    return { asked, lookup }
  }

  it('reaches the note half of `Note#Heading` and reports the heading', async () => {
    const { lookup } = vault(meeting)
    expect(await resolveWikiTarget('Meeting#Decisions', lookup)).toEqual({
      match: meeting,
      heading: 'Decisions'
    })
  })

  it('falls back to the raw string, so a note really named `Sprint #4` wins', async () => {
    const { asked, lookup } = vault(sprint)
    expect(await resolveWikiTarget('Sprint #4', lookup)).toEqual({ match: sprint, heading: null })
    expect(asked).toEqual(['Sprint', 'Sprint #4'])
  })

  it('prefers the split match when both halves name a note', async () => {
    const { lookup } = vault(sprint, { id: 'note_sprint_only', title: 'Sprint' })
    const resolved = await resolveWikiTarget('Sprint #4', lookup)
    expect(resolved?.match.id).toBe('note_sprint_only')
    expect(resolved?.heading).toBe('4')
  })

  it('never looks a title up twice when the target carries no `#`', async () => {
    const { asked, lookup } = vault(meeting)
    expect(await resolveWikiTarget('Meeting', lookup)).toEqual({ match: meeting, heading: null })
    expect(asked).toEqual(['Meeting'])
  })

  it('opens the note of a block reference, with nothing to scroll to', async () => {
    const { lookup } = vault(meeting)
    expect(await resolveWikiTarget('Meeting#^abc123', lookup)).toEqual({
      match: meeting,
      heading: null
    })
  })

  it('reports no heading when the raw string is what matched', async () => {
    const { lookup } = vault({ id: 'note_hash', title: 'Meeting#Decisions' })
    const resolved = await resolveWikiTarget('Meeting#Decisions', lookup)
    expect(resolved?.heading).toBeNull()
  })

  it('resolves a nested heading to its last segment', async () => {
    const { lookup } = vault(meeting)
    expect((await resolveWikiTarget('Meeting#Q3#Decisions', lookup))?.heading).toBe('Decisions')
  })

  it('leaves a self-link `[[#Heading]]` to the caller that knows the note', async () => {
    const { asked, lookup } = vault(meeting)
    expect(await resolveWikiTarget('#Decisions', lookup)).toBeNull()
    expect(asked).toEqual([])
  })

  it('resolves nothing for a blank target, without a lookup', async () => {
    const { asked, lookup } = vault(meeting)
    expect(await resolveWikiTarget('   ', lookup)).toBeNull()
    expect(asked).toEqual([])
  })

  it('returns null when neither half names a note', async () => {
    const { lookup } = vault(meeting)
    expect(await resolveWikiTarget('Missing#Heading', lookup)).toBeNull()
  })

  it('accepts a synchronous lookup', async () => {
    expect(
      await resolveWikiTarget('Meeting#Decisions', (title) =>
        title === 'Meeting' ? meeting : undefined
      )
    ).toEqual({ match: meeting, heading: 'Decisions' })
  })
})
