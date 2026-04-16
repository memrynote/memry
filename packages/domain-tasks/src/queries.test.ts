import { describe, expect, it, vi } from 'vitest'
import { createTasksQueries, type TasksQueryRepository } from './queries.ts'
import type { Task, TaskListItem } from './types.ts'

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    projectId: 'project-1',
    statusId: 'status-1',
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
    createdAt: '2026-04-16T10:00:00.000Z',
    modifiedAt: '2026-04-16T10:00:00.000Z',
    ...overrides
  }
}

function createListItem(overrides: Partial<TaskListItem> = {}): TaskListItem {
  return {
    ...createTask(),
    tags: [],
    hasSubtasks: false,
    subtaskCount: 0,
    completedSubtaskCount: 0,
    linkedNoteIds: [],
    ...overrides
  }
}

function createRepository(overrides: Partial<TasksQueryRepository> = {}): TasksQueryRepository {
  return {
    getTask: vi.fn(() => undefined),
    listTasks: vi.fn(() => []),
    countTasks: vi.fn(() => 0),
    getSubtasks: vi.fn(() => []),
    listProjects: vi.fn(() => []),
    getProject: vi.fn(() => undefined),
    listStatuses: vi.fn(() => []),
    getAllTaskTags: vi.fn(() => []),
    getTaskStats: vi.fn(() => ({
      total: 0,
      completed: 0,
      overdue: 0,
      dueToday: 0,
      dueThisWeek: 0
    })),
    getTodayTasks: vi.fn(() => []),
    getUpcomingTasks: vi.fn(() => []),
    getOverdueTasks: vi.fn(() => []),
    getTasksLinkedToNote: vi.fn(() => []),
    ...overrides
  }
}

describe('createTasksQueries', () => {
  describe('getTask', () => {
    it('returns the task when repository finds it', () => {
      // #given
      const task = createTask()
      const repo = createRepository({ getTask: vi.fn(() => task) })
      const queries = createTasksQueries(repo)

      // #when
      const result = queries.getTask('task-1')

      // #then
      expect(result).toBe(task)
      expect(repo.getTask).toHaveBeenCalledWith('task-1')
    })

    it('returns null when repository returns undefined', () => {
      const queries = createTasksQueries(createRepository())
      expect(queries.getTask('missing')).toBeNull()
    })
  })

  describe('listTasks', () => {
    it('returns tasks with total and hasMore=false when everything fits', () => {
      const tasks = [createListItem()]
      const repo = createRepository({
        listTasks: vi.fn(() => tasks),
        countTasks: vi.fn(() => 1)
      })
      const queries = createTasksQueries(repo)

      const result = queries.listTasks()

      expect(result).toEqual({ tasks, total: 1, hasMore: false })
      expect(repo.listTasks).toHaveBeenCalledWith({})
    })

    it('reports hasMore=true when offset + page size < total', () => {
      const tasks = [createListItem(), createListItem({ id: 'task-2' })]
      const repo = createRepository({
        listTasks: vi.fn(() => tasks),
        countTasks: vi.fn(() => 10)
      })
      const queries = createTasksQueries(repo)

      const result = queries.listTasks({ offset: 0, limit: 2 })

      expect(result.hasMore).toBe(true)
      expect(result.total).toBe(10)
    })

    it('forwards filter options to repository and uses offset default of 0', () => {
      const repo = createRepository({
        listTasks: vi.fn(() => []),
        countTasks: vi.fn(() => 0)
      })
      const queries = createTasksQueries(repo)

      const opts = { projectId: 'p1', includeCompleted: true, includeArchived: false }
      queries.listTasks(opts)

      expect(repo.listTasks).toHaveBeenCalledWith(opts)
      expect(repo.countTasks).toHaveBeenCalledWith({
        projectId: 'p1',
        includeCompleted: true,
        includeArchived: false
      })
    })

    it('does not mutate the caller-provided options object', () => {
      const repo = createRepository()
      const queries = createTasksQueries(repo)
      const options = Object.freeze({ projectId: 'p1' })

      expect(() => queries.listTasks(options)).not.toThrow()
    })
  })

  describe('getSubtasks', () => {
    it('delegates to repository.getSubtasks', () => {
      const subs = [createTask({ id: 'sub-1', parentId: 'task-1' })]
      const repo = createRepository({ getSubtasks: vi.fn(() => subs) })
      const queries = createTasksQueries(repo)

      expect(queries.getSubtasks('task-1')).toBe(subs)
      expect(repo.getSubtasks).toHaveBeenCalledWith('task-1')
    })
  })

  describe('getProject', () => {
    it('delegates to repository.getProject', () => {
      const project = {
        id: 'p1',
        name: 'Project',
        description: null,
        color: '#000',
        icon: null,
        position: 0,
        isInbox: false,
        createdAt: 'now',
        modifiedAt: 'now',
        archivedAt: null,
        statuses: []
      }
      const repo = createRepository({ getProject: vi.fn(() => project) })
      const queries = createTasksQueries(repo)

      expect(queries.getProject('p1')).toBe(project)
      expect(repo.getProject).toHaveBeenCalledWith('p1')
    })
  })

  describe('listProjects', () => {
    it('wraps repository result in a projects envelope', () => {
      const repo = createRepository({
        listProjects: vi.fn(() => [
          {
            id: 'p1',
            name: 'Project',
            description: null,
            color: '#000',
            icon: null,
            position: 0,
            isInbox: true,
            createdAt: 'now',
            modifiedAt: 'now',
            archivedAt: null,
            taskCount: 0,
            completedCount: 0,
            overdueCount: 0
          }
        ])
      })
      const queries = createTasksQueries(repo)

      const result = queries.listProjects()

      expect(result.projects).toHaveLength(1)
      expect(result.projects[0].id).toBe('p1')
    })
  })

  describe('listStatuses', () => {
    it('delegates to repository.listStatuses', () => {
      const statuses = [
        {
          id: 's1',
          projectId: 'p1',
          name: 'Todo',
          color: '#ccc',
          position: 0,
          isDefault: true,
          isDone: false,
          createdAt: 'now'
        }
      ]
      const repo = createRepository({ listStatuses: vi.fn(() => statuses) })
      const queries = createTasksQueries(repo)

      expect(queries.listStatuses('p1')).toBe(statuses)
      expect(repo.listStatuses).toHaveBeenCalledWith('p1')
    })
  })

  describe('getTags', () => {
    it('delegates to repository.getAllTaskTags', () => {
      const tags = [{ tag: 'urgent', count: 3 }]
      const repo = createRepository({ getAllTaskTags: vi.fn(() => tags) })
      const queries = createTasksQueries(repo)

      expect(queries.getTags()).toBe(tags)
    })
  })

  describe('getStats', () => {
    it('delegates to repository.getTaskStats', () => {
      const stats = { total: 5, completed: 2, overdue: 1, dueToday: 1, dueThisWeek: 3 }
      const repo = createRepository({ getTaskStats: vi.fn(() => stats) })
      const queries = createTasksQueries(repo)

      expect(queries.getStats()).toBe(stats)
    })
  })

  describe('getToday / getUpcoming / getOverdue', () => {
    it('wraps today tasks into an envelope with total=tasks.length and hasMore=false', () => {
      const tasks = [createTask(), createTask({ id: 'task-2' })]
      const repo = createRepository({ getTodayTasks: vi.fn(() => tasks) })
      const queries = createTasksQueries(repo)

      expect(queries.getToday()).toEqual({ tasks, total: 2, hasMore: false })
    })

    it('forwards days parameter to getUpcomingTasks', () => {
      const repo = createRepository({ getUpcomingTasks: vi.fn(() => []) })
      const queries = createTasksQueries(repo)

      queries.getUpcoming(14)

      expect(repo.getUpcomingTasks).toHaveBeenCalledWith(14)
    })

    it('omits days argument when not provided', () => {
      const repo = createRepository({ getUpcomingTasks: vi.fn(() => []) })
      const queries = createTasksQueries(repo)

      queries.getUpcoming()

      expect(repo.getUpcomingTasks).toHaveBeenCalledWith(undefined)
    })

    it('wraps overdue tasks into an envelope', () => {
      const tasks = [createTask()]
      const repo = createRepository({ getOverdueTasks: vi.fn(() => tasks) })
      const queries = createTasksQueries(repo)

      expect(queries.getOverdue()).toEqual({ tasks, total: 1, hasMore: false })
    })
  })

  describe('getLinkedTasks', () => {
    it('delegates to repository.getTasksLinkedToNote', () => {
      const tasks = [createTask()]
      const repo = createRepository({ getTasksLinkedToNote: vi.fn(() => tasks) })
      const queries = createTasksQueries(repo)

      expect(queries.getLinkedTasks('note-1')).toBe(tasks)
      expect(repo.getTasksLinkedToNote).toHaveBeenCalledWith('note-1')
    })
  })

  describe('error propagation', () => {
    it('bubbles repository errors to the caller', () => {
      const repo = createRepository({
        getTask: vi.fn(() => {
          throw new Error('db unavailable')
        })
      })
      const queries = createTasksQueries(repo)

      expect(() => queries.getTask('task-1')).toThrow('db unavailable')
    })
  })
})
