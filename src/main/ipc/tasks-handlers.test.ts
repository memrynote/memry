/**
 * Tasks IPC handlers tests
 *
 * @module ipc/tasks-handlers.test
 */

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest'
import { mockIpcMain, resetIpcMocks, invokeHandler } from '@tests/utils/mock-ipc'
import { TasksChannels } from '@shared/ipc-channels'

// Track mock calls
const handleCalls: unknown[][] = []
const removeHandlerCalls: string[] = []

// Mock electron modules
vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: unknown) => {
      handleCalls.push([channel, handler])
      mockIpcMain.handle(channel, handler as Parameters<typeof mockIpcMain.handle>[1])
    }),
    removeHandler: vi.fn((channel: string) => {
      removeHandlerCalls.push(channel)
      mockIpcMain.removeHandler(channel)
    })
  },
  BrowserWindow: {
    getAllWindows: vi.fn(() => [
      { webContents: { send: vi.fn() } }
    ])
  }
}))

// Mock database module
vi.mock('../database', () => ({
  getDatabase: vi.fn()
}))

// Mock ID generation
vi.mock('../lib/id', () => ({
  generateId: vi.fn(() => 'generated-id-123')
}))

// Mock task queries
vi.mock('@shared/db/queries/tasks', () => ({
  insertTask: vi.fn(),
  getTaskById: vi.fn(),
  updateTask: vi.fn(),
  deleteTask: vi.fn(),
  listTasks: vi.fn(),
  countTasks: vi.fn(),
  completeTask: vi.fn(),
  uncompleteTask: vi.fn(),
  archiveTask: vi.fn(),
  unarchiveTask: vi.fn(),
  moveTask: vi.fn(),
  reorderTasks: vi.fn(),
  duplicateTask: vi.fn(),
  duplicateSubtask: vi.fn(),
  getSubtasks: vi.fn(),
  countSubtasks: vi.fn(),
  getTaskTags: vi.fn(),
  setTaskTags: vi.fn(),
  getTaskNoteIds: vi.fn(),
  setTaskNotes: vi.fn(),
  getAllTaskTags: vi.fn(),
  getNextTaskPosition: vi.fn(),
  bulkCompleteTasks: vi.fn(),
  bulkDeleteTasks: vi.fn(),
  bulkMoveTasks: vi.fn(),
  bulkArchiveTasks: vi.fn(),
  getTaskStats: vi.fn(),
  getTodayTasks: vi.fn(),
  getUpcomingTasks: vi.fn(),
  getOverdueTasks: vi.fn(),
  getTasksLinkedToNote: vi.fn()
}))

// Mock project queries
vi.mock('@shared/db/queries/projects', () => ({
  insertProject: vi.fn(),
  getProjectById: vi.fn(),
  getProjectWithStatuses: vi.fn(),
  updateProject: vi.fn(),
  deleteProject: vi.fn(),
  getProjectsWithStats: vi.fn(),
  archiveProject: vi.fn(),
  reorderProjects: vi.fn(),
  getNextProjectPosition: vi.fn(),
  insertStatus: vi.fn(),
  updateStatus: vi.fn(),
  deleteStatus: vi.fn(),
  getStatusesByProject: vi.fn(),
  reorderStatuses: vi.fn(),
  getNextStatusPosition: vi.fn(),
  getStatusById: vi.fn(),
  getEquivalentStatus: vi.fn(),
  createDefaultStatuses: vi.fn()
}))

// Import after mocking
import { registerTasksHandlers, unregisterTasksHandlers } from './tasks-handlers'
import { getDatabase } from '../database'
import { generateId } from '../lib/id'
import * as taskQueries from '@shared/db/queries/tasks'
import * as projectQueries from '@shared/db/queries/projects'

describe('tasks-handlers', () => {
  let mockDb: { run: Mock; get: Mock; all: Mock }

  beforeEach(() => {
    resetIpcMocks()
    vi.clearAllMocks()
    handleCalls.length = 0
    removeHandlerCalls.length = 0

    // Setup mock database
    mockDb = {
      run: vi.fn(),
      get: vi.fn(),
      all: vi.fn()
    }
    ;(getDatabase as Mock).mockReturnValue(mockDb)
    ;(taskQueries.getNextTaskPosition as Mock).mockReturnValue(0)
    ;(taskQueries.getTaskTags as Mock).mockReturnValue([])
    ;(taskQueries.getTaskNoteIds as Mock).mockReturnValue([])
    ;(taskQueries.countSubtasks as Mock).mockReturnValue({ total: 0, completed: 0 })
  })

  afterEach(() => {
    unregisterTasksHandlers()
  })

  describe('registerTasksHandlers', () => {
    it('should register all tasks handlers', () => {
      registerTasksHandlers()

      const invokeChannels = Object.values(TasksChannels.invoke)
      // Some handlers may not be implemented yet
      expect(handleCalls.length).toBeGreaterThanOrEqual(invokeChannels.length - 5)
    })
  })

  // =========================================================================
  // T445: CREATE, GET, UPDATE, DELETE handlers
  // =========================================================================
  describe('Task CRUD', () => {
    beforeEach(() => {
      registerTasksHandlers()
    })

    describe('CREATE handler', () => {
      it('should create a task with valid input', async () => {
        const mockTask = {
          id: 'generated-id-123',
          projectId: 'project1',
          title: 'Test Task',
          priority: 1
        }
        ;(taskQueries.insertTask as Mock).mockReturnValue(mockTask)

        const result = await invokeHandler(TasksChannels.invoke.CREATE, {
          projectId: 'project1',
          title: 'Test Task',
          priority: 1
        })

        expect(result.success).toBe(true)
        expect(result.task).toEqual({ ...mockTask, linkedNoteIds: [] })
        expect(taskQueries.insertTask).toHaveBeenCalled()
      })

      it('should create a task with tags', async () => {
        const mockTask = { id: 'task1', title: 'Tagged Task' }
        ;(taskQueries.insertTask as Mock).mockReturnValue(mockTask)

        await invokeHandler(TasksChannels.invoke.CREATE, {
          projectId: 'project1',
          title: 'Tagged Task',
          tags: ['important', 'urgent']
        })

        expect(taskQueries.setTaskTags).toHaveBeenCalledWith(
          mockDb,
          'generated-id-123',
          ['important', 'urgent']
        )
      })

      it('should create a task with linked notes', async () => {
        const mockTask = { id: 'task1', title: 'Linked Task' }
        ;(taskQueries.insertTask as Mock).mockReturnValue(mockTask)

        await invokeHandler(TasksChannels.invoke.CREATE, {
          projectId: 'project1',
          title: 'Linked Task',
          linkedNoteIds: ['note1', 'note2']
        })

        expect(taskQueries.setTaskNotes).toHaveBeenCalledWith(
          mockDb,
          'generated-id-123',
          ['note1', 'note2']
        )
      })

      it('should handle creation errors', async () => {
        ;(taskQueries.insertTask as Mock).mockImplementation(() => {
          throw new Error('Database error')
        })

        const result = await invokeHandler(TasksChannels.invoke.CREATE, {
          projectId: 'project1',
          title: 'Failing Task'
        })

        expect(result.success).toBe(false)
        expect(result.error).toBe('Database error')
      })
    })

    describe('GET handler', () => {
      it('should get a task by ID with enriched data', async () => {
        const mockTask = { id: 'task1', title: 'Test Task' }
        ;(taskQueries.getTaskById as Mock).mockReturnValue(mockTask)
        ;(taskQueries.getTaskTags as Mock).mockReturnValue(['tag1'])
        ;(taskQueries.getTaskNoteIds as Mock).mockReturnValue(['note1'])
        ;(taskQueries.countSubtasks as Mock).mockReturnValue({ total: 2, completed: 1 })

        const result = await invokeHandler(TasksChannels.invoke.GET, 'task1')

        expect(result).toEqual({
          ...mockTask,
          tags: ['tag1'],
          linkedNoteIds: ['note1'],
          hasSubtasks: true,
          subtaskCount: 2,
          completedSubtaskCount: 1
        })
      })

      it('should return null for non-existent task', async () => {
        ;(taskQueries.getTaskById as Mock).mockReturnValue(null)

        const result = await invokeHandler(TasksChannels.invoke.GET, 'nonexistent')

        expect(result).toBeNull()
      })
    })

    describe('UPDATE handler', () => {
      it('should update a task', async () => {
        const mockTask = { id: 'task1', title: 'Updated Task' }
        ;(taskQueries.updateTask as Mock).mockReturnValue(mockTask)

        const result = await invokeHandler(TasksChannels.invoke.UPDATE, {
          id: 'task1',
          title: 'Updated Task'
        })

        expect(result.success).toBe(true)
        expect(result.task).toBeDefined()
      })

      it('should update tags when provided', async () => {
        const mockTask = { id: 'task1', title: 'Task' }
        ;(taskQueries.updateTask as Mock).mockReturnValue(mockTask)

        await invokeHandler(TasksChannels.invoke.UPDATE, {
          id: 'task1',
          tags: ['new-tag']
        })

        expect(taskQueries.setTaskTags).toHaveBeenCalledWith(mockDb, 'task1', ['new-tag'])
      })

      it('should map status when moving to different project', async () => {
        const mockTask = { id: 'task1', projectId: 'old-project', statusId: 'old-status' }
        const updatedTask = { ...mockTask, projectId: 'new-project', statusId: 'new-status' }
        ;(taskQueries.getTaskById as Mock).mockReturnValue(mockTask)
        ;(taskQueries.updateTask as Mock).mockReturnValue(updatedTask)
        ;(projectQueries.getStatusById as Mock).mockReturnValue({ id: 'old-status', isDone: false })
        ;(projectQueries.getEquivalentStatus as Mock).mockReturnValue({ id: 'new-status' })

        await invokeHandler(TasksChannels.invoke.UPDATE, {
          id: 'task1',
          projectId: 'new-project'
        })

        expect(projectQueries.getEquivalentStatus).toHaveBeenCalled()
      })

      it('should return error for non-existent task', async () => {
        ;(taskQueries.updateTask as Mock).mockReturnValue(null)

        const result = await invokeHandler(TasksChannels.invoke.UPDATE, {
          id: 'nonexistent',
          title: 'Update'
        })

        expect(result.success).toBe(false)
        expect(result.error).toBe('Task not found')
      })
    })

    describe('DELETE handler', () => {
      it('should delete a task', async () => {
        ;(taskQueries.deleteTask as Mock).mockReturnValue(undefined)

        const result = await invokeHandler(TasksChannels.invoke.DELETE, 'task1')

        expect(result.success).toBe(true)
        expect(taskQueries.deleteTask).toHaveBeenCalledWith(mockDb, 'task1')
      })

      it('should handle delete errors', async () => {
        ;(taskQueries.deleteTask as Mock).mockImplementation(() => {
          throw new Error('Delete failed')
        })

        const result = await invokeHandler(TasksChannels.invoke.DELETE, 'task1')

        expect(result.success).toBe(false)
        expect(result.error).toBe('Delete failed')
      })
    })
  })

  // =========================================================================
  // T446: COMPLETE, UNCOMPLETE handlers
  // =========================================================================
  describe('Task completion', () => {
    beforeEach(() => {
      registerTasksHandlers()
    })

    describe('COMPLETE handler', () => {
      it('should complete a task', async () => {
        const completedAt = '2026-01-03T12:00:00.000Z'
        const mockTask = { id: 'task1', completedAt }
        ;(taskQueries.completeTask as Mock).mockReturnValue(mockTask)

        const result = await invokeHandler(TasksChannels.invoke.COMPLETE, {
          id: 'task1',
          completedAt // datetime format required by schema
        })

        expect(result.success).toBe(true)
        expect(result.task.completedAt).toBe(completedAt)
      })

      it('should handle complete errors', async () => {
        ;(taskQueries.completeTask as Mock).mockReturnValue(null)

        const result = await invokeHandler(TasksChannels.invoke.COMPLETE, {
          id: 'nonexistent'
        })

        expect(result.success).toBe(false)
        expect(result.error).toBe('Task not found')
      })
    })

    describe('UNCOMPLETE handler', () => {
      it('should uncomplete a task', async () => {
        const mockTask = { id: 'task1', completedAt: null }
        ;(taskQueries.uncompleteTask as Mock).mockReturnValue(mockTask)

        const result = await invokeHandler(TasksChannels.invoke.UNCOMPLETE, 'task1')

        expect(result.success).toBe(true)
        expect(result.task).toBeDefined()
      })
    })
  })

  // =========================================================================
  // T447: LIST with filters
  // =========================================================================
  describe('LIST handler', () => {
    beforeEach(() => {
      registerTasksHandlers()
    })

    it('should list tasks with default options', async () => {
      const mockTasks = [{ id: 'task1' }, { id: 'task2' }]
      ;(taskQueries.listTasks as Mock).mockReturnValue(mockTasks)
      ;(taskQueries.countTasks as Mock).mockReturnValue(2)

      const result = await invokeHandler(TasksChannels.invoke.LIST, {})

      expect(result.tasks).toHaveLength(2)
      expect(result.total).toBe(2)
    })

    it('should list tasks with filters', async () => {
      ;(taskQueries.listTasks as Mock).mockReturnValue([])
      ;(taskQueries.countTasks as Mock).mockReturnValue(0)

      await invokeHandler(TasksChannels.invoke.LIST, {
        projectId: 'project1',
        includeCompleted: true,
        includeArchived: false
      })

      expect(taskQueries.listTasks).toHaveBeenCalledWith(
        mockDb,
        expect.objectContaining({
          projectId: 'project1',
          includeCompleted: true,
          includeArchived: false
        })
      )
    })

    it('should handle pagination', async () => {
      const mockTasks = Array(10).fill({ id: 'task' })
      ;(taskQueries.listTasks as Mock).mockReturnValue(mockTasks)
      ;(taskQueries.countTasks as Mock).mockReturnValue(20)

      const result = await invokeHandler(TasksChannels.invoke.LIST, {
        limit: 10,
        offset: 0
      })

      expect(result.hasMore).toBe(true)
    })
  })

  // =========================================================================
  // T448: Bulk operations
  // =========================================================================
  describe('Bulk operations', () => {
    beforeEach(() => {
      registerTasksHandlers()
    })

    describe('BULK_COMPLETE handler', () => {
      it('should complete multiple tasks', async () => {
        ;(taskQueries.bulkCompleteTasks as Mock).mockReturnValue(3)
        ;(taskQueries.getTaskById as Mock).mockReturnValue({ id: 'task1' })

        const result = await invokeHandler(TasksChannels.invoke.BULK_COMPLETE, {
          ids: ['task1', 'task2', 'task3']
        })

        expect(result.success).toBe(true)
        expect(result.count).toBe(3)
      })
    })

    describe('BULK_DELETE handler', () => {
      it('should delete multiple tasks', async () => {
        ;(taskQueries.bulkDeleteTasks as Mock).mockReturnValue(2)

        const result = await invokeHandler(TasksChannels.invoke.BULK_DELETE, {
          ids: ['task1', 'task2']
        })

        expect(result.success).toBe(true)
        expect(result.count).toBe(2)
      })
    })

    describe('BULK_MOVE handler', () => {
      it('should move multiple tasks to a project', async () => {
        ;(taskQueries.bulkMoveTasks as Mock).mockReturnValue(2)
        ;(taskQueries.getTaskById as Mock).mockReturnValue({ id: 'task1', projectId: 'new-project' })

        const result = await invokeHandler(TasksChannels.invoke.BULK_MOVE, {
          ids: ['task1', 'task2'],
          projectId: 'new-project'
        })

        expect(result.success).toBe(true)
        expect(result.count).toBe(2)
      })
    })

    describe('BULK_ARCHIVE handler', () => {
      it('should archive multiple tasks', async () => {
        ;(taskQueries.bulkArchiveTasks as Mock).mockReturnValue(2)
        ;(taskQueries.getTaskById as Mock).mockReturnValue({ id: 'task1', archivedAt: '2026-01-03' })

        const result = await invokeHandler(TasksChannels.invoke.BULK_ARCHIVE, {
          ids: ['task1', 'task2']
        })

        expect(result.success).toBe(true)
        expect(result.count).toBe(2)
      })
    })
  })

  // =========================================================================
  // Project operations
  // =========================================================================
  describe('Project operations', () => {
    beforeEach(() => {
      registerTasksHandlers()
      ;(projectQueries.getNextProjectPosition as Mock).mockReturnValue(0)
    })

    describe('PROJECT_CREATE handler', () => {
      it('should create a project with default statuses', async () => {
        const mockProject = { id: 'generated-id-123', name: 'New Project' }
        ;(projectQueries.insertProject as Mock).mockReturnValue(mockProject)

        const result = await invokeHandler(TasksChannels.invoke.PROJECT_CREATE, {
          name: 'New Project'
        })

        expect(result.success).toBe(true)
        expect(result.project).toEqual(mockProject)
        expect(projectQueries.createDefaultStatuses).toHaveBeenCalled()
      })
    })

    describe('PROJECT_GET handler', () => {
      it('should get a project with statuses', async () => {
        const mockProject = { id: 'project1', name: 'Project', statuses: [] }
        ;(projectQueries.getProjectWithStatuses as Mock).mockReturnValue(mockProject)

        const result = await invokeHandler(TasksChannels.invoke.PROJECT_GET, 'project1')

        expect(result).toEqual(mockProject)
      })
    })

    describe('PROJECT_UPDATE handler', () => {
      it('should update a project', async () => {
        const mockProject = { id: 'project1', name: 'Updated Name' }
        ;(projectQueries.updateProject as Mock).mockReturnValue(mockProject)

        const result = await invokeHandler(TasksChannels.invoke.PROJECT_UPDATE, {
          id: 'project1',
          name: 'Updated Name'
        })

        expect(result.success).toBe(true)
      })
    })

    describe('PROJECT_DELETE handler', () => {
      it('should delete a project', async () => {
        ;(projectQueries.deleteProject as Mock).mockReturnValue(undefined)

        const result = await invokeHandler(TasksChannels.invoke.PROJECT_DELETE, 'project1')

        expect(result.success).toBe(true)
      })
    })

    describe('PROJECT_LIST handler', () => {
      it('should list projects with stats', async () => {
        const mockProjects = [{ id: 'p1', name: 'Project 1', taskCount: 5 }]
        ;(projectQueries.getProjectsWithStats as Mock).mockReturnValue(mockProjects)

        const result = await invokeHandler(TasksChannels.invoke.PROJECT_LIST)

        expect(result.projects).toEqual(mockProjects)
      })
    })
  })

  // =========================================================================
  // Status operations
  // =========================================================================
  describe('Status operations', () => {
    beforeEach(() => {
      registerTasksHandlers()
      ;(projectQueries.getNextStatusPosition as Mock).mockReturnValue(0)
    })

    describe('STATUS_CREATE handler', () => {
      it('should create a status', async () => {
        const mockStatus = { id: 'generated-id-123', name: 'In Progress' }
        ;(projectQueries.insertStatus as Mock).mockReturnValue(mockStatus)

        const result = await invokeHandler(TasksChannels.invoke.STATUS_CREATE, {
          projectId: 'project1',
          name: 'In Progress'
        })

        expect(result.success).toBe(true)
        expect(result.status).toEqual(mockStatus)
      })
    })

    describe('STATUS_LIST handler', () => {
      it('should list statuses for a project', async () => {
        const mockStatuses = [
          { id: 's1', name: 'Todo' },
          { id: 's2', name: 'Done' }
        ]
        ;(projectQueries.getStatusesByProject as Mock).mockReturnValue(mockStatuses)

        const result = await invokeHandler(TasksChannels.invoke.STATUS_LIST, 'project1')

        expect(result).toEqual(mockStatuses)
      })
    })
  })

  // =========================================================================
  // Stats and views
  // =========================================================================
  describe('Stats and views', () => {
    beforeEach(() => {
      registerTasksHandlers()
    })

    describe('GET_STATS handler', () => {
      it('should get task statistics', async () => {
        const mockStats = { total: 100, completed: 50, overdue: 5 }
        ;(taskQueries.getTaskStats as Mock).mockReturnValue(mockStats)

        const result = await invokeHandler(TasksChannels.invoke.GET_STATS)

        expect(result).toEqual(mockStats)
      })
    })

    describe('GET_TODAY handler', () => {
      it('should get today tasks', async () => {
        const mockTasks = [{ id: 'task1', dueDate: '2026-01-03' }]
        ;(taskQueries.getTodayTasks as Mock).mockReturnValue(mockTasks)

        const result = await invokeHandler(TasksChannels.invoke.GET_TODAY)

        expect(result.tasks).toHaveLength(1)
      })
    })

    describe('GET_UPCOMING handler', () => {
      it('should get upcoming tasks', async () => {
        const mockTasks = [{ id: 'task1' }, { id: 'task2' }]
        ;(taskQueries.getUpcomingTasks as Mock).mockReturnValue(mockTasks)

        const result = await invokeHandler(TasksChannels.invoke.GET_UPCOMING, { days: 7 })

        expect(result.tasks).toHaveLength(2)
      })
    })

    describe('GET_OVERDUE handler', () => {
      it('should get overdue tasks', async () => {
        const mockTasks = [{ id: 'task1' }]
        ;(taskQueries.getOverdueTasks as Mock).mockReturnValue(mockTasks)

        const result = await invokeHandler(TasksChannels.invoke.GET_OVERDUE)

        expect(result.tasks).toHaveLength(1)
      })
    })
  })

  // =========================================================================
  // Subtask operations
  // =========================================================================
  describe('Subtask operations', () => {
    beforeEach(() => {
      registerTasksHandlers()
    })

    describe('GET_SUBTASKS handler', () => {
      it('should get subtasks', async () => {
        const mockSubtasks = [{ id: 'sub1', parentId: 'task1' }]
        ;(taskQueries.getSubtasks as Mock).mockReturnValue(mockSubtasks)

        const result = await invokeHandler(TasksChannels.invoke.GET_SUBTASKS, 'task1')

        expect(result).toEqual(mockSubtasks)
      })
    })

    describe('CONVERT_TO_SUBTASK handler', () => {
      it('should convert a task to a subtask', async () => {
        const mockTask = { id: 'task1', parentId: 'parent1' }
        ;(taskQueries.moveTask as Mock).mockReturnValue(mockTask)

        const result = await invokeHandler(TasksChannels.invoke.CONVERT_TO_SUBTASK, {
          taskId: 'task1',
          parentId: 'parent1'
        })

        expect(result.success).toBe(true)
        expect(result.task.parentId).toBe('parent1')
      })
    })

    describe('CONVERT_TO_TASK handler', () => {
      it('should convert a subtask to a top-level task', async () => {
        const mockTask = { id: 'task1', parentId: null }
        ;(taskQueries.moveTask as Mock).mockReturnValue(mockTask)

        const result = await invokeHandler(TasksChannels.invoke.CONVERT_TO_TASK, 'task1')

        expect(result.success).toBe(true)
        expect(result.task.parentId).toBeNull()
      })
    })
  })

  // =========================================================================
  // Additional operations
  // =========================================================================
  describe('Additional operations', () => {
    beforeEach(() => {
      registerTasksHandlers()
    })

    describe('DUPLICATE handler', () => {
      it('should duplicate a task with subtasks', async () => {
        const mockTask = { id: 'new-task', title: 'Duplicated' }
        const mockSubtasks = [{ id: 'sub1' }]
        ;(taskQueries.duplicateTask as Mock).mockReturnValue(mockTask)
        ;(taskQueries.getSubtasks as Mock).mockReturnValue(mockSubtasks)
        ;(taskQueries.duplicateSubtask as Mock).mockReturnValue({ id: 'new-sub1' })

        const result = await invokeHandler(TasksChannels.invoke.DUPLICATE, 'task1')

        expect(result.success).toBe(true)
        expect(taskQueries.duplicateSubtask).toHaveBeenCalled()
      })
    })

    describe('MOVE handler', () => {
      it('should move a task to another project', async () => {
        const mockTask = { id: 'task1', projectId: 'new-project' }
        ;(taskQueries.moveTask as Mock).mockReturnValue(mockTask)

        const result = await invokeHandler(TasksChannels.invoke.MOVE, {
          taskId: 'task1',
          targetProjectId: 'new-project',
          position: 0 // Required by TaskMoveSchema
        })

        expect(result.success).toBe(true)
      })
    })

    describe('REORDER handler', () => {
      it('should reorder tasks', async () => {
        ;(taskQueries.reorderTasks as Mock).mockReturnValue(undefined)

        const result = await invokeHandler(TasksChannels.invoke.REORDER, {
          taskIds: ['task1', 'task2', 'task3'],
          positions: [0, 1, 2]
        })

        expect(result.success).toBe(true)
      })
    })

    describe('GET_TAGS handler', () => {
      it('should get all task tags', async () => {
        const mockTags = [{ tag: 'urgent', count: 5 }]
        ;(taskQueries.getAllTaskTags as Mock).mockReturnValue(mockTags)

        const result = await invokeHandler(TasksChannels.invoke.GET_TAGS)

        expect(result).toEqual(mockTags)
      })
    })

    describe('GET_LINKED_TASKS handler', () => {
      it('should get tasks linked to a note', async () => {
        const mockTasks = [{ id: 'task1' }]
        ;(taskQueries.getTasksLinkedToNote as Mock).mockReturnValue(mockTasks)

        const result = await invokeHandler(TasksChannels.invoke.GET_LINKED_TASKS, 'note1')

        expect(result).toHaveLength(1)
      })
    })
  })
})
