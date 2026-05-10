import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { LinkSearch } from './link-search'
import type { LinkedNote } from '@/types'

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string) => key.split('.').at(-1) ?? key
  })
}))

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() })
}))

const linkedNotes: LinkedNote[] = [{ id: 'linked-folder', title: 'Projects', type: 'folder' }]

function notesListMock() {
  return window.api.notes.list as unknown as ReturnType<typeof vi.fn>
}

describe('LinkSearch', () => {
  beforeEach(() => {
    notesListMock().mockResolvedValue({ notes: [], total: 0, hasMore: false })
  })

  it('searches notes, keyboard-selects a result, and removes existing links', async () => {
    const onLinkedNotesChange = vi.fn()
    notesListMock().mockResolvedValue({
      notes: [
        { id: 'linked-folder', title: 'Projects', type: 'note' },
        { id: 'note-1', title: 'Roadmap', type: 'note' },
        { id: 'note-2', title: 'Roadmap appendix', type: 'note' }
      ],
      total: 3,
      hasMore: false
    })

    render(<LinkSearch linkedNotes={linkedNotes} onLinkedNotesChange={onLinkedNotesChange} />)

    expect(screen.getByText('Projects')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Remove link to Projects' }))
    expect(onLinkedNotesChange).toHaveBeenCalledWith([])

    const input = screen.getByLabelText('searchNotesToLink2')
    fireEvent.change(input, { target: { value: 'road' } })

    expect(await screen.findByText('Roadmap')).toBeInTheDocument()
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onLinkedNotesChange).toHaveBeenLastCalledWith([
      ...linkedNotes,
      { id: 'note-2', title: 'Roadmap appendix', type: 'note' }
    ])
    expect(input).toHaveValue('')
  })

  it('shows loading, empty, error, click-select, and outside-close states', async () => {
    const onLinkedNotesChange = vi.fn()
    let resolveSearch: (value: unknown) => void = () => {}
    notesListMock().mockReturnValue(
      new Promise((resolve) => {
        resolveSearch = resolve
      })
    )

    render(<LinkSearch linkedNotes={[]} onLinkedNotesChange={onLinkedNotesChange} />)

    const input = screen.getByLabelText('searchNotesToLink2')
    expect(screen.getByText('noLinksAdded')).toBeInTheDocument()

    fireEvent.change(input, { target: { value: 'memo' } })
    expect(await screen.findByText('searching')).toBeInTheDocument()

    resolveSearch({
      notes: [{ id: 'note-3', title: 'Memo capture', type: 'note' }],
      total: 1,
      hasMore: false
    })
    expect(await screen.findByText('Memo capture')).toBeInTheDocument()

    fireEvent.mouseDown(document.body)
    await waitFor(() => {
      expect(screen.queryByText('Memo capture')).not.toBeInTheDocument()
    })

    fireEvent.focus(input)
    expect(await screen.findByText('Memo capture')).toBeInTheDocument()
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(input).toHaveAttribute('aria-expanded', 'false')

    fireEvent.focus(input)
    expect(await screen.findByText('Memo capture')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Memo capture'))
    expect(onLinkedNotesChange).toHaveBeenCalledWith([
      { id: 'note-3', title: 'Memo capture', type: 'note' }
    ])

    notesListMock().mockResolvedValue({ notes: [], total: 0, hasMore: false })
    fireEvent.change(input, { target: { value: 'missing' } })
    expect(await screen.findByText('noNotesFound')).toBeInTheDocument()

    notesListMock().mockRejectedValue(new Error('search failed'))
    fireEvent.change(input, { target: { value: 'broken' } })
    await waitFor(() => {
      expect(screen.getByText('noNotesFound')).toBeInTheDocument()
    })
  })
})
