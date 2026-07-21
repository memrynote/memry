import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ProjectOverviewNote } from './project-overview-note'

const mocks = vi.hoisted(() => ({
  notesGet: vi.fn(),
  notesCreate: vi.fn(),
  notesUpdate: vi.fn(),
  setProjectHomeNote: vi.fn(),
  getProject: vi.fn()
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

vi.mock('@/components/note', () => ({
  ContentArea: ({ initialContent }: { initialContent: string }) => (
    <div data-testid="editor-content">{initialContent}</div>
  )
}))

vi.mock('@/components/note/editor-error-boundary', () => ({
  EditorErrorBoundary: ({ children }: { children: React.ReactNode }) => children
}))

describe('ProjectOverviewNote', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('#then renders the inline editor when a home note exists', async () => {
    mocks.notesGet.mockResolvedValue({
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
    })

    render(<ProjectOverviewNote projectId="p1" homeNoteId="n1" onHomeNoteChange={vi.fn()} />)

    expect(await screen.findByTestId('overview-editor')).toBeInTheDocument()
    expect(await screen.findByText('# Hi')).toBeInTheDocument()
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
})
