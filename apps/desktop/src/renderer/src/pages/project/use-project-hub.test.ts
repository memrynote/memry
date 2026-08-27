import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { tasksService } from '@/services/tasks-service'
import { flattenTasksByStatus } from '@/lib/virtual-list-utils'
import { deriveProgress, useProjectHub } from './use-project-hub'
import type { Project, Status } from '@/data/tasks-data'
import type { Task } from '@/data/task-model'

// The hook reads the whole workspace out of context; tests swap what it sees.
const workspace = vi.hoisted(() => ({
  current: { tasks: [] as unknown[], projects: [] as unknown[] }
}))

vi.mock('@/contexts/tasks', () => ({
  useTasksContext: () => workspace.current
}))

vi.mock('@/services/tasks-service', () => ({
  tasksService: { listProjectContents: vi.fn(), getProject: vi.fn() },
  onProjectUpdated: vi.fn(() => () => {})
}))

const DEFAULT_STATUSES: Status[] = [
  { id: 'todo', name: 'To Do', color: '#6b7280', type: 'todo', order: 0 },
  { id: 'doing', name: 'In Progress', color: '#f59e0b', type: 'in_progress', order: 1 },
  { id: 'done', name: 'Done', color: '#10b981', type: 'done', order: 2 }
]

const makeProject = (statuses: Status[] = DEFAULT_STATUSES): Project => ({
  id: 'p1',
  name: 'Hub',
  description: '',
  icon: 'folder',
  color: '#6366f1',
  statuses,
  isDefault: false,
  isArchived: false,
  createdAt: new Date('2026-03-02T00:00:00.000Z'),
  taskCount: 0
})

let seq = 0
const makeTask = (overrides: Partial<Task> = {}): Task => ({
  id: `t${++seq}`,
  title: 'Task',
  description: '',
  projectId: 'p1',
  statusId: 'todo',
  priority: 'none',
  dueDate: null,
  dueTime: null,
  isRepeating: false,
  repeatConfig: null,
  linkedNoteIds: [],
  sourceNoteId: null,
  tags: [],
  parentId: null,
  subtaskIds: [],
  createdAt: new Date('2026-03-02T00:00:00.000Z'),
  completedAt: null,
  archivedAt: null,
  ...overrides
})

describe('deriveProgress', () => {
  it('emits one row per project status, including duplicate types', () => {
    const project = makeProject([
      { id: 's1', name: 'To Do', color: '#000', type: 'todo', order: 0 },
      { id: 's2', name: 'Building', color: '#000', type: 'in_progress', order: 1 },
      { id: 's3', name: 'Reviewing', color: '#000', type: 'in_progress', order: 2 },
      { id: 's4', name: 'Done', color: '#000', type: 'done', order: 3 }
    ])
    const tasks = [
      makeTask({ statusId: 's1' }),
      makeTask({ statusId: 's2' }),
      makeTask({ statusId: 's3' }),
      makeTask({ statusId: 's4' })
    ]

    const progress = deriveProgress(project, tasks)

    expect(progress.statuses.map((s) => [s.name, s.count])).toEqual([
      ['To Do', 1],
      ['Building', 1],
      ['Reviewing', 1],
      ['Done', 1]
    ])
    expect(progress.done).toBe(1)
    expect(progress.total).toBe(4)
    expect(progress.pct).toBe(25)
  })

  it('orders status rows by the project configuration, not insertion order', () => {
    const project = makeProject([
      { id: 's2', name: 'Second', color: '#000', type: 'in_progress', order: 1 },
      { id: 's1', name: 'First', color: '#000', type: 'todo', order: 0 }
    ])
    expect(deriveProgress(project, []).statuses.map((s) => s.name)).toEqual(['First', 'Second'])
  })

  it('counts done from the status type, not completedAt', () => {
    // A task sitting in a done-type status is done even if completedAt never got
    // stamped (older rows, or a status flipped to done after the fact).
    const tasks = [
      makeTask({ statusId: 'done', completedAt: null }),
      makeTask({ statusId: 'todo' })
    ]
    expect(deriveProgress(makeProject(), tasks).done).toBe(1)
  })

  it('counts overdue as past-due tasks not in a done status', () => {
    const yesterday = new Date(Date.now() - 86_400_000)
    const tasks = [
      makeTask({ statusId: 'todo', dueDate: yesterday }),
      makeTask({ statusId: 'done', dueDate: yesterday, completedAt: new Date() })
    ]
    expect(deriveProgress(makeProject(), tasks).overdue).toBe(1)
  })

  it('does not count a task due earlier today as overdue', () => {
    const earlierToday = new Date()
    earlierToday.setHours(0, 30, 0, 0)
    const tasks = [makeTask({ statusId: 'todo', dueDate: earlierToday })]
    expect(deriveProgress(makeProject(), tasks).overdue).toBe(0)
  })

  it('reports 0% for an empty project without dividing by zero', () => {
    const progress = deriveProgress(makeProject(), [])
    expect(progress.pct).toBe(0)
    expect(progress.total).toBe(0)
    expect(progress.overdue).toBe(0)
  })

  it('returns an empty shape when there is no project', () => {
    const progress = deriveProgress(null, [])
    expect(progress).toEqual({ done: 0, total: 0, pct: 0, statuses: [], overdue: 0 })
  })

  it('ignores tasks whose status no longer exists on the project', () => {
    const tasks = [makeTask({ statusId: 'deleted-status' })]
    const progress = deriveProgress(makeProject(), tasks)
    expect(progress.total).toBe(1)
    expect(progress.statuses.every((s) => s.count === 0)).toBe(true)
  })
})

describe('useProjectHub', () => {
  beforeEach(() => {
    vi.mocked(tasksService.listProjectContents).mockReset()
    vi.mocked(tasksService.getProject).mockReset()
    workspace.current = { tasks: [], projects: [] }
  })

  const emptyContents = {
    notes: [],
    files: [],
    events: [],
    counts: { notes: 0, files: 0, events: 0 }
  }

  it('stops loading when the contents request fails', async () => {
    vi.mocked(tasksService.listProjectContents).mockRejectedValue(new Error('db closed'))
    vi.mocked(tasksService.getProject).mockRejectedValue(new Error('db closed'))

    const { result } = renderHook(() => useProjectHub('p1'))

    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.homeNoteId).toBeNull()
    expect(result.current.notes).toEqual([])
  })

  it('applies a new overview note id before the refetch lands', async () => {
    vi.mocked(tasksService.listProjectContents).mockResolvedValue(emptyContents)
    vi.mocked(tasksService.getProject).mockResolvedValue({
      homeNoteId: null,
      createdAt: '2026-03-02T00:00:00.000Z',
      modifiedAt: '2026-03-02T00:00:00.000Z'
    } as never)

    const { result } = renderHook(() => useProjectHub('p1'))

    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.homeNoteId).toBeNull()

    act(() => result.current.setHomeNoteId('note-9'))
    expect(result.current.homeNoteId).toBe('note-9')
  })

  /**
   * The Tasks tab badge is a promise about the tab under it. It counted every
   * task carrying the project id — subtasks nested under a parent row, and
   * tasks whose status the project no longer has — so a project of finished
   * work advertised 130 tasks over sections reading 0, 0 and 37 (#1878).
   */
  it('counts exactly the rows the Tasks tab lists', async () => {
    const project = makeProject()
    const parent = makeTask({ id: 'parent', subtaskIds: ['sub'] })
    const tasks = [
      parent,
      makeTask({ id: 'sub', parentId: 'parent' }),
      makeTask({ id: 'done', statusId: 'done', completedAt: new Date() }),
      makeTask({ id: 'ghost-status', statusId: 'status-deleted-long-ago' }),
      makeTask({ id: 'archived', archivedAt: new Date() })
    ]
    workspace.current = { tasks, projects: [project] }

    vi.mocked(tasksService.listProjectContents).mockResolvedValue(emptyContents)
    vi.mocked(tasksService.getProject).mockResolvedValue(null as never)

    const { result } = renderHook(() => useProjectHub('p1'))
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    const rows = flattenTasksByStatus(
      result.current.tasks,
      project,
      new Set<string>(),
      result.current.tasks,
      true
    ).filter((item) => item.type === 'task' || item.type === 'parent-task')

    // parent, done and ghost-status. The subtask renders under its parent and
    // the archived task renders nowhere.
    expect(rows).toHaveLength(3)
    expect(result.current.counts.tasks).toBe(rows.length)
  })
})
