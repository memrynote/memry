import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { NoteWithProperties } from '@memry/contracts/folder-view-api'
import { FolderGalleryView } from './folder-gallery-view'

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key })
}))

vi.mock('@/hooks/use-tab-scroll-restore', () => ({
  useTabScrollRestore: () => undefined
}))

vi.mock('@/hooks/use-vault', () => ({
  useVault: () => ({ status: { path: '/vault' } })
}))

function note(id: string, cover?: string | null): NoteWithProperties {
  return {
    id,
    path: `Books/${id}.md`,
    title: id,
    emoji: '📚',
    cover,
    folder: '/',
    tags: [],
    created: '2026-01-01T00:00:00.000Z',
    modified: '2026-01-01T00:00:00.000Z',
    wordCount: 0,
    properties: {}
  }
}

function renderGallery(notes: NoteWithProperties[]): void {
  render(<FolderGalleryView notes={notes} tagMetaMap={new Map()} onNoteOpen={vi.fn()} />)
}

describe('FolderGalleryView cover', () => {
  it("shows each note's cover image on its card", () => {
    renderGallery([note('dune', 'cover.jpg'), note('web', 'https://example.com/a.png')])

    const images = screen.getAllByTestId('gallery-card-cover-image')
    expect(images.map((img) => img.getAttribute('src'))).toEqual([
      expect.stringMatching(/^memry-file:.*Books\/cover\.jpg$/),
      'https://example.com/a.png'
    ])
    expect(screen.queryByText('📚')).toBeNull()
  })

  it('paints a wash cover, and falls back to a wash when the image fails', () => {
    renderGallery([note('emma', 'wash:sage'), note('gone', 'missing.png')])

    expect(screen.getAllByTestId('gallery-card-cover-wash')).toHaveLength(1)
    fireEvent.error(screen.getByTestId('gallery-card-cover-image'))
    expect(screen.getAllByTestId('gallery-card-cover-wash')).toHaveLength(2)
  })

  it('keeps the emoji band for a note without a cover', () => {
    renderGallery([note('plain', null), note('prose', 'Hardback')])

    expect(screen.queryByTestId('gallery-card-cover-image')).toBeNull()
    expect(screen.queryByTestId('gallery-card-cover-wash')).toBeNull()
  })
})
