import { describe, expect, it } from 'vitest'
import { backlinkId, toBacklink } from './types'

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

  it('gives one id per canvas, apart from the wiki link and property ids', () => {
    const ids = [
      backlinkId('note-a', undefined),
      backlinkId('note-a', { kind: 'property', propertyName: 'father' }),
      backlinkId('note-a', { kind: 'canvas', canvasId: 'c1', canvasTitle: 'Map' }),
      backlinkId('note-a', { kind: 'canvas', canvasId: 'c2', canvasTitle: 'Map' })
    ]

    expect(new Set(ids).size).toBe(4)
  })
})

describe('toBacklink', () => {
  const date = new Date('2026-05-10')
  const contexts = [
    { snippet: 'see [[Plan]] here', linkStart: 4, linkEnd: 12 },
    { snippet: '[[Plan]] again', linkStart: 0, linkEnd: 8 }
  ]

  it('counts every link the source holds when its snippets were cut', () => {
    const card = toBacklink(
      {
        sourceId: 'dense',
        sourcePath: 'Dense.md',
        sourceTitle: 'Dense',
        contexts,
        mentionCount: 60,
        truncated: true
      },
      '',
      date
    )

    expect(card).toEqual({
      id: 'dense',
      noteId: 'dense',
      noteTitle: 'Dense',
      folder: '',
      date,
      mentions: [
        { id: 'mention-dense-0', ...contexts[0] },
        { id: 'mention-dense-1', ...contexts[1] }
      ],
      mentionCount: 60,
      truncated: true,
      via: undefined
    })
  })

  it('counts the snippets of a backlink sent without a count, as Electron sends it', () => {
    const card = toBacklink(
      { sourceId: 'a', sourcePath: 'Work/a.md', sourceTitle: 'A', contexts },
      'Work',
      date
    )

    expect([card.mentionCount, card.truncated, card.folder]).toEqual([2, false, 'Work'])
  })
})
