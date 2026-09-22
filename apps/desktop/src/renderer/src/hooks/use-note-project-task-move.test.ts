import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useNoteProjectTaskMove } from './use-note-project-task-move'

const mocks = vi.hoisted(() => ({
  getLinkedTasks: vi.fn(),
  getSubtasks: vi.fn(),
  update: vi.fn(),
  projects: [
    { id: 'work', name: 'Work', archivedAt: null },
    { id: 'inbox', name: 'Inbox', archivedAt: null },
    { id: 'old', name: 'Old', archivedAt: '2026-01-01T00:00:00.000Z' }
  ]
}))

vi.mock('@/services/tasks-service', () => ({
  tasksService: {
    getLinkedTasks: mocks.getLinkedTasks,
    getSubtasks: mocks.getSubtasks,
    update: mocks.update
  }
}))

vi.mock('@/hooks/use-projects-list', () => ({
  useProjectsList: () => ({ projects: mocks.projects, isLoading: false })
}))

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() })
}))

const NOTE_BODY = [
  '# Plan',
  '- [ ] Ship it {task:t1}',
  '  - [ ] Write the release note {task:t2}',
  '- [x] Already moved {task:t3}',
  '- [ ] A plain checkbox'
].join('\n')

const task = (id: string, projectId: string, parentId: string | null = null) => ({
  id,
  projectId,
  parentId,
  title: id
})

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getSubtasks.mockResolvedValue([])
  mocks.update.mockResolvedValue({ success: true })
})

describe('useNoteProjectTaskMove', () => {
  it('prompts for the note tasks that belong to another project', async () => {
    mocks.getLinkedTasks.mockResolvedValue([
      task('t1', 'inbox'),
      task('t2', 'inbox', 't1'),
      task('t3', 'work'),
      task('t9', 'inbox')
    ])

    const { result } = renderHook(() => useNoteProjectTaskMove('note-1', NOTE_BODY))

    act(() => {
      result.current.handleProjectPropertyChange([], ['Work'])
    })

    // t2 is a subtask (it follows its parent), t3 is already in Work, and t9 is
    // only linked to the note rather than written in it.
    await waitFor(() => expect(result.current.prompt).not.toBeNull())
    expect(result.current.prompt).toEqual({
      projectId: 'work',
      projectName: 'Work',
      taskIds: ['t1']
    })
  })

  it('does not prompt when a project is only removed', async () => {
    const { result } = renderHook(() => useNoteProjectTaskMove('note-1', NOTE_BODY))

    act(() => {
      result.current.handleProjectPropertyChange(['Work'], [])
    })

    await Promise.resolve()
    expect(mocks.getLinkedTasks).not.toHaveBeenCalled()
    expect(result.current.prompt).toBeNull()
  })

  it('ignores a name that resolves to no live project', async () => {
    const { result } = renderHook(() => useNoteProjectTaskMove('note-1', NOTE_BODY))

    act(() => {
      result.current.handleProjectPropertyChange([], ['Old'])
    })
    act(() => {
      result.current.handleProjectPropertyChange([], ['Typo'])
    })

    await Promise.resolve()
    expect(mocks.getLinkedTasks).not.toHaveBeenCalled()
    expect(result.current.prompt).toBeNull()
  })

  it('does not prompt when every note task is already in the new project', async () => {
    mocks.getLinkedTasks.mockResolvedValue([task('t1', 'work'), task('t3', 'work')])

    const { result } = renderHook(() => useNoteProjectTaskMove('note-1', NOTE_BODY))

    act(() => {
      result.current.handleProjectPropertyChange([], ['Work'])
    })

    await waitFor(() => expect(mocks.getLinkedTasks).toHaveBeenCalledWith('note-1'))
    expect(result.current.prompt).toBeNull()
  })

  it('moves the confirmed tasks and their subtasks, then closes', async () => {
    mocks.getLinkedTasks.mockResolvedValue([task('t1', 'inbox'), task('t3', 'inbox')])
    mocks.getSubtasks.mockImplementation((parentId: string) =>
      Promise.resolve(
        parentId === 't1' ? [task('t2', 'inbox', 't1'), task('t4', 'work', 't1')] : []
      )
    )

    const { result } = renderHook(() => useNoteProjectTaskMove('note-1', NOTE_BODY))

    act(() => {
      result.current.handleProjectPropertyChange([], ['Work'])
    })
    await waitFor(() => expect(result.current.prompt).not.toBeNull())

    act(() => {
      result.current.confirmMove()
    })

    await waitFor(() => expect(result.current.prompt).toBeNull())
    expect(mocks.update.mock.calls.map(([input]) => input)).toEqual([
      { id: 't1', projectId: 'work' },
      { id: 't2', projectId: 'work' },
      { id: 't3', projectId: 'work' }
    ])
  })

  it('leaves every task alone when the move is declined', async () => {
    mocks.getLinkedTasks.mockResolvedValue([task('t1', 'inbox')])

    const { result } = renderHook(() => useNoteProjectTaskMove('note-1', NOTE_BODY))

    act(() => {
      result.current.handleProjectPropertyChange([], ['Work'])
    })
    await waitFor(() => expect(result.current.prompt).not.toBeNull())

    act(() => {
      result.current.cancelMove()
    })

    expect(result.current.prompt).toBeNull()
    expect(mocks.update).not.toHaveBeenCalled()
  })
})
