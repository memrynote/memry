import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ProjectOverviewNote } from './project-overview-note'

const mocks = vi.hoisted(() => ({
  notesGet: vi.fn(),
  notesCreate: vi.fn(),
  notesUpdate: vi.fn(),
  setProjectHomeNote: vi.fn(),
  getProject: vi.fn(),
  registerPendingSave: vi.fn(),
  unregisterPendingSave: vi.fn()
}))

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() })
}))

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() }
}))

vi.mock('@/services/notes-service', () => ({
  notesService: {
    get: mocks.notesGet,
    create: mocks.notesCreate,
    update: mocks.notesUpdate
  }
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

vi.mock('@/components/note', () => ({
  ContentArea: ({
    initialContent,
    onMarkdownChange
  }: {
    initialContent: string
    onMarkdownChange?: (markdown: string) => void
  }) => (
    <div>
      <div data-testid="editor-content">{initialContent}</div>
      <button type="button" onClick={() => onMarkdownChange?.('# Changed')}>
        Change markdown
      </button>
    </div>
  )
}))

vi.mock('@/components/note/editor-error-boundary', () => ({
  EditorErrorBoundary: ({ children }: { children: React.ReactNode }) => children
}))

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
  })

  it('#then renders the inline editor when a home note exists', async () => {
    mocks.notesGet.mockResolvedValue(homeNote)

    render(<ProjectOverviewNote projectId="p1" homeNoteId="n1" onHomeNoteChange={vi.fn()} />)

    expect(await screen.findByTestId('overview-editor')).toBeInTheDocument()
    expect(await screen.findByText('# Hi')).toBeInTheDocument()
  })

  it('#then shows a loading state (not the create affordance) while homeNoteId is unresolved', () => {
    render(<ProjectOverviewNote projectId="p1" homeNoteId={undefined} onHomeNoteChange={vi.fn()} />)

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

    render(
      <ProjectOverviewNote projectId="p1" homeNoteId={null} onHomeNoteChange={onHomeNoteChange} />
    )

    fireEvent.click(await screen.findByRole('button', { name: /overview note/i }))

    await waitFor(() =>
      expect(mocks.setProjectHomeNote).toHaveBeenCalledWith({ projectId: 'p1', noteId: 'new-1' })
    )
    expect(onHomeNoteChange).toHaveBeenCalledWith('new-1')
  })

  it('#then saves the edited markdown exactly once after the debounce', async () => {
    mocks.notesGet.mockResolvedValue(homeNote)
    mocks.notesUpdate.mockResolvedValue({ success: true, note: null })

    render(<ProjectOverviewNote projectId="p1" homeNoteId="n1" onHomeNoteChange={vi.fn()} />)

    const changeButton = await screen.findByRole('button', { name: 'Change markdown' })

    vi.useFakeTimers()
    try {
      fireEvent.click(changeButton)
      expect(mocks.notesUpdate).not.toHaveBeenCalled()

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000)
      })

      expect(mocks.notesUpdate).toHaveBeenCalledTimes(1)
      expect(mocks.notesUpdate).toHaveBeenCalledWith({ id: 'n1', content: '# Changed' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('#then registers a pending-save flush and does not double-save once already flushed', async () => {
    mocks.notesGet.mockResolvedValue(homeNote)
    mocks.notesUpdate.mockResolvedValue({ success: true, note: null })

    const { unmount } = render(
      <ProjectOverviewNote projectId="p1" homeNoteId="n1" onHomeNoteChange={vi.fn()} />
    )

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
    expect(mocks.notesUpdate).toHaveBeenCalledWith({ id: 'n1', content: '# Changed' })

    unmount()

    expect(mocks.unregisterPendingSave).toHaveBeenCalledWith('project-overview:n1')
    // Already flushed above — unmount must not save the same edit again.
    expect(mocks.notesUpdate).toHaveBeenCalledTimes(1)
  })

  it('#then flushes a still-pending debounced save on unmount instead of dropping it', async () => {
    mocks.notesGet.mockResolvedValue(homeNote)
    mocks.notesUpdate.mockResolvedValue({ success: true, note: null })

    const { unmount } = render(
      <ProjectOverviewNote projectId="p1" homeNoteId="n1" onHomeNoteChange={vi.fn()} />
    )

    const changeButton = await screen.findByRole('button', { name: 'Change markdown' })
    fireEvent.click(changeButton)
    expect(mocks.notesUpdate).not.toHaveBeenCalled()

    unmount()

    await waitFor(() =>
      expect(mocks.notesUpdate).toHaveBeenCalledWith({ id: 'n1', content: '# Changed' })
    )
    expect(mocks.notesUpdate).toHaveBeenCalledTimes(1)
  })
})
