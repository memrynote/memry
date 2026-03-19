import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useUndoableTaskActions, UNDOABLE_FIELDS } from './use-undoable-task-actions'
import type { Task, Priority } from '@/data/sample-tasks'

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn()
  }
}))

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn()
  })
}))

import { toast } from 'sonner'

// ============================================================================
// FACTORIES
// ============================================================================

const makeTask = (overrides: Partial<Task> = {}): Task => ({
  id: 'task-1',
  title: 'Test task',
  description: '',
  projectId: 'proj-1',
  statusId: 'status-todo',
  priority: 'none' as Priority,
  dueDate: null,
  dueTime: null,
  isRepeating: false,
  repeatConfig: null,
  linkedNoteIds: [],
  sourceNoteId: null,
  parentId: null,
  subtaskIds: [],
  createdAt: new Date('2026-01-01'),
  completedAt: null,
  archivedAt: null,
  ...overrides
})

const makeSubtask = (parentId: string, overrides: Partial<Task> = {}): Task =>
  makeTask({
    id: `subtask-${Math.random().toString(36).slice(2, 7)}`,
    parentId,
    title: 'Subtask',
    ...overrides
  })

// ============================================================================
// SETUP
// ============================================================================

function setup(taskOverrides: Partial<Task>[] = [{}]) {
  const tasks = taskOverrides.map((o) => makeTask(o))

  const deps = {
    tasks,
    addTask: vi.fn(),
    updateTask: vi.fn(),
    deleteTask: vi.fn(),
    registerUndo: vi.fn().mockReturnValue('undo-123'),
    removeUndoEntry: vi.fn(),
    projects: [
      {
        id: 'proj-1',
        name: 'Project',
        color: '#000',
        isArchived: false,
        statuses: [
          { id: 'status-todo', name: 'To Do', type: 'todo' as const, position: 0, isDefault: true },
          {
            id: 'status-progress',
            name: 'In Progress',
            type: 'in_progress' as const,
            position: 1,
            isDefault: false
          },
          { id: 'status-done', name: 'Done', type: 'done' as const, position: 2, isDefault: true }
        ]
      }
    ]
  }

  const { result } = renderHook(() => useUndoableTaskActions(deps))
  return { result, deps }
}

// ============================================================================
// TESTS
// ============================================================================

describe('useUndoableTaskActions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // ---------- createTask ----------

  describe('createTask', () => {
    it('should call addTask with the task', () => {
      const { result, deps } = setup()
      const task = makeTask({ id: 'new-task', title: 'New' })

      act(() => {
        result.current.createTask(task)
      })

      expect(deps.addTask).toHaveBeenCalledWith(task)
    })

    it('should register undo after creating', () => {
      const { result, deps } = setup()
      const task = makeTask({ id: 'new-task', title: 'New' })

      act(() => {
        result.current.createTask(task)
      })

      expect(deps.registerUndo).toHaveBeenCalledWith(
        expect.stringContaining('New'),
        expect.any(Function)
      )
    })

    it('should undo by deleting the created task', () => {
      const { result, deps } = setup()
      const task = makeTask({ id: 'new-task', title: 'New' })

      act(() => {
        result.current.createTask(task)
      })

      // #when — execute the registered undo function
      const undoFn = deps.registerUndo.mock.calls[0][1]
      undoFn()

      expect(deps.deleteTask).toHaveBeenCalledWith('new-task')
    })
  })

  // ---------- deleteTask ----------

  describe('deleteTask', () => {
    it('should capture full task snapshot before delete', () => {
      const task = makeTask({ id: 'task-1', title: 'Delete me', priority: 'high' })
      const { result, deps } = setup([{ id: 'task-1', title: 'Delete me', priority: 'high' }])

      act(() => {
        result.current.deleteTask('task-1')
      })

      expect(deps.deleteTask).toHaveBeenCalledWith('task-1')
    })

    it('should register undo that re-creates the task', () => {
      const { result, deps } = setup([{ id: 'task-1', title: 'Delete me' }])

      act(() => {
        result.current.deleteTask('task-1')
      })

      expect(deps.registerUndo).toHaveBeenCalledWith(
        expect.stringContaining('Delete me'),
        expect.any(Function)
      )

      // #when — execute undo
      const undoFn = deps.registerUndo.mock.calls[0][1]
      undoFn()

      expect(deps.addTask).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'task-1', title: 'Delete me' })
      )
    })

    it('should show toast with undo button', () => {
      const { result } = setup([{ id: 'task-1', title: 'Gone' }])

      act(() => {
        result.current.deleteTask('task-1')
      })

      expect(toast.success).toHaveBeenCalledWith(
        'Task deleted',
        expect.objectContaining({
          duration: 10000,
          action: expect.objectContaining({ label: 'Undo' })
        })
      )
    })

    it('should remove undo entry from stack when toast undo clicked (double-fire prevention)', () => {
      const { result, deps } = setup([{ id: 'task-1', title: 'Gone' }])

      act(() => {
        result.current.deleteTask('task-1')
      })

      // #when — simulate toast undo button click
      const toastCall = (toast.success as ReturnType<typeof vi.fn>).mock.calls[0]
      const toastOptions = toastCall[1]
      toastOptions.action.onClick()

      expect(deps.removeUndoEntry).toHaveBeenCalledWith('undo-123')
    })

    it('should be a no-op for non-existent task', () => {
      const { result, deps } = setup()

      act(() => {
        result.current.deleteTask('non-existent')
      })

      expect(deps.deleteTask).not.toHaveBeenCalled()
      expect(deps.registerUndo).not.toHaveBeenCalled()
    })
  })

  // ---------- completeTask ----------

  describe('completeTask', () => {
    it('should mark task as done with correct status', () => {
      const { result, deps } = setup([{ id: 'task-1', statusId: 'status-todo' }])

      act(() => {
        result.current.completeTask('task-1')
      })

      expect(deps.updateTask).toHaveBeenCalledWith(
        'task-1',
        expect.objectContaining({
          statusId: 'status-done',
          completedAt: expect.any(Date)
        })
      )
    })

    it('should register undo that restores previous status', () => {
      const { result, deps } = setup([{ id: 'task-1', statusId: 'status-progress' }])

      act(() => {
        result.current.completeTask('task-1')
      })

      expect(deps.registerUndo).toHaveBeenCalledWith(
        expect.stringContaining('Test task'),
        expect.any(Function)
      )

      // #when — undo
      const undoFn = deps.registerUndo.mock.calls[0][1]
      undoFn()

      expect(deps.updateTask).toHaveBeenCalledWith(
        'task-1',
        expect.objectContaining({
          statusId: 'status-progress',
          completedAt: null
        })
      )
    })

    it('should complete subtasks when parent completed', () => {
      const sub1 = makeSubtask('task-1', { id: 'sub-1', statusId: 'status-todo' })
      const sub2 = makeSubtask('task-1', {
        id: 'sub-2',
        statusId: 'status-done',
        completedAt: new Date()
      })
      const parent = makeTask({
        id: 'task-1',
        subtaskIds: ['sub-1', 'sub-2'],
        statusId: 'status-todo'
      })

      const deps = {
        tasks: [parent, sub1, sub2],
        addTask: vi.fn(),
        updateTask: vi.fn(),
        deleteTask: vi.fn(),
        registerUndo: vi.fn().mockReturnValue('undo-456'),
        removeUndoEntry: vi.fn(),
        projects: [
          {
            id: 'proj-1',
            name: 'Project',
            color: '#000',
            isArchived: false,
            statuses: [
              {
                id: 'status-todo',
                name: 'To Do',
                type: 'todo' as const,
                position: 0,
                isDefault: true
              },
              {
                id: 'status-done',
                name: 'Done',
                type: 'done' as const,
                position: 2,
                isDefault: true
              }
            ]
          }
        ]
      }

      const { result } = renderHook(() => useUndoableTaskActions(deps))

      act(() => {
        result.current.completeTask('task-1')
      })

      // sub-1 (incomplete) should be completed; sub-2 (already done) should not be touched
      const sub1Update = deps.updateTask.mock.calls.find(([id]: [string]) => id === 'sub-1')
      expect(sub1Update).toBeDefined()
      expect(sub1Update![1]).toMatchObject({ statusId: 'status-done' })
    })

    it('should undo restoring subtask states', () => {
      const sub1 = makeSubtask('task-1', { id: 'sub-1', statusId: 'status-todo' })
      const parent = makeTask({
        id: 'task-1',
        subtaskIds: ['sub-1'],
        statusId: 'status-progress'
      })

      const deps = {
        tasks: [parent, sub1],
        addTask: vi.fn(),
        updateTask: vi.fn(),
        deleteTask: vi.fn(),
        registerUndo: vi.fn().mockReturnValue('undo-789'),
        removeUndoEntry: vi.fn(),
        projects: [
          {
            id: 'proj-1',
            name: 'Project',
            color: '#000',
            isArchived: false,
            statuses: [
              {
                id: 'status-todo',
                name: 'To Do',
                type: 'todo' as const,
                position: 0,
                isDefault: true
              },
              {
                id: 'status-progress',
                name: 'In Progress',
                type: 'in_progress' as const,
                position: 1,
                isDefault: false
              },
              {
                id: 'status-done',
                name: 'Done',
                type: 'done' as const,
                position: 2,
                isDefault: true
              }
            ]
          }
        ]
      }

      const { result } = renderHook(() => useUndoableTaskActions(deps))

      act(() => {
        result.current.completeTask('task-1')
      })

      // #when — undo
      deps.updateTask.mockClear()
      const undoFn = deps.registerUndo.mock.calls[0][1]
      undoFn()

      // parent restored
      const parentRestore = deps.updateTask.mock.calls.find(([id]: [string]) => id === 'task-1')
      expect(parentRestore![1]).toMatchObject({ statusId: 'status-progress', completedAt: null })

      // subtask restored
      const sub1Restore = deps.updateTask.mock.calls.find(([id]: [string]) => id === 'sub-1')
      expect(sub1Restore![1]).toMatchObject({ statusId: 'status-todo', completedAt: null })
    })
  })

  // ---------- completeTask (repeating) ----------

  describe('completeTask - repeating', () => {
    const makeRepeatingTask = (): Task =>
      makeTask({
        id: 'repeat-1',
        title: 'Recurring',
        isRepeating: true,
        dueDate: new Date('2026-03-01'),
        repeatConfig: {
          frequency: 'daily',
          interval: 1,
          endType: 'never',
          completedCount: 0,
          createdAt: new Date('2026-01-01')
        }
      })

    it('should mark original as done and non-repeating', () => {
      const task = makeRepeatingTask()
      const deps = {
        tasks: [task],
        addTask: vi.fn(),
        updateTask: vi.fn(),
        deleteTask: vi.fn(),
        registerUndo: vi.fn().mockReturnValue('undo-r1'),
        removeUndoEntry: vi.fn(),
        projects: [
          {
            id: 'proj-1',
            name: 'Project',
            color: '#000',
            isArchived: false,
            statuses: [
              {
                id: 'status-todo',
                name: 'To Do',
                type: 'todo' as const,
                position: 0,
                isDefault: true
              },
              {
                id: 'status-done',
                name: 'Done',
                type: 'done' as const,
                position: 2,
                isDefault: true
              }
            ]
          }
        ]
      }

      const { result } = renderHook(() => useUndoableTaskActions(deps))

      act(() => {
        result.current.completeTask('repeat-1')
      })

      expect(deps.updateTask).toHaveBeenCalledWith(
        'repeat-1',
        expect.objectContaining({
          statusId: 'status-done',
          isRepeating: false,
          repeatConfig: null
        })
      )
    })

    it('should create next occurrence', () => {
      const task = makeRepeatingTask()
      const deps = {
        tasks: [task],
        addTask: vi.fn(),
        updateTask: vi.fn(),
        deleteTask: vi.fn(),
        registerUndo: vi.fn().mockReturnValue('undo-r2'),
        removeUndoEntry: vi.fn(),
        projects: [
          {
            id: 'proj-1',
            name: 'Project',
            color: '#000',
            isArchived: false,
            statuses: [
              {
                id: 'status-todo',
                name: 'To Do',
                type: 'todo' as const,
                position: 0,
                isDefault: true
              },
              {
                id: 'status-done',
                name: 'Done',
                type: 'done' as const,
                position: 2,
                isDefault: true
              }
            ]
          }
        ]
      }

      const { result } = renderHook(() => useUndoableTaskActions(deps))

      act(() => {
        result.current.completeTask('repeat-1')
      })

      expect(deps.addTask).toHaveBeenCalledWith(
        expect.objectContaining({
          isRepeating: true,
          completedAt: null
        })
      )
    })

    it('should undo by restoring original repeat config and deleting next occurrence', () => {
      const task = makeRepeatingTask()
      const deps = {
        tasks: [task],
        addTask: vi.fn(),
        updateTask: vi.fn(),
        deleteTask: vi.fn(),
        registerUndo: vi.fn().mockReturnValue('undo-r3'),
        removeUndoEntry: vi.fn(),
        projects: [
          {
            id: 'proj-1',
            name: 'Project',
            color: '#000',
            isArchived: false,
            statuses: [
              {
                id: 'status-todo',
                name: 'To Do',
                type: 'todo' as const,
                position: 0,
                isDefault: true
              },
              {
                id: 'status-done',
                name: 'Done',
                type: 'done' as const,
                position: 2,
                isDefault: true
              }
            ]
          }
        ]
      }

      const { result } = renderHook(() => useUndoableTaskActions(deps))

      act(() => {
        result.current.completeTask('repeat-1')
      })

      // Capture next occurrence ID
      const nextTask = deps.addTask.mock.calls[0][0]
      const nextId = nextTask.id

      // #when — undo
      deps.updateTask.mockClear()
      deps.deleteTask.mockClear()
      const undoFn = deps.registerUndo.mock.calls[0][1]
      undoFn()

      // Original restored with repeat config
      expect(deps.updateTask).toHaveBeenCalledWith(
        'repeat-1',
        expect.objectContaining({
          isRepeating: true,
          repeatConfig: expect.objectContaining({ frequency: 'daily' })
        })
      )

      // Next occurrence deleted
      expect(deps.deleteTask).toHaveBeenCalledWith(nextId)
    })
  })

  // ---------- uncompleteTask ----------

  describe('uncompleteTask', () => {
    it('should move to todo status', () => {
      const { result, deps } = setup([
        {
          id: 'task-1',
          statusId: 'status-done',
          completedAt: new Date('2026-03-01')
        }
      ])

      act(() => {
        result.current.uncompleteTask('task-1')
      })

      expect(deps.updateTask).toHaveBeenCalledWith(
        'task-1',
        expect.objectContaining({
          statusId: 'status-todo',
          completedAt: null
        })
      )
    })

    it('should register undo that re-completes', () => {
      const completedAt = new Date('2026-03-01')
      const { result, deps } = setup([{ id: 'task-1', statusId: 'status-done', completedAt }])

      act(() => {
        result.current.uncompleteTask('task-1')
      })

      // #when — undo
      const undoFn = deps.registerUndo.mock.calls[0][1]
      undoFn()

      expect(deps.updateTask).toHaveBeenCalledWith(
        'task-1',
        expect.objectContaining({
          statusId: 'status-done',
          completedAt
        })
      )
    })
  })

  // ---------- archiveTask ----------

  describe('archiveTask', () => {
    it('should set archivedAt', () => {
      const { result, deps } = setup([{ id: 'task-1' }])

      act(() => {
        result.current.archiveTask('task-1')
      })

      expect(deps.updateTask).toHaveBeenCalledWith(
        'task-1',
        expect.objectContaining({ archivedAt: expect.any(Date) })
      )
    })

    it('should register undo that unarchives', () => {
      const { result, deps } = setup([{ id: 'task-1' }])

      act(() => {
        result.current.archiveTask('task-1')
      })

      const undoFn = deps.registerUndo.mock.calls[0][1]
      undoFn()

      expect(deps.updateTask).toHaveBeenCalledWith(
        'task-1',
        expect.objectContaining({ archivedAt: null })
      )
    })
  })

  // ---------- updateTaskWithUndo ----------

  describe('updateTaskWithUndo', () => {
    it('should register undo for priority change', () => {
      const { result, deps } = setup([{ id: 'task-1', priority: 'none' }])

      act(() => {
        result.current.updateTaskWithUndo('task-1', { priority: 'high' })
      })

      expect(deps.updateTask).toHaveBeenCalledWith('task-1', { priority: 'high' })
      expect(deps.registerUndo).toHaveBeenCalled()
    })

    it('should register undo for status change', () => {
      const { result, deps } = setup([{ id: 'task-1', statusId: 'status-todo' }])

      act(() => {
        result.current.updateTaskWithUndo('task-1', { statusId: 'status-progress' })
      })

      expect(deps.registerUndo).toHaveBeenCalled()
    })

    it('should register undo for due date change', () => {
      const { result, deps } = setup([{ id: 'task-1', dueDate: null }])

      act(() => {
        result.current.updateTaskWithUndo('task-1', { dueDate: new Date('2026-04-01') })
      })

      expect(deps.registerUndo).toHaveBeenCalled()
    })

    it('should register undo for project change', () => {
      const { result, deps } = setup([{ id: 'task-1', projectId: 'proj-1' }])

      act(() => {
        result.current.updateTaskWithUndo('task-1', { projectId: 'proj-2' })
      })

      expect(deps.registerUndo).toHaveBeenCalled()
    })

    it('should NOT register undo for title change', () => {
      const { result, deps } = setup([{ id: 'task-1', title: 'Old' }])

      act(() => {
        result.current.updateTaskWithUndo('task-1', { title: 'New' })
      })

      expect(deps.updateTask).toHaveBeenCalledWith('task-1', { title: 'New' })
      expect(deps.registerUndo).not.toHaveBeenCalled()
    })

    it('should NOT register undo for description change', () => {
      const { result, deps } = setup([{ id: 'task-1', description: '' }])

      act(() => {
        result.current.updateTaskWithUndo('task-1', { description: 'Updated' })
      })

      expect(deps.registerUndo).not.toHaveBeenCalled()
    })

    it('should restore previous field value on undo', () => {
      const { result, deps } = setup([{ id: 'task-1', priority: 'low' }])

      act(() => {
        result.current.updateTaskWithUndo('task-1', { priority: 'urgent' })
      })

      // #when — undo
      deps.updateTask.mockClear()
      const undoFn = deps.registerUndo.mock.calls[0][1]
      undoFn()

      expect(deps.updateTask).toHaveBeenCalledWith(
        'task-1',
        expect.objectContaining({ priority: 'low' })
      )
    })

    it('should handle mixed undoable and non-undoable fields', () => {
      const { result, deps } = setup([{ id: 'task-1', title: 'Old', priority: 'none' }])

      act(() => {
        result.current.updateTaskWithUndo('task-1', { title: 'New', priority: 'high' })
      })

      // should update both fields
      expect(deps.updateTask).toHaveBeenCalledWith('task-1', { title: 'New', priority: 'high' })
      // should register undo because priority is undoable
      expect(deps.registerUndo).toHaveBeenCalled()
    })
  })

  // ---------- UNDOABLE_FIELDS constant ----------

  describe('UNDOABLE_FIELDS', () => {
    it('should include discrete fields only', () => {
      expect(UNDOABLE_FIELDS).toContain('priority')
      expect(UNDOABLE_FIELDS).toContain('statusId')
      expect(UNDOABLE_FIELDS).toContain('dueDate')
      expect(UNDOABLE_FIELDS).toContain('dueTime')
      expect(UNDOABLE_FIELDS).toContain('projectId')
      expect(UNDOABLE_FIELDS).toContain('archivedAt')
    })

    it('should not include text fields', () => {
      expect(UNDOABLE_FIELDS).not.toContain('title')
      expect(UNDOABLE_FIELDS).not.toContain('description')
    })
  })
})
