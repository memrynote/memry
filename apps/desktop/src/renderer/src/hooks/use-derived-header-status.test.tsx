import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { Task } from '@/services/tasks-service'
import { useNoteTaskCategories } from './use-derived-header-status'

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  listStatuses: vi.fn()
}))

vi.mock('@/services/tasks-service', () => {
  const noEvents = () => () => undefined
  return {
    tasksService: { get: mocks.get, listStatuses: mocks.listStatuses },
    onProjectUpdated: noEvents,
    onTaskCreated: noEvents,
    onTaskUpdated: noEvents,
    onTaskDeleted: noEvents,
    onTaskCompleted: noEvents,
    onTaskMoved: noEvents
  }
})

const statuses = [
  { id: 's-todo', projectId: 'p1', isDone: false, isDefault: true, position: 0 },
  { id: 's-doing', projectId: 'p1', isDone: false, isDefault: false, position: 1 },
  { id: 's-done', projectId: 'p1', isDone: true, isDefault: false, position: 2 }
]

const task = (id: string, statusId: string, completedAt: string | null = null): Task =>
  ({ id, projectId: 'p1', statusId, completedAt }) as Task

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
)

const serve = (...tasks: Task[]): void => {
  mocks.get.mockImplementation(async (id: string) => tasks.find((it) => it.id === id) ?? null)
  mocks.listStatuses.mockResolvedValue(statuses)
}

describe('useNoteTaskCategories', () => {
  it('has no categories for a note body without task lines', () => {
    serve(task('a', 's-todo'))
    const { result } = renderHook(() => useNoteTaskCategories('Just prose'), { wrapper })
    expect(result.current).toBeNull()
  })

  it('reads the tasks the body names, whether or not they are linked to the note', async () => {
    serve(task('a', 's-todo'), task('b', 's-doing'), task('c', 's-done'))
    const { result } = renderHook(
      () => useNoteTaskCategories('- [ ] A {task:a}\n- [ ] B {task:b}'),
      { wrapper }
    )

    await waitFor(() => expect(result.current).toEqual(['todo', 'in_progress']))
  })

  it('reads a done task moved back to In Progress as in progress, though completedAt is left', async () => {
    serve(task('a', 's-doing', '2026-01-02T00:00:00.000Z'))
    const { result } = renderHook(() => useNoteTaskCategories('- [x] A {task:a}'), { wrapper })

    await waitFor(() => expect(result.current).toEqual(['in_progress']))
  })

  it('reads a task completed without moving its status as done', async () => {
    serve(task('a', 's-todo', '2026-01-02T00:00:00.000Z'))
    const { result } = renderHook(() => useNoteTaskCategories('- [x] A {task:a}'), { wrapper })

    await waitFor(() => expect(result.current).toEqual(['done']))
  })

  it('skips a task whose row has not arrived', async () => {
    serve(task('a', 's-done'))
    const { result } = renderHook(
      () => useNoteTaskCategories('- [ ] A {task:a}\n- [ ] M {task:missing}'),
      { wrapper }
    )

    await waitFor(() => expect(result.current).toEqual(['done']))
  })
})
