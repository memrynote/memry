import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import type { ReactElement, ReactNode } from 'react'

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  getLinkedTasks: vi.fn(),
  onTaskUpdated: vi.fn(() => () => {}),
  onTaskCompleted: vi.fn(() => () => {}),
  onTaskDeleted: vi.fn(() => () => {})
}))

vi.mock('@/services/tasks-service', () => ({
  tasksService: { get: mocks.get, getLinkedTasks: mocks.getLinkedTasks },
  onTaskUpdated: mocks.onTaskUpdated,
  onTaskCompleted: mocks.onTaskCompleted,
  onTaskDeleted: mocks.onTaskDeleted
}))

import { useTaskBlockData } from './use-task-block-data'
import { TaskPrefetchProvider } from './task-prefetch-context'

const task = (id: string): { id: string; title: string } => ({ id, title: `Task ${id}` })

function makeWrapper(noteId?: string) {
  return ({ children }: { children: ReactNode }): ReactElement => (
    <TaskPrefetchProvider noteId={noteId}>{children}</TaskPrefetchProvider>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useTaskBlockData with batch prefetch', () => {
  it('serves a linked task from the single getLinkedTasks batch (no per-block get)', async () => {
    // #given the note's tasks are returned by the batch prefetch
    mocks.getLinkedTasks.mockResolvedValue([task('t1'), task('t2')])

    // #when
    const { result } = renderHook(() => useTaskBlockData('t1'), {
      wrapper: makeWrapper('note-1')
    })

    // #then the task resolves from the batch and no individual get fires
    await waitFor(() => expect(result.current.task?.id).toBe('t1'))
    expect(mocks.getLinkedTasks).toHaveBeenCalledTimes(1)
    expect(mocks.getLinkedTasks).toHaveBeenCalledWith('note-1')
    expect(mocks.get).not.toHaveBeenCalled()
  })

  it('falls back to tasksService.get when a task is not in the batch', async () => {
    // #given the batch does not include this task (e.g. just created)
    mocks.getLinkedTasks.mockResolvedValue([])
    mocks.get.mockResolvedValue(task('t9'))

    // #when
    const { result } = renderHook(() => useTaskBlockData('t9'), {
      wrapper: makeWrapper('note-1')
    })

    // #then it fetches the single task individually
    await waitFor(() => expect(result.current.task?.id).toBe('t9'))
    expect(mocks.get).toHaveBeenCalledTimes(1)
    expect(mocks.get).toHaveBeenCalledWith('t9')
  })
})
