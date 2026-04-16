import { describe, it, expect, beforeEach, vi } from 'vitest'
import type {
  Project,
  ProjectWithStats,
  ProjectWithStatuses,
  Status,
  Task,
  TaskStats
} from '@memry/domain-tasks'
import {
  createTasksRepository,
  type ProjectQueryModule,
  type TaskQueryModule
} from './tasks-repository'

type TestDb = { __test: true }

type TaskRow = Omit<Task, 'isRepeating' | 'priority' | 'repeatConfig' | 'repeatFrom'> & {
  priority: number
  repeatConfig: unknown
  repeatFrom: string | null
}

function makeTaskRow(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: 'task-1',
    projectId: 'proj-1',
    statusId: 'status-todo',
    parentId: null,
    title: 'Task',
    description: null,
    priority: 0,
    position: 0,
    dueDate: null,
    dueTime: null,
    startDate: null,
    repeatConfig: null,
    repeatFrom: null,
    sourceNoteId: null,
    completedAt: null,
    archivedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    modifiedAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  }
}

function makeStatus(overrides: Partial<Status> = {}): Status {
  return {
    id: 'status-todo',
    projectId: 'proj-1',
    name: 'Todo',
    color: '#000',
    position: 0,
    isDefault: true,
    isDone: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  }
}

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'proj-1',
    name: 'Project',
    description: null,
    color: '#000',
    icon: null,
    position: 0,
    isInbox: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    modifiedAt: '2026-01-01T00:00:00.000Z',
    archivedAt: null,
    ...overrides
  }
}

function createTaskQueries(): TaskQueryModule<TestDb> {
  return {
    insertTask: vi.fn((_db, task) => makeTaskRow(task as Partial<TaskRow>)),
    updateTask: vi.fn((_db, id, updates) => makeTaskRow({ id, ...(updates as Partial<TaskRow>) })),
    deleteTask: vi.fn(),
    getTaskById: vi.fn(),
    listTasks: vi.fn(() => []),
    countTasks: vi.fn(() => 0),
    getSubtasks: vi.fn(() => []),
    countSubtasks: vi.fn(() => ({ total: 0, completed: 0 })),
    completeTask: vi.fn((_db, id) =>
      makeTaskRow({ id, completedAt: '2026-04-16T00:00:00.000Z' })
    ),
    uncompleteTask: vi.fn((_db, id) => makeTaskRow({ id, completedAt: null })),
    archiveTask: vi.fn((_db, id) =>
      makeTaskRow({ id, archivedAt: '2026-04-16T00:00:00.000Z' })
    ),
    unarchiveTask: vi.fn((_db, id) => makeTaskRow({ id, archivedAt: null })),
    moveTask: vi.fn((_db, id, updates) =>
      makeTaskRow({ id, ...(updates as Partial<TaskRow>) })
    ),
    reorderTasks: vi.fn(),
    duplicateTask: vi.fn((_db, _id, newId) => makeTaskRow({ id: newId })),
    duplicateSubtask: vi.fn((_db, _id, newId, newParentId) =>
      makeTaskRow({ id: newId, parentId: newParentId })
    ),
    setTaskTags: vi.fn(),
    getTaskTags: vi.fn(() => []),
    setTaskNotes: vi.fn(),
    getTaskNoteIds: vi.fn(() => []),
    getAllTaskTags: vi.fn(() => []),
    getTaskStats: vi.fn<TaskQueryModule<TestDb>['getTaskStats']>(
      () =>
        ({
          total: 0,
          completed: 0,
          overdue: 0,
          dueToday: 0,
          dueThisWeek: 0
        }) satisfies TaskStats
    ),
    getTodayTasks: vi.fn(() => []),
    getUpcomingTasks: vi.fn(() => []),
    getOverdueTasks: vi.fn(() => []),
    getTasksLinkedToNote: vi.fn(() => []),
    getNextTaskPosition: vi.fn(() => 0),
    bulkCompleteTasks: vi.fn(() => 0),
    bulkDeleteTasks: vi.fn(() => 0),
    bulkMoveTasks: vi.fn(() => 0),
    bulkArchiveTasks: vi.fn(() => 0)
  }
}

function createProjectQueries(): ProjectQueryModule<TestDb> {
  return {
    insertProject: vi.fn((_db, project) => makeProject(project as Partial<Project>)),
    updateProject: vi.fn((_db, id) => makeProject({ id })),
    deleteProject: vi.fn(),
    getProjectWithStatuses: vi.fn<ProjectQueryModule<TestDb>['getProjectWithStatuses']>(
      (_db, id) => ({
        ...makeProject({ id }),
        statuses: [makeStatus()]
      }) satisfies ProjectWithStatuses
    ),
    getProjectsWithStats: vi.fn<ProjectQueryModule<TestDb>['getProjectsWithStats']>(
      () => [
        {
          ...makeProject(),
          taskCount: 2,
          completedCount: 1,
          overdueCount: 0
        } satisfies ProjectWithStats
      ]
    ),
    archiveProject: vi.fn((_db, id) =>
      makeProject({ id, archivedAt: '2026-04-16T00:00:00.000Z' })
    ),
    reorderProjects: vi.fn(),
    getNextProjectPosition: vi.fn(() => 3),
    insertStatus: vi.fn((_db, status) => makeStatus(status as Partial<Status>)),
    updateStatus: vi.fn((_db, id) => makeStatus({ id })),
    deleteStatus: vi.fn(),
    getStatusesByProject: vi.fn(() => [makeStatus()]),
    reorderStatuses: vi.fn(),
    getNextStatusPosition: vi.fn(() => 2),
    getStatusById: vi.fn((_db, id) => makeStatus({ id })),
    getEquivalentStatus: vi.fn((_db, _pid, src) => (src ? makeStatus({ id: src.id }) : undefined)),
    createDefaultStatuses: vi.fn(() => [makeStatus()]),
    createCustomStatuses: vi.fn(() => [makeStatus()]),
    reconcileProjectStatuses: vi.fn()
  }
}

describe('createTasksRepository', () => {
  let db: TestDb
  let taskQueries: TaskQueryModule<TestDb>
  let projectQueries: ProjectQueryModule<TestDb>
  let repo: ReturnType<typeof createTasksRepository<TestDb>>

  beforeEach(() => {
    db = { __test: true }
    taskQueries = createTaskQueries()
    projectQueries = createProjectQueries()
    repo = createTasksRepository({ db, taskQueries, projectQueries })
  })

  describe('task lifecycle', () => {
    it('createTask delegates to insertTask and enriches result', () => {
      // #given
      vi.mocked(taskQueries.getTaskTags).mockReturnValue(['urgent'])
      vi.mocked(taskQueries.getTaskNoteIds).mockReturnValue(['note-1'])
      vi.mocked(taskQueries.countSubtasks).mockReturnValue({ total: 2, completed: 1 })

      // #when
      const created = repo.createTask({
        id: 'task-2',
        projectId: 'proj-1',
        statusId: null,
        parentId: null,
        title: 'New task',
        description: null,
        priority: 1,
        position: 0,
        dueDate: null,
        dueTime: null,
        startDate: null,
        repeatConfig: null,
        repeatFrom: null,
        sourceNoteId: null,
        completedAt: null,
        archivedAt: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        modifiedAt: '2026-01-01T00:00:00.000Z'
      })

      // #then
      expect(taskQueries.insertTask).toHaveBeenCalledOnce()
      expect(created.id).toBe('task-2')
      expect(created.tags).toEqual(['urgent'])
      expect(created.linkedNoteIds).toEqual(['note-1'])
      expect(created.hasSubtasks).toBe(true)
      expect(created.subtaskCount).toBe(2)
      expect(created.completedSubtaskCount).toBe(1)
      expect(created.isRepeating).toBe(false)
    })

    it('updateTask returns undefined when query returns nothing', () => {
      // #given
      vi.mocked(taskQueries.updateTask).mockReturnValue(undefined)

      // #when
      const result = repo.updateTask('missing', { title: 'x' })

      // #then
      expect(result).toBeUndefined()
    })

    it('updateTask enriches returned task', () => {
      // #when
      const result = repo.updateTask('task-1', { title: 'renamed' })

      // #then
      expect(taskQueries.updateTask).toHaveBeenCalledWith(db, 'task-1', { title: 'renamed' })
      expect(result?.id).toBe('task-1')
    })

    it('deleteTask forwards to taskQueries.deleteTask', () => {
      // #when
      repo.deleteTask('task-1')

      // #then
      expect(taskQueries.deleteTask).toHaveBeenCalledWith(db, 'task-1')
    })

    it('getTask returns undefined when missing', () => {
      vi.mocked(taskQueries.getTaskById).mockReturnValue(undefined)
      expect(repo.getTask('missing')).toBeUndefined()
    })

    it('getTask enriches when found', () => {
      vi.mocked(taskQueries.getTaskById).mockReturnValue(makeTaskRow())
      const task = repo.getTask('task-1')
      expect(task?.id).toBe('task-1')
    })

    it('completeTask sets completedAt via query', () => {
      // #when
      const result = repo.completeTask('task-1')

      // #then
      expect(taskQueries.completeTask).toHaveBeenCalledWith(db, 'task-1', undefined)
      expect(result?.completedAt).not.toBeNull()
    })

    it('completeTask returns undefined when query returns undefined', () => {
      vi.mocked(taskQueries.completeTask).mockReturnValue(undefined)
      expect(repo.completeTask('missing')).toBeUndefined()
    })

    it('uncompleteTask clears completedAt', () => {
      const result = repo.uncompleteTask('task-1')
      expect(result?.completedAt).toBeNull()
    })

    it('archive / unarchive delegate + enrich', () => {
      expect(repo.archiveTask('task-1')?.archivedAt).not.toBeNull()
      expect(repo.unarchiveTask('task-1')?.archivedAt).toBeNull()
    })

    it('moveTask passes updates through', () => {
      repo.moveTask('task-1', { projectId: 'proj-2', position: 5 })
      expect(taskQueries.moveTask).toHaveBeenCalledWith(db, 'task-1', {
        projectId: 'proj-2',
        position: 5
      })
    })

    it('reorderTasks forwards ids + positions', () => {
      repo.reorderTasks(['a', 'b'], [1, 0])
      expect(taskQueries.reorderTasks).toHaveBeenCalledWith(db, ['a', 'b'], [1, 0])
    })

    it('duplicateTask / duplicateSubtask delegate', () => {
      expect(repo.duplicateTask('task-1', 'task-1-copy')?.id).toBe('task-1-copy')
      const sub = repo.duplicateSubtask('task-1', 'sub-copy', 'parent-2')
      expect(sub?.parentId).toBe('parent-2')
    })
  })

  describe('list + count', () => {
    it('listTasks enriches each row', () => {
      // #given
      vi.mocked(taskQueries.listTasks).mockReturnValue([makeTaskRow({ id: 'a' }), makeTaskRow({ id: 'b' })])

      // #when
      const list = repo.listTasks({ projectId: 'proj-1' })

      // #then
      expect(list).toHaveLength(2)
      expect(list.map((t) => t.id)).toEqual(['a', 'b'])
      expect(taskQueries.listTasks).toHaveBeenCalledWith(db, { projectId: 'proj-1' })
    })

    it('countTasks delegates to query', () => {
      vi.mocked(taskQueries.countTasks).mockReturnValue(42)
      expect(repo.countTasks({ includeCompleted: true })).toBe(42)
    })

    it('getSubtasks / countSubtasks delegate', () => {
      vi.mocked(taskQueries.getSubtasks).mockReturnValue([makeTaskRow({ id: 'sub-1' })])
      expect(repo.getSubtasks('task-1')).toHaveLength(1)
      expect(repo.countSubtasks('task-1')).toEqual({ total: 0, completed: 0 })
    })

    it('getTodayTasks / getUpcomingTasks / getOverdueTasks / getTasksLinkedToNote enrich', () => {
      vi.mocked(taskQueries.getTodayTasks).mockReturnValue([makeTaskRow({ id: 't' })])
      vi.mocked(taskQueries.getUpcomingTasks).mockReturnValue([makeTaskRow({ id: 'u' })])
      vi.mocked(taskQueries.getOverdueTasks).mockReturnValue([makeTaskRow({ id: 'o' })])
      vi.mocked(taskQueries.getTasksLinkedToNote).mockReturnValue([makeTaskRow({ id: 'l' })])

      expect(repo.getTodayTasks()).toHaveLength(1)
      expect(repo.getUpcomingTasks(7)).toHaveLength(1)
      expect(repo.getOverdueTasks()).toHaveLength(1)
      expect(repo.getTasksLinkedToNote('note-1')).toHaveLength(1)
      expect(taskQueries.getUpcomingTasks).toHaveBeenCalledWith(db, 7)
    })

    it('getNextTaskPosition passes parentId through', () => {
      repo.getNextTaskPosition('proj-1', 'parent-1')
      expect(taskQueries.getNextTaskPosition).toHaveBeenCalledWith(db, 'proj-1', 'parent-1')
    })
  })

  describe('tags and notes', () => {
    it('get/setTaskTags delegate', () => {
      vi.mocked(taskQueries.getTaskTags).mockReturnValue(['urgent'])
      expect(repo.getTaskTags('task-1')).toEqual(['urgent'])
      repo.setTaskTags('task-1', ['new'])
      expect(taskQueries.setTaskTags).toHaveBeenCalledWith(db, 'task-1', ['new'])
    })

    it('get/setTaskNoteIds delegate', () => {
      vi.mocked(taskQueries.getTaskNoteIds).mockReturnValue(['n'])
      expect(repo.getTaskNoteIds('task-1')).toEqual(['n'])
      repo.setTaskNotes('task-1', ['n2'])
      expect(taskQueries.setTaskNotes).toHaveBeenCalledWith(db, 'task-1', ['n2'])
    })

    it('getAllTaskTags + getTaskStats delegate', () => {
      vi.mocked(taskQueries.getAllTaskTags).mockReturnValue([{ tag: 'urgent', count: 3 }])
      expect(repo.getAllTaskTags()).toEqual([{ tag: 'urgent', count: 3 }])
      const stats = repo.getTaskStats()
      expect(stats.total).toBe(0)
    })
  })

  describe('bulk operations', () => {
    it('bulkComplete/Delete/Move/Archive return counts', () => {
      vi.mocked(taskQueries.bulkCompleteTasks).mockReturnValue(3)
      vi.mocked(taskQueries.bulkDeleteTasks).mockReturnValue(2)
      vi.mocked(taskQueries.bulkMoveTasks).mockReturnValue(4)
      vi.mocked(taskQueries.bulkArchiveTasks).mockReturnValue(1)

      expect(repo.bulkCompleteTasks(['a', 'b', 'c'])).toBe(3)
      expect(repo.bulkDeleteTasks(['a', 'b'])).toBe(2)
      expect(repo.bulkMoveTasks(['a', 'b'], 'proj-2')).toBe(4)
      expect(repo.bulkArchiveTasks(['a'])).toBe(1)
      expect(taskQueries.bulkMoveTasks).toHaveBeenCalledWith(db, ['a', 'b'], 'proj-2')
    })
  })

  describe('projects', () => {
    it('createProject delegates', () => {
      repo.createProject({
        id: 'p',
        name: 'P',
        description: null,
        color: '#000',
        icon: null,
        position: 0,
        isInbox: false
      })
      expect(projectQueries.insertProject).toHaveBeenCalledOnce()
    })

    it('updateProject / deleteProject / archiveProject delegate', () => {
      repo.updateProject('p', { name: 'X' })
      repo.deleteProject('p')
      repo.archiveProject('p')
      expect(projectQueries.updateProject).toHaveBeenCalledWith(db, 'p', { name: 'X' })
      expect(projectQueries.deleteProject).toHaveBeenCalledWith(db, 'p')
      expect(projectQueries.archiveProject).toHaveBeenCalledWith(db, 'p')
    })

    it('getProject returns project with statuses', () => {
      const p = repo.getProject('p-1')
      expect(p?.id).toBe('p-1')
      expect(p?.statuses).toHaveLength(1)
    })

    it('listProjects returns projects with stats', () => {
      const list = repo.listProjects()
      expect(list).toHaveLength(1)
      expect(list[0].taskCount).toBe(2)
    })

    it('reorderProjects / getNextProjectPosition delegate', () => {
      repo.reorderProjects(['a', 'b'], [0, 1])
      expect(projectQueries.reorderProjects).toHaveBeenCalledWith(db, ['a', 'b'], [0, 1])
      expect(repo.getNextProjectPosition()).toBe(3)
    })
  })

  describe('statuses', () => {
    it('create/list/get/update/delete delegate', () => {
      repo.createStatus({
        id: 's',
        projectId: 'p',
        name: 'Todo',
        color: '#000',
        position: 0,
        isDefault: true,
        isDone: false
      })
      expect(projectQueries.insertStatus).toHaveBeenCalled()

      expect(repo.listStatuses('p-1')).toHaveLength(1)
      expect(repo.getStatus('s-1')?.id).toBe('s-1')

      repo.updateStatus('s-1', { name: 'New' })
      expect(projectQueries.updateStatus).toHaveBeenCalledWith(db, 's-1', { name: 'New' })

      repo.deleteStatus('s-1')
      expect(projectQueries.deleteStatus).toHaveBeenCalledWith(db, 's-1')
    })

    it('reorderStatuses + getNextStatusPosition delegate', () => {
      repo.reorderStatuses(['a', 'b'], [0, 1])
      expect(projectQueries.reorderStatuses).toHaveBeenCalledWith(db, ['a', 'b'], [0, 1])
      expect(repo.getNextStatusPosition('p-1')).toBe(2)
    })

    it('createDefaultStatuses + createCustomStatuses + reconcile + equivalent delegate', () => {
      expect(repo.createDefaultStatuses('p-1')).toHaveLength(1)
      expect(
        repo.createCustomStatuses('p-1', [{ name: 'A', color: '#000', type: 'todo', order: 0 }])
      ).toHaveLength(1)
      repo.reconcileProjectStatuses('p-1', [
        { name: 'A', color: '#000', type: 'todo', order: 0 }
      ])
      expect(projectQueries.reconcileProjectStatuses).toHaveBeenCalled()

      const eq = repo.getEquivalentStatus('p-2', makeStatus({ id: 'src' }))
      expect(eq?.id).toBe('src')
    })
  })
})
