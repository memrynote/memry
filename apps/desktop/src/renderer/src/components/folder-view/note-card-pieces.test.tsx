import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { NoteCardKindIcon } from './note-card-pieces'
import { FolderGalleryView } from './folder-gallery-view'

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key.split('.').at(-1) ?? key })
}))

describe('NoteCardKindIcon', () => {
  it('marks a task row with a task icon', () => {
    render(<NoteCardKindIcon kind="task" />)
    expect(screen.getByTestId('kind-icon-task')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Task' })).toBeInTheDocument()
  })

  it('marks an inbox row with an inbox icon', () => {
    render(<NoteCardKindIcon kind="inbox" />)
    expect(screen.getByTestId('kind-icon-inbox')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Inbox' })).toBeInTheDocument()
  })

  it('renders nothing for a plain note, which needs no disambiguation', () => {
    const { container } = render(<NoteCardKindIcon kind={undefined} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing when kind is explicitly "note"', () => {
    const { container } = render(<NoteCardKindIcon kind="note" />)
    expect(container).toBeEmptyDOMElement()
  })
})

describe('FolderGalleryView kind icon wrapper', () => {
  it('renders a plain-note title with no icon and no extra wrapper', () => {
    const notes = [
      {
        id: 'note-1',
        title: 'Plain note title',
        emoji: null,
        folder: '/',
        tags: [],
        created: '2026-01-01T00:00:00.000Z',
        modified: '2026-01-02T00:00:00.000Z',
        wordCount: 10,
        properties: {},
        kind: undefined
      }
    ] as any[]

    render(<FolderGalleryView notes={notes} tagMetaMap={new Map()} onNoteOpen={() => {}} />)

    // The whole point of the fix: an undefined/`note` kind must not grow an
    // icon, and must not grow a wrapper `<div>` around the title either — the
    // title span's parent must still be the card's own flex-col container.
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
    const title = screen.getByText('Plain note title')
    expect(title.tagName).toBe('SPAN')
    expect(title.parentElement).toHaveClass('flex-col')
    expect(title.parentElement).not.toHaveClass('items-center')
  })
})
