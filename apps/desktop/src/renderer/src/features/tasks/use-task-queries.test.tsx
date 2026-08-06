import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { taskKeys, useTaskWorkspaceData, useTaskWorkspaceMutations } from './use-task-queries'
import { tasksService } from '@/services/tasks-service'

const mocks = vi.hoisted(() => ({
  log: {
    warn: vi.fn(),
    error: vi.fn()
  },
  listeners: {} as Record<string, () => void>,
  unsubscribe: vi.fn()
}))

vi.mock('@/lib/logger', () => ({
  createLogger: () => mocks.log
}))

vi.mock('@/services/tasks-service', () => {
  const subscribe = (name: string) =>
    vi.fn((callback: () => void) => {
      mocks.listeners[name] = callback
      return mocks.unsubscribe
    })

  return {
    tasksService: {
      listProjects: vi.fn(),
      listStatuses: vi.fn(),
      list: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      complete: vi.fn(),
      uncomplete: vi.fn(),
      archive: vi.fn(),
      unarchive: vi.fn(),
      delete: vi.fn(),
      createProject: vi.fn(),
      updateProject: vi.fn(),
      deleteProject: vi.fn()
    },
    onTaskCreated: subscribe('taskCreated'),
    onTaskUpdated: subscribe('taskUpdated'),
    onTaskDeleted: subscribe('taskDeleted'),
    onTaskCompleted: subscribe('taskCompleted'),
    onProjectCreated: subscribe('projectCreated'),
    onProjectUpdated: subscribe('projectUpdated'),
    onProjectDeleted: subscribe('projectDeleted')
  }
})

function createWrapper(
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  }
}

function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    id: 'task-1',
    projectId: 'project-1',
    statusId: 'status-1',
    parentId: null,
    title: 'Task one',
    description: null,
    priority: 3,
    dueDate: '2026-05-10',
    dueTime: '09:30',
    repeatConfig: null,
    linkedNoteIds: ['note-1'],
    sourceNoteId: 'source-note',
    completedAt: null,
    archivedAt: null,
    createdAt: '2026-05-01T00:00:00.000Z',
    ...overrides
  }
}

describe('useTaskWorkspaceData', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.listeners = {}
    window.api.onItemSynced = vi.fn((callback) => {
      mocks.listeners.itemSyncedTask = () => callback({ type: 'task', id: 'task-1' } as never)
      mocks.listeners.itemSyncedProject = () =>
        callback({ type: 'project', id: 'project-1' } as never)
      return mocks.unsubscribe
    })
    vi.mocked(tasksService.listProjects).mockResolvedValue({
      projects: [
        {
          id: 'project-1',
          name: 'Inbox',
          description: null,
          icon: null,
          color: '#6366f1',
          isInbox: true,
          archivedAt: null,
          createdAt: '2026-05-01T00:00:00.000Z',
          taskCount: 2
        }
      ]
    } as never)
    vi.mocked(tasksService.listStatuses).mockResolvedValue([
      { id: 'todo', name: 'Todo', color: '#aaa', position: 0, isDefault: true, isDone: false },
      { id: 'doing', name: 'Doing', color: '#bbb', position: 1, isDefault: true, isDone: false },
      { id: 'done', name: 'Done', color: '#ccc', position: 2, isDefault: false, isDone: true }
    ] as never)
    vi.mocked(tasksService.list).mockResolvedValue({
      tasks: [
        makeTask({
          id: 'task-1',
          title: 'Parent',
          repeatConfig: {
            frequency: 'weekly',
            endType: 'date',
            interval: 2,
            daysOfWeek: [1, 3],
            endDate: '2026-06-01',
            completedCount: 1,
            createdAt: '2026-05-01T00:00:00.000Z'
          }
        }),
        makeTask({
          id: 'child-late',
          parentId: 'task-1',
          title: 'Child late',
          createdAt: '2026-05-03T00:00:00.000Z'
        }),
        makeTask({
          id: 'child-early',
          parentId: 'task-1',
          title: 'Child early',
          createdAt: '2026-05-02T00:00:00.000Z'
        })
      ]
    } as never)
  })

  it('loads tasks/projects, maps DB shapes, attaches sorted subtasks, and registers invalidators', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    const { result, unmount } = renderHook(() => useTaskWorkspaceData({ enabled: true }), {
      wrapper: createWrapper(queryClient)
    })

    await waitFor(() => expect(result.current.tasks).toHaveLength(3))

    expect(result.current.projects[0]).toMatchObject({
      id: 'project-1',
      name: 'Inbox',
      icon: 'folder',
      isDefault: true,
      taskCount: 2
    })
    expect(result.current.projects[0].statuses.map((status) => status.type)).toEqual([
      'todo',
      'in_progress',
      'done'
    ])
    expect(result.current.tasks[0]).toMatchObject({
      id: 'task-1',
      priority: 'high',
      linkedNoteIds: ['note-1'],
      subtaskIds: ['child-early', 'child-late']
    })
    expect(result.current.tasks[0].repeatConfig).toMatchObject({
      frequency: 'weekly',
      interval: 2,
      completedCount: 1
    })

    act(() => mocks.listeners.taskCreated())
    expect(invalidate).toHaveBeenCalledWith({ queryKey: taskKeys.tasks() })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: taskKeys.projects() })

    act(() => mocks.listeners.itemSyncedProject())
    expect(invalidate).toHaveBeenCalledWith({ queryKey: taskKeys.projects() })

    unmount()
    expect(mocks.unsubscribe).toHaveBeenCalled()
  })

  it('does not load or subscribe when disabled', () => {
    const { result } = renderHook(() => useTaskWorkspaceData({ enabled: false }), {
      wrapper: createWrapper()
    })

    expect(result.current.tasks).toEqual([])
    expect(result.current.projects).toEqual([])
    expect(tasksService.list).not.toHaveBeenCalled()
    expect(Object.keys(mocks.listeners)).toEqual([])
  })
})

describe('useTaskWorkspaceMutations', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(tasksService.create).mockResolvedValue({ success: true } as never)
    vi.mocked(tasksService.update).mockResolvedValue({ success: true } as never)
    vi.mocked(tasksService.complete).mockResolvedValue({ success: true } as never)
    vi.mocked(tasksService.uncomplete).mockResolvedValue({ success: true } as never)
    vi.mocked(tasksService.archive).mockResolvedValue({ success: true } as never)
    vi.mocked(tasksService.unarchive).mockResolvedValue({ success: true } as never)
    vi.mocked(tasksService.delete).mockResolvedValue({ success: true } as never)
    vi.mocked(tasksService.createProject).mockResolvedValue({ success: true } as never)
    vi.mocked(tasksService.updateProject).mockResolvedValue({ success: true } as never)
    vi.mocked(tasksService.deleteProject).mockResolvedValue({ success: true } as never)
  })

  it('optimistically mutates tasks and forwards service payloads', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    queryClient.setQueryData(taskKeys.tasks(), [])
    const { result } = renderHook(() => useTaskWorkspaceMutations(), {
      wrapper: createWrapper(queryClient)
    })

    const task = {
      id: 'local-task',
      title: 'Local task',
      description: '',
      projectId: 'project-1',
      statusId: 'status-1',
      priority: 'urgent' as const,
      dueDate: new Date('2026-05-10T00:00:00.000Z'),
      dueTime: '10:00',
      isRepeating: true,
      repeatConfig: {
        frequency: 'daily' as const,
        interval: 1,
        endType: 'count' as const,
        endCount: 3,
        completedCount: 0,
        createdAt: new Date('2026-05-01T00:00:00.000Z')
      },
      linkedNoteIds: ['note-1'],
      sourceNoteId: null,
      parentId: null,
      subtaskIds: [],
      createdAt: new Date('2026-05-01T00:00:00.000Z'),
      completedAt: null,
      archivedAt: null
    }

    await act(async () => {
      await result.current.addTask(task)
    })

    expect(queryClient.getQueryData(taskKeys.tasks())).toEqual([task])
    expect(tasksService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Local task',
        description: null,
        priority: 4,
        dueDate: '2026-05-10',
        linkedNoteIds: ['note-1'],
        repeatConfig: expect.objectContaining({
          frequency: 'daily',
          createdAt: '2026-05-01T00:00:00.000Z'
        })
      })
    )

    await act(async () => {
      await result.current.updateTask('local-task', {
        completedAt: new Date('2026-05-11T00:00:00.000Z'),
        title: 'Completed title'
      })
    })
    expect(tasksService.complete).toHaveBeenCalledWith({
      id: 'local-task',
      completedAt: '2026-05-11T00:00:00.000Z'
    })
    expect(tasksService.update).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'local-task', title: 'Completed title' })
    )

    await act(async () => {
      await result.current.updateTask('local-task', {
        archivedAt: new Date('2026-05-12T00:00:00.000Z')
      })
    })
    expect(tasksService.archive).toHaveBeenCalledWith('local-task')

    await act(async () => {
      await result.current.updateTask('local-task', {
        priority: 'low',
        dueDate: null,
        repeatConfig: null,
        linkedNoteIds: []
      })
    })
    expect(tasksService.update).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'local-task',
        priority: 1,
        dueDate: null,
        repeatConfig: null,
        linkedNoteIds: []
      })
    )

    await act(async () => {
      await result.current.deleteTask('local-task')
    })
    expect(tasksService.delete).toHaveBeenCalledWith('local-task')
    expect(queryClient.getQueryData(taskKeys.tasks())).toEqual([])
  })

  it('optimistically mutates projects and forwards service payloads', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    queryClient.setQueryData(taskKeys.projects(), [])
    const { result } = renderHook(() => useTaskWorkspaceMutations(), {
      wrapper: createWrapper(queryClient)
    })

    const project = {
      id: 'project-1',
      name: 'Project',
      description: '',
      icon: 'folder',
      color: '#6366f1',
      isDefault: false,
      isArchived: false,
      createdAt: new Date('2026-05-01T00:00:00.000Z'),
      taskCount: 0,
      statuses: [
        { id: 'todo', name: 'Todo', color: '#aaa', type: 'todo' as const, order: 0 },
        { id: 'done', name: 'Done', color: '#bbb', type: 'done' as const, order: 1 }
      ]
    }

    await act(async () => {
      await result.current.addProject(project)
    })
    expect(queryClient.getQueryData(taskKeys.projects())).toEqual([project])
    expect(tasksService.createProject).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Project',
        description: null,
        statuses: [
          { name: 'Todo', color: '#aaa', type: 'todo', order: 0 },
          { name: 'Done', color: '#bbb', type: 'done', order: 1 }
        ]
      })
    )

    await act(async () => {
      await result.current.updateProject('project-1', {
        name: 'Renamed',
        statuses: [{ id: 'todo', name: 'Next', color: '#ccc', type: 'in_progress', order: 0 }]
      })
    })
    expect(tasksService.updateProject).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'project-1',
        name: 'Renamed',
        statuses: [{ id: 'todo', name: 'Next', color: '#ccc', type: 'in_progress', order: 0 }]
      })
    )

    await act(async () => {
      await result.current.deleteProject('project-1')
    })
    expect(tasksService.deleteProject).toHaveBeenCalledWith('project-1')
    expect(queryClient.getQueryData(taskKeys.projects())).toEqual([])
  })

  it('logs service failures after optimistic task and project updates', async () => {
    vi.mocked(tasksService.create).mockRejectedValueOnce(new Error('task failed'))
    vi.mocked(tasksService.createProject).mockRejectedValueOnce(new Error('project failed'))
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { result } = renderHook(() => useTaskWorkspaceMutations(), {
      wrapper: createWrapper(queryClient)
    })

    await act(async () => {
      await result.current.addTask({
        id: 'bad-task',
        title: 'Bad',
        description: '',
        projectId: 'project-1',
        statusId: '',
        priority: 'none',
        dueDate: null,
        dueTime: null,
        isRepeating: false,
        repeatConfig: null,
        linkedNoteIds: [],
        sourceNoteId: null,
        parentId: null,
        subtaskIds: [],
        createdAt: new Date('2026-05-01T00:00:00.000Z'),
        completedAt: null,
        archivedAt: null
      })
      // Project mutations rethrow so callers can skip their success toast.
      await expect(
        result.current.addProject({
          id: 'bad-project',
          name: 'Bad',
          description: '',
          icon: 'folder',
          color: '#6366f1',
          isDefault: false,
          isArchived: false,
          createdAt: new Date('2026-05-01T00:00:00.000Z'),
          taskCount: 0,
          statuses: []
        })
      ).rejects.toThrow('project failed')
    })

    expect(mocks.log.error).toHaveBeenCalledWith('Failed to create task:', expect.any(Error))
    expect(mocks.log.error).toHaveBeenCalledWith('Failed to create project:', expect.any(Error))
  })

  // Regression: editing a task's description (or any field that does not carry a
  // dueDate) must NOT clear the due date. The renderer payload builder used to
  // emit `dueDate: null` whenever the update lacked a dueDate, silently wiping it.
  describe('updateTask preserves dueDate on partial updates', () => {
    function lastUpdatePayload() {
      const calls = vi.mocked(tasksService.update).mock.calls
      return calls[calls.length - 1][0] as Record<string, unknown>
    }

    function renderMutations() {
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
      queryClient.setQueryData(taskKeys.tasks(), [])
      return renderHook(() => useTaskWorkspaceMutations(), {
        wrapper: createWrapper(queryClient)
      })
    }

    it('omits dueDate (does not null it) when updating only the description', async () => {
      const { result } = renderMutations()

      await act(async () => {
        await result.current.updateTask('task-1', { description: 'a new description' })
      })

      const payload = lastUpdatePayload()
      expect(payload).toMatchObject({ id: 'task-1', description: 'a new description' })
      // undefined = Drizzle skips the column = existing due date preserved.
      expect(payload.dueDate).toBeUndefined()
    })

    it('still clears dueDate when the update explicitly sets it to null', async () => {
      const { result } = renderMutations()

      await act(async () => {
        await result.current.updateTask('task-1', { dueDate: null })
      })

      expect(lastUpdatePayload().dueDate).toBeNull()
    })

    it('formats and sends dueDate when the update provides a date', async () => {
      const { result } = renderMutations()

      await act(async () => {
        await result.current.updateTask('task-1', {
          dueDate: new Date('2026-05-10T12:00:00.000Z')
        })
      })

      expect(lastUpdatePayload().dueDate).toBe('2026-05-10')
    })

    it('preserves dueDate when completing a task with other field edits', async () => {
      const { result } = renderMutations()

      await act(async () => {
        await result.current.updateTask('task-1', {
          completedAt: new Date('2026-05-11T00:00:00.000Z'),
          description: 'done note'
        })
      })

      // The "other updates" branch must also omit dueDate.
      expect(lastUpdatePayload().dueDate).toBeUndefined()
    })

    it('preserves dueDate when archiving a task with other field edits', async () => {
      const { result } = renderMutations()

      await act(async () => {
        await result.current.updateTask('task-1', {
          archivedAt: new Date('2026-05-12T00:00:00.000Z'),
          description: 'archive note'
        })
      })

      expect(lastUpdatePayload().dueDate).toBeUndefined()
    })
  })

  // Regression: dragging a timed task onto an all-day calendar cell calls
  // updateTask(id, { dueDate, dueTime: null }) to clear the time. The payload
  // builder used to map `dueTime: updates.dueTime ?? undefined`, so
  // `null ?? undefined` produced `undefined` and the service silently
  // dropped the field, leaving the old due_time in place.
  describe('updateTask preserves dueTime on partial updates', () => {
    function lastUpdatePayload() {
      const calls = vi.mocked(tasksService.update).mock.calls
      return calls[calls.length - 1][0] as Record<string, unknown>
    }

    function renderMutations() {
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
      queryClient.setQueryData(taskKeys.tasks(), [])
      return renderHook(() => useTaskWorkspaceMutations(), {
        wrapper: createWrapper(queryClient)
      })
    }

    it('clears dueTime (sends null, not undefined) when dropped on an all-day cell', async () => {
      const { result } = renderMutations()

      await act(async () => {
        await result.current.updateTask('task-1', {
          dueDate: new Date('2026-05-10T00:00:00.000Z'),
          dueTime: null
        })
      })

      const payload = lastUpdatePayload()
      expect(payload.dueTime).toBeNull()
      expect(payload.dueDate).toBe('2026-05-10')
    })

    it('omits dueTime (does not clear it) when updating only the description', async () => {
      const { result } = renderMutations()

      await act(async () => {
        await result.current.updateTask('task-1', { description: 'a new description' })
      })

      // undefined = Drizzle skips the column = existing due time preserved.
      expect(lastUpdatePayload().dueTime).toBeUndefined()
    })
  })

  // Regression coverage for the tags payload-builder branches: updateTask must
  // forward tag edits, but an update that doesn't touch tags must leave them
  // undefined (not []), or every unrelated task edit would silently wipe tags.
  describe('updateTask forwards tags without clobbering untouched tags', () => {
    function lastUpdatePayload() {
      const calls = vi.mocked(tasksService.update).mock.calls
      return calls[calls.length - 1][0] as Record<string, unknown>
    }

    function renderMutations() {
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
      queryClient.setQueryData(taskKeys.tasks(), [])
      return renderHook(() => useTaskWorkspaceMutations(), {
        wrapper: createWrapper(queryClient)
      })
    }

    it('forwards the tags array when the update includes tags', async () => {
      const { result } = renderMutations()

      await act(async () => {
        await result.current.updateTask('task-1', { tags: ['work', 'urgent'] })
      })

      expect(lastUpdatePayload().tags).toEqual(['work', 'urgent'])
    })

    it('omits tags (does not clobber to []) when updating a field that does not touch tags', async () => {
      const { result } = renderMutations()

      await act(async () => {
        await result.current.updateTask('task-1', { description: 'a new description' })
      })

      expect(lastUpdatePayload().tags).toBeUndefined()
    })

    it('preserves tags when completing a task with other field edits', async () => {
      const { result } = renderMutations()

      await act(async () => {
        await result.current.updateTask('task-1', {
          completedAt: new Date('2026-05-11T00:00:00.000Z'),
          description: 'done note'
        })
      })

      expect(lastUpdatePayload().tags).toBeUndefined()
    })

    it('preserves tags when archiving a task with other field edits', async () => {
      const { result } = renderMutations()

      await act(async () => {
        await result.current.updateTask('task-1', {
          archivedAt: new Date('2026-05-12T00:00:00.000Z'),
          description: 'archive note'
        })
      })

      expect(lastUpdatePayload().tags).toBeUndefined()
    })
  })
})
