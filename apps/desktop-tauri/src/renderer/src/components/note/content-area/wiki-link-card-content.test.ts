import { describe, expect, it } from 'vitest'
import type { WikiLinkPreview } from '@/services/notes-service'
import { wikiLinkCardContent } from './wiki-link-card-content'

function preview(overrides: Partial<WikiLinkPreview> = {}): WikiLinkPreview {
  return {
    id: 'note-dune',
    title: 'Dune',
    emoji: null,
    snippet: null,
    tags: [],
    createdAt: '2026-05-10T00:00:00.000Z',
    matchedName: null,
    path: 'Books/Dune.md',
    cover: null,
    description: null,
    bodyText: null,
    ...overrides
  }
}

describe('wikiLinkCardContent', () => {
  it('shows the description property before the first lines of the body', () => {
    const content = wikiLinkCardContent(
      preview({ description: 'Spice and sand', bodyText: 'Body text' }),
      null
    )

    expect(content.text).toBe('Spice and sand')
  })

  it('falls back to the body when the description is blank', () => {
    expect(
      wikiLinkCardContent(preview({ description: '  ', bodyText: 'Body text' }), null).text
    ).toBe('Body text')
    expect(wikiLinkCardContent(preview(), null).text).toBeNull()
  })

  it('never shows the raw markdown snippet, which carries what the editor does not draw', () => {
    const snippet = '--- start-multi-column: n101-cols ```column-settings Number of Columns: 3'
    expect(wikiLinkCardContent(preview({ snippet }), null).text).toBeNull()
  })

  it('draws a plain emoji and leaves library and custom icons to the default icon', () => {
    expect(wikiLinkCardContent(preview({ emoji: '📚' }), null).icon).toBe('📚')
    expect(wikiLinkCardContent(preview({ emoji: 'icon:book' }), null).icon).toBeNull()
    expect(wikiLinkCardContent(preview({ emoji: 'custom:abc' }), null).icon).toBeNull()
    expect(wikiLinkCardContent(preview({ emoji: null }), null).icon).toBeNull()
  })

  it('resolves a relative cover image against the note and the vault', () => {
    const { cover } = wikiLinkCardContent(
      preview({ cover: '../attachments/note-dune/cover.png' }),
      '/vault'
    )

    expect(cover).toEqual({
      kind: 'image',
      url: expect.stringContaining('attachments/note-dune/cover.png')
    })
    expect(cover?.kind === 'image' && cover.url.startsWith('memry-file://')).toBe(true)
  })

  it('leaves a web cover as it is', () => {
    expect(
      wikiLinkCardContent(preview({ cover: 'https://example.com/cover.jpg' }), '/vault').cover
    ).toEqual({ kind: 'image', url: 'https://example.com/cover.jpg' })
  })

  it('paints a wash cover as a gradient', () => {
    const { cover } = wikiLinkCardContent(preview({ cover: 'wash:sage' }), null)

    expect(cover?.kind).toBe('wash')
    expect(cover?.kind === 'wash' && cover.gradient).toContain('linear-gradient')
  })

  it('reads a cover property that is plain prose as no cover', () => {
    expect(wikiLinkCardContent(preview({ cover: 'Hardback' }), null).cover).toBeNull()
  })
})
