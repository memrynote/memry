import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { useState, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { toast } from 'sonner'
import { ProjectOverviewNote } from './project-overview-note'
import type * as VaultLocksStoreModule from '@/lib/vault-locks-store'
import type * as NotesServiceModule from '@/services/notes-service'

const mocks = vi.hoisted(() => ({
  notesGet: vi.fn(),
  notesCreate: vi.fn(),
  notesUpdate: vi.fn(),
  setProjectHomeNote: vi.fn(),
  getProject: vi.fn(),
  registerPendingSave: vi.fn(),
  unregisterPendingSave: vi.fn(),
  onMarkdownChange: null as ((markdown: string) => void) | null,
  updatedHandlers: new Set<(event: { id: string; changes: { content?: string } }) => void>(),
  isNoteLocked: false,
  noUnsubscribe: (): (() => void) => () => {}
}))

vi.mock('@/lib/vault-locks-store', async (importOriginal) => ({
  ...(await importOriginal<typeof VaultLocksStoreModule>()),
  useIsNoteLocked: () => mocks.isNoteLocked
}))

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() })
}))

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() })
}))

vi.mock('@/services/notes-service', async (importOriginal) => ({
  ...(await importOriginal<typeof NotesServiceModule>()),
  notesService: {
    get: mocks.notesGet,
    create: mocks.notesCreate,
    update: mocks.notesUpdate
  },
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

vi.mock('@/services/tasks-service', () => ({
  tasksService: {
    setProjectHomeNote: mocks.setProjectHomeNote,
    getProject: mocks.getProject
  }
}))

vi.mock('@/lib/save-registry', () => ({
  registerPendingSave: mocks.registerPendingSave,
  unregisterPendingSave: mocks.unregisterPendingSave
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
  return <div data-testid="editor-content">{shown.text}</div>
}

vi.mock('@/components/note', () => ({
  ContentArea: ({
    initialContent,
    externalContentRevision,
    editable = true,
    onMarkdownChange
  }: {
    initialContent: string
    externalContentRevision?: number
    editable?: boolean
    onMarkdownChange?: (markdown: string) => void
  }) => {
    mocks.onMarkdownChange = onMarkdownChange ?? null
    return (
      <div data-testid="content-area" data-editable={String(editable)}>
        <FakeEditor
          initialContent={initialContent}
          externalContentRevision={externalContentRevision}
        />
        <button type="button" onClick={() => onMarkdownChange?.('# Changed')}>
          Change markdown
        </button>
      </div>
    )
  }
}))

vi.mock('@/components/note/editor-error-boundary', () => ({
  EditorErrorBoundary: ({ children }: { children: ReactNode }) => children
}))

let queryClient: QueryClient

function renderOverview(homeNoteId: string | null | undefined, onHomeNoteChange = vi.fn()) {
  const ui = (id: string | null | undefined): React.JSX.Element => (
    <QueryClientProvider client={queryClient}>
      <ProjectOverviewNote projectId="p1" homeNoteId={id} onHomeNoteChange={onHomeNoteChange} />
    </QueryClientProvider>
  )
  const view = render(ui(homeNoteId))
  return { ...view, rerenderWith: (id: string | null | undefined) => view.rerender(ui(id)) }
}

function emitUpdated(id: string, content: string): void {
  act(() => {
    for (const handler of mocks.updatedHandlers) handler({ id, changes: { content } })
  })
}

/** What each save sent, but the id of the editor that sent it (#4137). */
function saves(): unknown[] {
  return mocks.notesUpdate.mock.calls.map(([input]) => ({ ...input, editor: undefined }))
}

function registeredFlush(key: string): () => Promise<void> {
  const flush = mocks.registerPendingSave.mock.calls.findLast(([k]) => k === key)?.[1] as
    | (() => Promise<void>)
    | undefined
  if (!flush) throw new Error(`no flush registered under ${key}`)
  return flush
}

const homeNote = {
  id: 'n1',
  path: 'Overview.md',
  title: 'Overview',
  content: '# Hi',
  frontmatter: {},
  created: new Date(),
  modified: new Date(),
  tags: [],
  aliases: [],
  wordCount: 1,
  properties: {}
}

describe('ProjectOverviewNote', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.onMarkdownChange = null
    mocks.updatedHandlers.clear()
    mocks.isNoteLocked = false
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  })
  afterEach(() => {
    vi.useRealTimers()
    queryClient.clear()
  })

  it('#then opens a locked home note read-only with the lock notice (#2606)', async () => {
    mocks.notesGet.mockResolvedValue(homeNote)
    mocks.isNoteLocked = true

    renderOverview('n1')

    expect(await screen.findByTestId('content-area')).toHaveAttribute('data-editable', 'false')
    expect(screen.getByTestId('note-locked-indicator')).toBeInTheDocument()
  })

  it('#then keeps an unlocked home note editable with no lock notice', async () => {
    mocks.notesGet.mockResolvedValue(homeNote)

    renderOverview('n1')

    expect(await screen.findByTestId('content-area')).toHaveAttribute('data-editable', 'true')
    expect(screen.queryByTestId('note-locked-indicator')).not.toBeInTheDocument()
  })

  it('#then renders the inline editor when a home note exists', async () => {
    mocks.notesGet.mockResolvedValue(homeNote)

    renderOverview('n1')

    expect(await screen.findByTestId('overview-editor')).toBeInTheDocument()
    expect(await screen.findByText('# Hi')).toBeInTheDocument()
  })

  it('#then shows a loading state (not the create affordance) while homeNoteId is unresolved', () => {
    renderOverview(undefined)

    expect(screen.queryByRole('button', { name: /overview note/i })).not.toBeInTheDocument()
    expect(screen.queryByTestId('overview-editor')).not.toBeInTheDocument()
  })

  it('#then offers create when no home note', async () => {
    const onHomeNoteChange = vi.fn()
    mocks.notesCreate.mockResolvedValue({
      success: true,
      note: { id: 'new-1', title: 'Overview', content: '' }
    })
    mocks.setProjectHomeNote.mockResolvedValue({ success: true, project: null })

    renderOverview(null, onHomeNoteChange)

    fireEvent.click(await screen.findByRole('button', { name: /overview note/i }))

    await waitFor(() =>
      expect(mocks.setProjectHomeNote).toHaveBeenCalledWith({ projectId: 'p1', noteId: 'new-1' })
    )
    expect(onHomeNoteChange).toHaveBeenCalledWith('new-1')
  })

  it('#then saves the edited markdown exactly once after the debounce', async () => {
    mocks.notesGet.mockResolvedValue(homeNote)
    mocks.notesUpdate.mockResolvedValue({ success: true, note: null })

    renderOverview('n1')

    const changeButton = await screen.findByRole('button', { name: 'Change markdown' })

    vi.useFakeTimers()
    try {
      fireEvent.click(changeButton)
      expect(mocks.notesUpdate).not.toHaveBeenCalled()

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000)
      })

      expect(mocks.notesUpdate).toHaveBeenCalledTimes(1)
      expect(saves()).toContainEqual({ id: 'n1', content: '# Changed' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('#then registers a pending-save flush and does not double-save once already flushed', async () => {
    mocks.notesGet.mockResolvedValue(homeNote)
    mocks.notesUpdate.mockResolvedValue({ success: true, note: null })

    const { unmount } = renderOverview('n1')

    const changeButton = await screen.findByRole('button', { name: 'Change markdown' })
    fireEvent.click(changeButton)

    const flush = mocks.registerPendingSave.mock.calls.find(
      ([key]) => key === 'project-overview:n1'
    )?.[1] as (() => Promise<void>) | undefined
    expect(flush).toBeInstanceOf(Function)

    // Simulates useFlushOnQuit calling the registered flush directly
    // (before-quit / beforeunload), independent of the 1000ms debounce.
    await act(async () => {
      await flush?.()
    })

    expect(mocks.notesUpdate).toHaveBeenCalledTimes(1)
    expect(saves()).toContainEqual({ id: 'n1', content: '# Changed' })

    unmount()

    expect(mocks.unregisterPendingSave).toHaveBeenCalledWith('project-overview:n1', flush)
    // Already flushed above — unmount must not save the same edit again.
    expect(mocks.notesUpdate).toHaveBeenCalledTimes(1)
  })

  it('#then flushes a still-pending debounced save on unmount instead of dropping it', async () => {
    mocks.notesGet.mockResolvedValue(homeNote)
    mocks.notesUpdate.mockResolvedValue({ success: true, note: null })

    const { unmount } = renderOverview('n1')

    const changeButton = await screen.findByRole('button', { name: 'Change markdown' })
    fireEvent.click(changeButton)
    expect(mocks.notesUpdate).not.toHaveBeenCalled()

    unmount()

    await waitFor(() => expect(saves()).toContainEqual({ id: 'n1', content: '# Changed' }))
    expect(mocks.notesUpdate).toHaveBeenCalledTimes(1)
  })

  // The editor's teardown flush reports its last edit after this component has
  // already moved to the next home note and flushed the old one (#1900).
  it('#then saves a late edit to the note it was typed in, not the next home note', async () => {
    mocks.notesGet.mockImplementation((id: string) => Promise.resolve({ ...homeNote, id }))
    mocks.notesUpdate.mockResolvedValue({ success: true, note: null })

    const { rerenderWith } = renderOverview('n1')
    await screen.findByRole('button', { name: 'Change markdown' })
    const reportLateEdit = mocks.onMarkdownChange!

    rerenderWith('n2')
    reportLateEdit('# Typed in n1')

    await vi.waitFor(() => expect(saves()).toContainEqual({ id: 'n1', content: '# Typed in n1' }))

    const flushN2 = mocks.registerPendingSave.mock.calls.find(
      ([key]) => key === 'project-overview:n2'
    )?.[1] as (() => Promise<void>) | undefined
    expect(flushN2).toBeInstanceOf(Function)
    await act(async () => {
      await flushN2?.()
    })
    expect(saves()).not.toContainEqual(expect.objectContaining({ id: 'n2' }))
  })

  describe('the home note open in a note tab too (#4088)', () => {
    it('#then hands an edit the note tab saved to the overview editor', async () => {
      mocks.notesGet.mockResolvedValue(homeNote)
      mocks.notesUpdate.mockResolvedValue({ success: true, note: null })
      renderOverview('n1')
      expect(await screen.findByTestId('editor-content')).toHaveTextContent('# Hi')

      emitUpdated('n1', '# Hi typed in the tab')

      expect(screen.getByTestId('editor-content')).toHaveTextContent('# Hi typed in the tab')
      // The editor reports the text it was handed: nothing new to save over the tab's edit.
      vi.useFakeTimers()
      act(() => mocks.onMarkdownChange?.('# Hi typed in the tab'))
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000)
      })
      expect(mocks.notesUpdate).not.toHaveBeenCalled()
    })
  })

  describe('a refused save', () => {
    it('#then keeps the typing for the next flush and tells the user', async () => {
      mocks.notesGet.mockResolvedValue(homeNote)
      mocks.notesUpdate.mockResolvedValue({ success: false, error: 'The file changed', note: null })
      renderOverview('n1')
      const changeButton = await screen.findByRole('button', { name: 'Change markdown' })

      vi.useFakeTimers()
      fireEvent.click(changeButton)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000)
      })
      expect(mocks.notesUpdate).toHaveBeenCalledTimes(1)
      expect(toast.error).toHaveBeenCalledWith(
        'Your changes to this note were not saved. They stay in the editor, and your next edit tries again.',
        { id: 'note-not-saved:n1' }
      )

      await act(async () => {
        await registeredFlush('project-overview:n1')()
      })
      expect(mocks.notesUpdate).toHaveBeenCalledTimes(2)
      expect(saves().at(-1)).toEqual({ id: 'n1', content: '# Changed' })
    })
  })

  it('#then keeps typing made during a save for the unmount flush', async () => {
    let answer: (result: { success: boolean; note: null }) => void = () => {}
    mocks.notesGet.mockResolvedValue(homeNote)
    mocks.notesUpdate
      .mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)))
      .mockResolvedValue({ success: true, note: null })
    const { unmount } = renderOverview('n1')
    await screen.findByRole('button', { name: 'Change markdown' })

    vi.useFakeTimers()
    act(() => mocks.onMarkdownChange?.('# A'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(saves()).toContainEqual({ id: 'n1', content: '# A' })
    act(() => mocks.onMarkdownChange?.('# A and B'))
    await act(async () => {
      answer({ success: true, note: null })
      await vi.advanceTimersByTimeAsync(0)
    })

    unmount()

    await vi.waitFor(() => expect(saves().at(-1)).toEqual({ id: 'n1', content: '# A and B' }))
  })
})
