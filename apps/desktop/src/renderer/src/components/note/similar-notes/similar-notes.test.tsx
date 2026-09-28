import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { SimilarNoteItem } from '@memry/contracts/notes-api'

const mocks = vi.hoisted(() => ({
  listCanvases: vi.fn()
}))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string, values?: Record<string, unknown>) => {
      const subject = values?.title ?? values?.tag
      return subject === undefined ? key : `${key}:${String(subject)}`
    }
  })
}))

vi.mock('@/services/canvas-service', () => ({
  canvasService: { list: mocks.listCanvases }
}))

import { SimilarNotesSection } from './SimilarNotesSection'
import { SuggestedTagsRow } from './SuggestedTagsRow'

const note = (id: string, path: string): SimilarNoteItem => ({
  id,
  title: `Title ${id}`,
  path,
  emoji: null,
  snippet: null,
  similarity: 0.8
})

describe('SimilarNotesSection', () => {
  it('renders nothing without similar notes', () => {
    const { container } = render(<SimilarNotesSection notes={[]} onOpen={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('opens a note and links it from this one', async () => {
    const user = userEvent.setup()
    const onOpen = vi.fn()
    const onLink = vi.fn()
    const similar = note('a', 'health/sleep/a.md')

    render(<SimilarNotesSection notes={[similar]} onOpen={onOpen} onLink={onLink} />)

    expect(screen.getByText('health/sleep')).toBeInTheDocument()
    await user.click(screen.getByText('Title a'))
    expect(onOpen).toHaveBeenCalledWith(similar)

    await user.click(screen.getByRole('button', { name: 'similarNotes.addLinkAria:Title a' }))
    expect(onLink).toHaveBeenCalledWith(similar)
  })

  it('offers no link or canvas action when the page cannot take one', () => {
    render(<SimilarNotesSection notes={[note('a', 'a.md')]} onOpen={vi.fn()} />)
    expect(screen.queryByRole('button', { name: /addLinkAria/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /addToCanvasAria/ })).not.toBeInTheDocument()
  })

  it('adds to a free-standing canvas picked from the list', async () => {
    const user = userEvent.setup()
    mocks.listCanvases.mockResolvedValue({
      canvases: [
        { id: 'c1', title: 'Board', ownerNoteId: null, unreadable: false },
        { id: 'c2', title: 'Whiteboard in a note', ownerNoteId: 'n9', unreadable: false },
        { id: 'c3', title: 'Broken', ownerNoteId: null, unreadable: true }
      ]
    })
    const onAddToCanvas = vi.fn()
    const similar = note('a', 'a.md')

    render(<SimilarNotesSection notes={[similar]} onOpen={vi.fn()} onAddToCanvas={onAddToCanvas} />)

    await user.click(screen.getByRole('button', { name: 'similarNotes.addToCanvasAria:Title a' }))
    await waitFor(() => expect(screen.getByText('Board')).toBeInTheDocument())
    expect(screen.queryByText('Whiteboard in a note')).not.toBeInTheDocument()
    expect(screen.queryByText('Broken')).not.toBeInTheDocument()

    await user.click(screen.getByText('Board'))
    expect(onAddToCanvas).toHaveBeenCalledWith(similar, { id: 'c1', title: 'Board' })
  })
})

describe('SuggestedTagsRow', () => {
  it('renders nothing without suggestions', () => {
    const { container } = render(
      <SuggestedTagsRow suggestions={[]} onAccept={vi.fn()} onDismiss={vi.fn()} />
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('adds a tag only when one is picked, and can be dismissed', async () => {
    const user = userEvent.setup()
    const onAccept = vi.fn()
    const onDismiss = vi.fn()

    render(
      <SuggestedTagsRow
        suggestions={[
          { tag: 'sleep', confidence: 0.7, support: 3 },
          { tag: 'health', confidence: 0.5, support: 2 }
        ]}
        onAccept={onAccept}
        onDismiss={onDismiss}
      />
    )
    expect(onAccept).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'suggestedTags.acceptAria:health' }))
    expect(onAccept).toHaveBeenCalledWith('health')

    await user.click(screen.getByRole('button', { name: 'suggestedTags.dismiss' }))
    expect(onDismiss).toHaveBeenCalled()
  })
})
