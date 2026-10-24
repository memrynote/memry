import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockApi } from '@tests/setup-dom'
import { createTestQueryClient } from '@tests/utils/render'

import { LinkInput } from './link-input'

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string, params?: Record<string, unknown>) => params?.title ?? key })
}))

vi.mock('@/lib/render-note-icon', () => ({
  NoteIconDisplay: ({ value }: { value: string }) => <span data-testid="note-icon">{value}</span>
}))

function renderInput(props: Partial<React.ComponentProps<typeof LinkInput>> = {}) {
  const queryClient = createTestQueryClient()
  const onLinkedNotesChange = vi.fn()
  render(
    <QueryClientProvider client={queryClient}>
      <LinkInput linkedNotes={[]} onLinkedNotesChange={onLinkedNotesChange} {...props} />
    </QueryClientProvider>
  )
  return { onLinkedNotesChange }
}

describe('LinkInput', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    const api = createMockApi()
    api.notes.list = vi.fn().mockResolvedValue({
      notes: [
        { id: 'note-1', title: 'Project Alpha', emoji: 'A' },
        { id: 'note-2', title: 'Project Beta', emoji: null },
        { id: 'note-3', title: 'Other', emoji: null }
      ],
      total: 3,
      hasMore: false
    })
    ;(window as Window & { api: unknown }).api = api
  })

  it('searches notes, filters linked matches, selects with keyboard and mouse, and removes links', async () => {
    const { onLinkedNotesChange } = renderInput({
      linkedNotes: [{ id: 'note-1', title: 'Project Alpha', type: 'note', emoji: 'A' }]
    })

    expect(screen.getByText('Project Alpha')).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Project Alpha'))
    expect(onLinkedNotesChange).toHaveBeenCalledWith([])

    const input = screen.getByLabelText('detail.searchNotesAria')
    fireEvent.change(input, { target: { value: 'Project' } })
    act(() => {
      vi.advanceTimersByTime(200)
    })

    await waitFor(() => {
      expect(screen.getByRole('option', { name: /Project Beta/ })).toBeInTheDocument()
    })
    expect(screen.queryByRole('option', { name: /Project Alpha/ })).not.toBeInTheDocument()

    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onLinkedNotesChange).toHaveBeenLastCalledWith([
      { id: 'note-1', title: 'Project Alpha', type: 'note', emoji: 'A' },
      { id: 'note-2', title: 'Project Beta', type: 'note', emoji: null }
    ])

    fireEvent.change(input, { target: { value: 'Project' } })
    act(() => {
      vi.advanceTimersByTime(200)
    })
    await screen.findByRole('option', { name: /Project Beta/ })
    fireEvent.mouseEnter(screen.getByRole('option', { name: /Project Beta/ }))
    fireEvent.click(screen.getByRole('option', { name: /Project Beta/ }))
    expect(onLinkedNotesChange).toHaveBeenLastCalledWith([
      { id: 'note-1', title: 'Project Alpha', type: 'note', emoji: 'A' },
      { id: 'note-2', title: 'Project Beta', type: 'note', emoji: null }
    ])
  })

  it('handles loading, empty, escape, tab selection, and outside dismissal paths', async () => {
    const { onLinkedNotesChange } = renderInput()
    const input = screen.getByLabelText('detail.searchNotesAria')

    fireEvent.change(input, { target: { value: 'Project' } })
    act(() => {
      vi.advanceTimersByTime(200)
    })
    await screen.findByRole('option', { name: /Project Alpha/ })

    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    fireEvent.keyDown(input, { key: 'Tab' })
    expect(onLinkedNotesChange).toHaveBeenCalledWith([
      { id: 'note-1', title: 'Project Alpha', type: 'note', emoji: 'A' }
    ])

    fireEvent.change(input, { target: { value: 'ZZ' } })
    act(() => {
      vi.advanceTimersByTime(200)
    })
    // A query that matches nothing is exactly when creating is what the user
    // meant, so the create row takes the place of the old empty message (#807).
    await waitFor(() => {
      expect(screen.getByTestId('link-input-create-note')).toBeInTheDocument()
    })

    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()

    fireEvent.focus(input)
    expect(screen.getByRole('listbox')).toBeInTheDocument()
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(input).toHaveValue('')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()

    fireEvent.keyDown(input, { key: 'Escape' })
    expect(input).toHaveValue('')
  })

  it('stages a new note without creating it, and keeps Enter on a real match (#807)', async () => {
    const { onLinkedNotesChange } = renderInput()
    const input = screen.getByLabelText('detail.searchNotesAria')

    fireEvent.change(input, { target: { value: 'Trip notes' } })
    act(() => {
      vi.advanceTimersByTime(200)
    })
    await waitFor(() => {
      expect(screen.getByTestId('link-input-create-note')).toBeInTheDocument()
    })

    fireEvent.keyDown(input, { key: 'Enter' })
    // Nothing is written here — the note is created when the item is filed.
    expect(onLinkedNotesChange).toHaveBeenCalledWith([
      { id: 'pending:Trip notes', title: 'Trip notes', type: 'note', isPending: true }
    ])
    expect(window.api.notes.create).not.toHaveBeenCalled()

    onLinkedNotesChange.mockClear()
    fireEvent.change(input, { target: { value: 'Project' } })
    act(() => {
      vi.advanceTimersByTime(200)
    })
    await waitFor(() => {
      expect(screen.getByRole('option', { name: /Project Alpha/ })).toBeInTheDocument()
    })

    // Create sits last, so Enter still links the top match.
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onLinkedNotesChange).toHaveBeenCalledWith([
      { id: 'note-1', title: 'Project Alpha', type: 'note', emoji: 'A' }
    ])
  })

  it('does not offer to create a note whose title already exists (#807)', async () => {
    renderInput()
    const input = screen.getByLabelText('detail.searchNotesAria')

    fireEvent.change(input, { target: { value: 'Project Alpha' } })
    act(() => {
      vi.advanceTimersByTime(200)
    })

    await waitFor(() => {
      expect(screen.getByRole('option', { name: /Project Alpha/ })).toBeInTheDocument()
    })
    expect(screen.queryByTestId('link-input-create-note')).not.toBeInTheDocument()
  })
})
