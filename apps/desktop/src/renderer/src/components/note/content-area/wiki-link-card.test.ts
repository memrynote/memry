import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWikiLink } from '@memry/editor-schema/inline'
import type { WikiLinkPreview } from '@/services/notes-service'
import { fillWikiLinkCard, renderWikiLinkWithCard } from './wiki-link-card'

const mocks = vi.hoisted(() => ({
  previewByTitle: vi.fn(),
  getStatus: vi.fn()
}))

vi.mock('@/services/notes-service', () => ({
  notesService: { previewByTitle: mocks.previewByTitle },
  onNoteCreated: vi.fn(),
  onNoteRenamed: vi.fn(),
  onNoteDeleted: vi.fn(),
  onNoteUpdated: vi.fn()
}))

vi.mock('@/services/vault-service', () => ({
  vaultService: { getStatus: mocks.getStatus }
}))

// Answers are cached by target for the life of the module, so each test links to
// a note of its own.
let notes = 0
let target = 'Dune'

function props(display: Record<string, unknown> = {}) {
  return { props: { target, alias: '', ...display } }
}

function previewOf(overrides: Partial<WikiLinkPreview> = {}): WikiLinkPreview {
  return {
    id: 'note-dune',
    title: 'Dune',
    emoji: null,
    snippet: 'Body text',
    tags: [],
    createdAt: '2026-05-10T00:00:00.000Z',
    matchedName: null,
    path: 'Dune.md',
    cover: null,
    description: null,
    bodyText: null,
    ...overrides
  }
}

beforeEach(() => {
  target = `Dune ${++notes}`
  mocks.previewByTitle.mockReset().mockResolvedValue(null)
  mocks.getStatus.mockReset().mockResolvedValue({ path: '/vault' })
})

describe('renderWikiLinkWithCard', () => {
  // Existing notes, and the byte-stability of opening them, rest on a link that
  // asked for nothing being the chip it always was.
  it('draws the same chip as before for a link with the default settings', () => {
    expect(renderWikiLinkWithCard(props()).dom.outerHTML).toBe(
      renderWikiLink(props()).dom.outerHTML
    )
    expect(mocks.previewByTitle).not.toHaveBeenCalled()
  })

  it('draws the same chip when only the cover is on, which a plain chip has no room for', () => {
    const dom = renderWikiLinkWithCard(props({ cover: true })).dom

    expect(dom.outerHTML).toBe(renderWikiLink(props({ cover: true })).dom.outerHTML)
  })

  it('adds the elements of a small row: icon and title, and the cover only when asked for', () => {
    const { dom } = renderWikiLinkWithCard(props({ size: 'small' }))

    expect(dom.getAttribute('data-wiki-link-card')).toBe('')
    expect(dom.querySelector('.wiki-link-card-icon')).not.toBeNull()
    expect(dom.querySelector('.wiki-link-card-title')?.textContent).toBe(target)
    expect(dom.querySelector('.wiki-link-card-preview')).toBeNull()
    expect(dom.querySelector('.wiki-link-card-cover')).toBeNull()
  })

  it('adds a preview and a cover for a medium card that has both on', () => {
    const { dom } = renderWikiLinkWithCard(
      props({ size: 'medium', preview: true, cover: true, alias: 'the sequel' })
    )

    expect(dom.querySelector('.wiki-link-card-title')?.textContent).toBe('the sequel')
    expect(dom.querySelector('.wiki-link-card-preview')).not.toBeNull()
    expect(dom.querySelector('.wiki-link-card-cover')).not.toBeNull()
  })

  it('adds only the preview for a chip that shows one', () => {
    const { dom } = renderWikiLinkWithCard(props({ preview: true }))

    expect(dom.querySelector('.wiki-link-card-preview')).not.toBeNull()
    expect(dom.querySelector('.wiki-link-card-icon')).toBeNull()
    expect(dom.querySelector('.wiki-link-card-cover')).toBeNull()
  })

  it('keeps the chip marks inside the title and the target on the chip', () => {
    const { dom } = renderWikiLinkWithCard(props({ size: 'small', bold: true }))

    expect(dom.getAttribute('data-target')).toBe(target)
    expect(dom.querySelector('.wiki-link-card-title strong')?.textContent).toBe(target)
  })

  it('tells ProseMirror to ignore the elements that fill in afterwards', () => {
    expect(renderWikiLinkWithCard(props({ size: 'small' })).ignoreMutation?.()).toBe(true)
  })

  it('fills the preview and the cover from the linked note', async () => {
    mocks.previewByTitle.mockResolvedValue(
      previewOf({ description: 'Spice and sand', cover: 'wash:sage', emoji: '📚' })
    )

    const { dom } = renderWikiLinkWithCard(props({ size: 'medium', preview: true, cover: true }))
    await vi.waitFor(() => {
      expect(dom.querySelector('.wiki-link-card-preview')?.textContent).toBe('Spice and sand')
    })

    expect(dom.querySelector('.wiki-link-card-icon')?.textContent).toBe('📚')
    expect(
      (dom.querySelector('.wiki-link-card-cover') as HTMLElement).style.backgroundImage
    ).toContain('linear-gradient')
  })

  it('shows the plain opening of the body when the note has no description', async () => {
    mocks.previewByTitle.mockResolvedValue(
      previewOf({
        snippet: '--- start-multi-column: n101-cols ```column-settings',
        bodyText: 'Body text'
      })
    )

    const { dom } = renderWikiLinkWithCard(props({ preview: true }))
    await vi.waitFor(() => {
      expect(dom.querySelector('.wiki-link-card-preview')?.textContent).toBe('Body text')
    })
  })

  it('leaves the card with its title alone when the note cannot be found', async () => {
    const { dom } = renderWikiLinkWithCard(props({ size: 'small', preview: true }))
    await vi.waitFor(() => {
      expect(mocks.previewByTitle).toHaveBeenCalled()
    })

    expect(dom.querySelector('.wiki-link-card-preview')?.textContent).toBe('')
    expect(dom.querySelector('.wiki-link-card-title')?.textContent).toBe(target)
  })
})

describe('fillWikiLinkCard', () => {
  it('puts a cover image in the cover and drops it when it will not load', () => {
    const { dom } = renderWikiLinkWithCard(props({ size: 'small', cover: true }))

    fillWikiLinkCard(dom, {
      icon: null,
      text: null,
      cover: { kind: 'image', url: 'https://example.com/c.jpg' }
    })
    const image = dom.querySelector('.wiki-link-card-cover img') as HTMLImageElement
    expect(image.getAttribute('src')).toBe('https://example.com/c.jpg')

    image.dispatchEvent(new Event('error'))
    expect(dom.querySelector('.wiki-link-card-cover img')).toBeNull()
  })

  it('goes back to the default icon when the note has no emoji', () => {
    const { dom } = renderWikiLinkWithCard(props({ size: 'small' }))

    fillWikiLinkCard(dom, { icon: '📚', text: null, cover: null })
    fillWikiLinkCard(dom, { icon: null, text: null, cover: null })

    expect(dom.querySelector('.wiki-link-card-icon svg')).not.toBeNull()
  })
})
