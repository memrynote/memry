import { act, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'

import { EmbeddedNoteEditor } from './embedded-note-editor'
import { flushAllPendingSaves, hasPendingSaves } from '@/lib/save-registry'
import { notesKeys } from '@/hooks/use-notes-query'
import type { Note } from '@memry/rpc/notes'
import type * as VaultLocksStoreModule from '@/lib/vault-locks-store'
import type * as NotesServiceModule from '@/services/notes-service'

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  update: vi.fn(),
  onMarkdownChange: null as ((markdown: string) => void) | null,
  updatedHandlers: new Set<(event: { id: string; changes: { content?: string } }) => void>(),
  isNoteLocked: false,
  isNoteExcluded: false,
  noUnsubscribe: (): (() => void) => () => {}
}))

vi.mock('@/services/notes-service', async (importOriginal) => ({
  ...(await importOriginal<typeof NotesServiceModule>()),
  notesService: { get: mocks.get, update: mocks.update },
  onNoteUpdated: (handler: (event: { id: string; changes: { content?: string } }) => void) => {
    mocks.updatedHandlers.add(handler)
    return () => mocks.updatedHandlers.delete(handler)
  },
  onNoteRenamed: mocks.noUnsubscribe,
  onNoteMoved: mocks.noUnsubscribe,
  onNoteDeleted: mocks.noUnsubscribe,
  onNoteExternalChange: mocks.noUnsubscribe,
  onNoteEventsDropped: mocks.noUnsubscribe,
  onNoteOutsideEditKept: mocks.noUnsubscribe
}))
vi.mock('@/lib/vault-locks-store', async (importOriginal) => ({
  ...(await importOriginal<typeof VaultLocksStoreModule>()),
  useIsNoteLocked: () => mocks.isNoteLocked
}))
vi.mock('@/lib/excluded-notes-store', () => ({
  useIsNoteExcluded: () => mocks.isNoteExcluded
}))
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() })
}))
vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() })
}))

// Like the real editor, it reads `initialContent` on mount and again only when
// `externalContentRevision` moves.
function FakeEditor({
  initialContent,
  externalContentRevision
}: {
  initialContent: string
  externalContentRevision?: number
}): React.JSX.Element {
  const [shown, setShown] = useState({ revision: externalContentRevision, text: initialContent })
  if (shown.revision !== externalContentRevision) {
    setShown({ revision: externalContentRevision, text: initialContent })
  }
  return <span data-testid="editor-text">{shown.text}</span>
}

// Stub ContentArea (BlockNote → react-pdf needs DOMMatrix, absent in jsdom;
// canvas-card-overlay.test.tsx uses the same stubbing strategy for the leaf
// editor). Exposes a button that fires onMarkdownChange like a real edit.
vi.mock('@/components/note/content-area', () => ({
  ContentArea: ({
    initialContent,
    externalContentRevision,
    editable = true,
    onMarkdownChange
  }: {
    initialContent: string
    externalContentRevision?: number
    editable?: boolean
    onMarkdownChange: (markdown: string) => void
  }) => {
    mocks.onMarkdownChange = onMarkdownChange
    return (
      <div data-testid="content-area" data-editable={String(editable)}>
        <FakeEditor
          initialContent={initialContent}
          externalContentRevision={externalContentRevision}
        />
        <button
          data-testid="edit"
          aria-label="edit"
          onClick={() => onMarkdownChange('edited body')}
        />
        <button
          data-testid="edit-again"
          aria-label="edit-again"
          onClick={() => onMarkdownChange('edited again')}
        />
      </div>
    )
  }
}))

// The panel's restore, as its `onRestore` follows a restored version.
vi.mock('@/components/note/version-history', () => ({
  VersionHistory: ({ onRestore }: { onRestore?: () => void }) => (
    <button data-testid="restored" aria-label="restored" onClick={() => onRestore?.()} />
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
    headerTags: [],
    aliases: [],
    wordCount: 2,
    properties: {},
    ...overrides
  }
}

let queryClient: QueryClient

function card(noteId: string): React.JSX.Element {
  return (
    <QueryClientProvider client={queryClient}>
      <EmbeddedNoteEditor noteId={noteId} />
    </QueryClientProvider>
  )
}

function renderCard(noteId = 'n1'): ReturnType<typeof render> {
  return render(card(noteId))
}

function emitUpdated(id: string, content: string): void {
  act(() => {
    for (const handler of mocks.updatedHandlers) handler({ id, changes: { content } })
  })
}

const REPLACED = "An outside change was replaced by your typing. It's saved in version history."

/** What each save sent; the mutation passes its context after the input. */
function saves(): unknown[] {
  return mocks.update.mock.calls.map(([input]) => input)
}

describe('EmbeddedNoteEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.get.mockResolvedValue(makeNote())
    mocks.update.mockResolvedValue({ success: true, note: null })
    mocks.onMarkdownChange = null
    mocks.updatedHandlers.clear()
    mocks.isNoteLocked = false
    mocks.isNoteExcluded = false
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  })
  afterEach(() => {
    vi.useRealTimers()
    queryClient.clear()
  })

  it('renders an empty placeholder while the note has not loaded', () => {
    mocks.get.mockReturnValue(new Promise(() => {}))
    const { container } = renderCard()
    expect(screen.queryByTestId('editor-text')).not.toBeInTheDocument()
    expect(container.querySelector('.min-h-0')).toBeInTheDocument()
  })

  it('renders ContentArea with the note content once loaded', async () => {
    renderCard()
    expect(await screen.findByTestId('editor-text')).toHaveTextContent('original body')
  })

  it('opens a locked note read-only with the lock notice (#2606)', async () => {
    mocks.isNoteLocked = true
    renderCard()
    expect(await screen.findByTestId('content-area')).toHaveAttribute('data-editable', 'false')
    // Outside the scroller: a small card scrolls its body, the notice stays in view.
    expect(screen.getByTestId('note-locked-indicator').closest('.overflow-auto')).toBeNull()
  })

  it('opens a note in an excluded folder read-only with its notice (#3530)', async () => {
    mocks.isNoteExcluded = true
    renderCard()
    expect(await screen.findByTestId('content-area')).toHaveAttribute('data-editable', 'false')
    expect(screen.getByTestId('note-locked-indicator')).toHaveTextContent(
      'This note is in an excluded folder.'
    )
  })

  it('keeps an unlocked note editable with no lock notice', async () => {
    renderCard()
    expect(await screen.findByTestId('content-area')).toHaveAttribute('data-editable', 'true')
    expect(screen.queryByTestId('note-locked-indicator')).not.toBeInTheDocument()
  })

  it('does not schedule a save when the markdown is unchanged', async () => {
    renderCard()
    await screen.findByTestId('content-area')
    vi.useFakeTimers()
    act(() => mocks.onMarkdownChange?.('original body'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })
    expect(mocks.update).not.toHaveBeenCalled()
  })

  it('debounces a markdown change before saving', async () => {
    renderCard()
    await screen.findByTestId('content-area')
    vi.useFakeTimers()
    act(() => screen.getByTestId('edit').click())
    expect(mocks.update).not.toHaveBeenCalled()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(saves()).toEqual([{ id: 'n1', content: 'edited body' }])
  })

  it('registers a pending-save flush while mounted and unregisters on unmount', async () => {
    const { unmount } = renderCard()
    await screen.findByTestId('content-area')
    act(() => screen.getByTestId('edit-again').click())
    expect(hasPendingSaves()).toBe(true)
    unmount()
    expect(hasPendingSaves()).toBe(false)
    await vi.waitFor(() => expect(saves()).toEqual([{ id: 'n1', content: 'edited again' }]))
  })

  // The editor's teardown flush reports its last edit after this component's
  // own unmount flush has already run (#1900).
  it('saves an edit reported after unmount straight away', async () => {
    const { unmount } = renderCard()
    await screen.findByTestId('content-area')
    const reportLateEdit = mocks.onMarkdownChange!

    unmount()
    reportLateEdit('typed while closing')

    await vi.waitFor(() => expect(saves()).toEqual([{ id: 'n1', content: 'typed while closing' }]))
  })

  describe('outside edits (#4088)', () => {
    it('opens on the file as it is now, not on a cached read from before an outside edit', async () => {
      queryClient.setQueryData(notesKeys.note('n1'), makeNote({ content: 'cached body' }))
      mocks.get.mockResolvedValue(makeNote({ content: 'edited outside' }))

      renderCard()

      await vi.waitFor(() =>
        expect(screen.getByTestId('editor-text')).toHaveTextContent('edited outside')
      )
    })

    it('hands an outside edit to the active card', async () => {
      renderCard()
      expect(await screen.findByTestId('editor-text')).toHaveTextContent('original body')

      act(() => {
        for (const handler of mocks.updatedHandlers) {
          handler({ id: 'n1', changes: { content: 'written by an agent' } })
        }
      })

      expect(screen.getByTestId('editor-text')).toHaveTextContent('written by an agent')
    })
  })

  it('keeps the typing of a refused save for the next flush and tells the user', async () => {
    mocks.update.mockResolvedValue({ success: false, error: 'The file changed', note: null })
    renderCard()
    await screen.findByTestId('content-area')

    vi.useFakeTimers()
    act(() => screen.getByTestId('edit').click())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(saves()).toEqual([{ id: 'n1', content: 'edited body' }])
    expect(toast.error).toHaveBeenCalledWith(
      'Your changes to this note were not saved. They stay in the editor, and your next edit tries again.',
      { id: 'note-not-saved:n1' }
    )

    await act(() => flushAllPendingSaves())
    expect(saves()).toEqual([
      { id: 'n1', content: 'edited body' },
      { id: 'n1', content: 'edited body' }
    ])
  })

  describe('a note the core will not let the app write (#4088)', () => {
    it('shows why a locked note refused the save and keeps the typing', async () => {
      mocks.update.mockResolvedValue({
        success: false,
        code: 'note_locked',
        error: 'note n1 is locked',
        note: null
      })
      renderCard()
      await screen.findByTestId('content-area')

      vi.useFakeTimers()
      act(() => screen.getByTestId('edit').click())
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000)
      })
      expect(toast.error).toHaveBeenCalledWith('The owner made this note read-only.', {
        id: 'note-not-saved:n1'
      })

      await act(() => flushAllPendingSaves())
      expect(saves()).toHaveLength(2)
    })

    it('shows why the save the unmount sent was refused', async () => {
      mocks.update.mockResolvedValue({
        success: false,
        code: 'note_excluded',
        error: 'This note is excluded from the vault.',
        note: null
      })
      const { unmount } = renderCard()
      await screen.findByTestId('content-area')
      act(() => screen.getByTestId('edit').click())

      unmount()

      await vi.waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith('This note is excluded from the vault.', {
          id: 'note-not-saved:n1'
        })
      )
    })

    it('says the typing is unsaved when the note turns read-only before its save', async () => {
      const { rerender } = renderCard()
      await screen.findByTestId('content-area')
      act(() => screen.getByTestId('edit').click())
      expect(toast.error).not.toHaveBeenCalled()

      mocks.isNoteLocked = true
      rerender(
        <QueryClientProvider client={queryClient}>
          <EmbeddedNoteEditor noteId="n1" />
        </QueryClientProvider>
      )

      expect(toast.error).toHaveBeenCalledTimes(1)
      expect(toast.error).toHaveBeenCalledWith(
        'This note became read-only before your latest changes were saved. They stay in the editor, unsaved.',
        { id: 'note-not-saved:n1' }
      )
    })
  })
  it('keeps the quit flush of a newer card of the note when an older one closes', async () => {
    const first = renderCard()
    renderCard()
    await vi.waitFor(() => expect(screen.getAllByTestId('edit')).toHaveLength(2))
    act(() => screen.getAllByTestId('edit')[1].click())

    first.unmount()
    await act(() => flushAllPendingSaves())

    expect(saves()).toEqual([{ id: 'n1', content: 'edited body' }])
  })

  it('drops the typing a restored version replaced, and shows the version', async () => {
    renderCard()
    await screen.findByTestId('content-area')
    act(() => screen.getByTestId('edit').click())
    // The restore's event came before the panel's answer: the typing held it off.
    emitUpdated('n1', 'restored body')

    act(() => screen.getByTestId('restored').click())

    expect(screen.getByTestId('editor-text')).toHaveTextContent('restored body')
    await act(() => flushAllPendingSaves())
    expect(mocks.update).not.toHaveBeenCalled()
  })

  describe('a save over an outside edit the card never showed (#4088)', () => {
    it.each([
      ['closes', (view: ReturnType<typeof render>) => view.unmount()],
      ['moves to another note', (view: ReturnType<typeof render>) => view.rerender(card('n2'))]
    ])(
      'when the card %s after a refused save, keeps the edit as a version and says so',
      async (_, leave) => {
        mocks.get.mockImplementation((id: string) => Promise.resolve(makeNote({ id })))
        mocks.update
          .mockResolvedValueOnce({ success: false, code: 'note_locked', error: 'x', note: null })
          .mockResolvedValue({ success: true, note: null, keptReplaced: true })
        const view = renderCard()
        await screen.findByTestId('content-area')
        vi.useFakeTimers()
        act(() => screen.getByTestId('edit').click())
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1000)
        })
        emitUpdated('n1', 'written by an agent')
        vi.useRealTimers()

        // The lock is gone: the save the card sends as it leaves lands.
        leave(view)

        await vi.waitFor(() =>
          expect(toast).toHaveBeenCalledWith(
            REPLACED,
            expect.objectContaining({ id: 'outside-edit-replaced:n1' })
          )
        )
        expect(saves().at(-1)).toEqual({ id: 'n1', content: 'edited body', keepReplaced: true })
      }
    )

    // #4110: the note tab saved a small edit while the card's save, sent before it heard of it,
    // ran. That save lands over the tab's text, and only the core knows whether it kept it.
    it.each([
      ['kept no version', false, 0],
      ['kept a version', true, 1]
    ])(
      'tells of a note tab save its own save went over only when the core %s',
      async (_, keptReplaced, toasts) => {
        let answer: (result: unknown) => void = () => {}
        mocks.update.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              answer = resolve
            })
        )
        renderCard()
        await screen.findByTestId('content-area')
        vi.useFakeTimers()
        act(() => screen.getByTestId('edit').click())
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1000)
        })
        emitUpdated('n1', 'saved in the tab')
        vi.useRealTimers()
        // The file read again once the save answers holds the card's save.
        mocks.get.mockResolvedValue(makeNote({ content: 'edited body' }))
        const reads = mocks.get.mock.calls.length

        await act(async () => {
          answer({ success: true, note: null, savedContent: 'edited body', keptReplaced })
          await Promise.resolve()
        })

        await vi.waitFor(() => expect(mocks.get.mock.calls.length).toBeGreaterThan(reads))
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0))
        })
        expect(
          vi.mocked(toast).mock.calls.filter(([message]) => message === REPLACED)
        ).toHaveLength(toasts)
      }
    )

    it('asks the core to keep a note tab save that came in while its own save ran', async () => {
      mocks.update.mockImplementationOnce(() => new Promise(() => {}))
      renderCard()
      await screen.findByTestId('content-area')
      vi.useFakeTimers()
      act(() => screen.getByTestId('edit').click())
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000)
      })
      emitUpdated('n1', 'saved in the tab')

      act(() => screen.getByTestId('edit-again').click())
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000)
      })

      expect(saves()).toEqual([
        { id: 'n1', content: 'edited body' },
        { id: 'n1', content: 'edited again', keepReplaced: true }
      ])
    })
  })

  it('says the typing is lost when the save its closing card sent is refused', async () => {
    mocks.update.mockResolvedValue({ success: false, error: 'The file changed', note: null })
    const { unmount } = renderCard()
    await screen.findByTestId('content-area')
    act(() => screen.getByTestId('edit').click())

    unmount()

    await vi.waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'Your latest changes to this note could not be saved after its editor closed.',
        { id: 'note-not-saved:n1' }
      )
    )
  })
})
