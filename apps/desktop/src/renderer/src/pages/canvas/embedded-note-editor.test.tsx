import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { EmbeddedNoteEditor } from './embedded-note-editor'
import { hasPendingSaves } from '@/lib/save-registry'
import type { Note } from '@memry/rpc/notes'

const mocks = vi.hoisted(() => ({
  update: vi.fn()
}))

let currentNote: Note | null = null

vi.mock('@/hooks/use-notes-query', () => ({
  useNote: () => ({ note: currentNote, isLoading: false, isFetching: false, error: null })
}))
vi.mock('@/services/notes-service', () => ({
  notesService: { update: mocks.update }
}))
// Stub ContentArea (BlockNote → react-pdf needs DOMMatrix, absent in jsdom;
// canvas-card-overlay.test.tsx uses the same stubbing strategy for the leaf
// editor). Exposes a button that fires onMarkdownChange like a real edit.
vi.mock('@/components/note/content-area', () => ({
  ContentArea: ({
    initialContent,
    onMarkdownChange
  }: {
    initialContent: string
    onMarkdownChange: (markdown: string) => void
  }) => (
    <div>
      <span data-testid="initial-content">{initialContent}</span>
      <button data-testid="edit" onClick={() => onMarkdownChange('edited body')} />
      <button data-testid="edit-again" onClick={() => onMarkdownChange('edited again')} />
    </div>
  )
}))

function makeNote(overrides: Partial<Note> = {}): Note {
  return {
    id: 'n1',
    path: 'notes/n1.md',
    title: 'Note One',
    content: 'original body',
    frontmatter: {},
    created: new Date('2026-01-01'),
    modified: new Date('2026-01-01'),
    tags: [],
    aliases: [],
    wordCount: 2,
    properties: {},
    ...overrides
  }
}

describe('EmbeddedNoteEditor', () => {
  beforeEach(() => {
    mocks.update.mockReset()
    mocks.update.mockResolvedValue({ success: true })
    currentNote = null
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders an empty placeholder while the note has not loaded', () => {
    const { container } = render(<EmbeddedNoteEditor noteId="n1" />)
    expect(screen.queryByTestId('initial-content')).not.toBeInTheDocument()
    expect(container.querySelector('.min-h-0')).toBeInTheDocument()
  })

  it('renders ContentArea with the note content once loaded', () => {
    currentNote = makeNote()
    render(<EmbeddedNoteEditor noteId="n1" />)
    expect(screen.getByTestId('initial-content')).toHaveTextContent('original body')
  })

  it('does not schedule a save when the markdown is unchanged', () => {
    vi.useFakeTimers()
    currentNote = makeNote()
    render(<EmbeddedNoteEditor noteId="n1" />)
    act(() => {
      vi.advanceTimersByTime(2000)
    })
    expect(mocks.update).not.toHaveBeenCalled()
  })

  it('debounces a markdown change before saving', () => {
    vi.useFakeTimers()
    currentNote = makeNote()
    render(<EmbeddedNoteEditor noteId="n1" />)
    screen.getByTestId('edit').click()
    expect(mocks.update).not.toHaveBeenCalled()
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(mocks.update).toHaveBeenCalledWith({ id: 'n1', content: 'edited body' })
  })

  it('registers a pending-save flush while mounted and unregisters on unmount', () => {
    vi.useFakeTimers()
    currentNote = makeNote()
    const { unmount } = render(<EmbeddedNoteEditor noteId="n1" />)
    screen.getByTestId('edit-again').click()
    expect(hasPendingSaves()).toBe(true)
    unmount()
    expect(hasPendingSaves()).toBe(false)
    expect(mocks.update).toHaveBeenCalledWith({ id: 'n1', content: 'edited again' })
  })
})
