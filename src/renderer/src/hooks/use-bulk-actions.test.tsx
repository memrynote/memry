/**
 * useBulkActions Hook Tests (T656)
 * Tests for bulk task operations with vault backend and local fallback.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useBulkActions } from './use-bulk-actions'
import type { Task, Priority } from '@/data/sample-tasks'
import type { Project, Status } from '@/data/tasks-data'

// ============================================================================
// Mocks
// ============================================================================

// Mock toast
vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn()
  }
}))

import { toast } from 'sonner'

// Mock useVault hook
const mockVaultStatus = { isOpen: true }
vi.mock('@/hooks/use-vault', () => ({
  useVault: () => ({ status: mockVaultStatus })
}))

// Mock tasksService
vi.mock('@/services/tasks-service', () => ({
  tasksService: {
    bulkComplete: vi.fn().mockResolvedValue({ success: true }),
    bulkMove: vi.fn().mockResolvedValue({ success: true }),
    bulkArchive: vi.fn().mockResolvedValue({ success: true }),
    bulkDelete: vi.fn().mockResolvedValue({ success: true })
  }
}))

import { tasksService } from '@/services/tasks-service'

// Mock task-utils
vi.mock('@/lib/task-utils', () => ({
  getDefaultTodoStatus: (project: Project) =>
    project.statuses.find((s) => s.type === 'todo'),
  getDefaultDoneStatus: (project: Project) =>
    project.statuses.find((s) => s.type === 'done')
}))

// ============================================================================
// Test Data Factories
// ============================================================================

const createMockStatus = (overrides: Partial<Status> = {}): Status => ({
  id: `status-${Math.random().toString(36).slice(2)}`,
  name: 'To Do',
  color: '#gray',
  type: 'todo',
  isDefault: true,
  position: 0,
  ...overrides
})

const createMockProject = (overrides: Partial<Project> = {}): Project => ({
  id: `project-${Math.random().toString(36).slice(2)}`,
  name: 'Test Project',
  icon: '📁',
  color: '#6366f1',
  position: 0,
  isArchived: false,
  statuses: [
    createMockStatus({ id: 'todo-status', name: 'To Do', type: 'todo', isDefault: true }),
    createMockStatus({ id: 'progress-status', name: 'In Progress', type: 'in_progress', isDefault: false }),
    createMockStatus({ id: 'done-status', name: 'Done', type: 'done', isDefault: false })
  ],
  ...overrides
})

const createMockTask = (overrides: Partial<Task> = {}): Task => ({
  id: `task-${Math.random().toString(36).slice(2)}`,
  title: 'Test Task',
  description: '',
  dueDate: null,
  dueTime: null,
  priority: 'none' as Priority,
  projectId: 'project-1',
  statusId: 'todo-status',
  position: 0,
  repeatConfig: null,
  completedAt: null,
  archivedAt: null,
  parentId: null,
  createdAt: new Date(),
  tags: [],
  linkedNoteIds: [],
  ...overrides
})

// ============================================================================
// Test Setup
// ============================================================================

describe('useBulkActions', () => {
  let queryClient: QueryClient
  let mockProject: Project
  let mockTasks: Task[]
  let mockOnUpdateTask: ReturnType<typeof vi.fn>
  let mockOnDeleteTask: ReturnType<typeof vi.fn>
  let mockOnComplete: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } }
    })

    mockProject = createMockProject({ id: 'project-1' })
    mockTasks = [
      createMockTask({ id: 'task-1', title: 'Task 1', projectId: 'project-1', statusId: 'todo-status' }),
      createMockTask({ id: 'task-2', title: 'Task 2', projectId: 'project-1', statusId: 'todo-status' }),
      createMockTask({ id: 'task-3', title: 'Task 3', projectId: 'project-1', statusId: 'done-status', completedAt: new Date() })
    ]

    mockOnUpdateTask = vi.fn()
    mockOnDeleteTask = vi.fn()
    mockOnComplete = vi.fn()

    // Reset vault status to open
    mockVaultStatus.isOpen = true
  })

  afterEach(() => {
    queryClient.clear()
  })

  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )

  const renderBulkActions = (selectedIds: string[] = ['task-1', 'task-2']) => {
    return renderHook(
      () =>
        useBulkActions({
          selectedIds,
          tasks: mockTasks,
          projects: [mockProject],
          onUpdateTask: mockOnUpdateTask,
          onDeleteTask: mockOnDeleteTask,
          onComplete: mockOnComplete
        }),
      { wrapper }
    )
  }

  // ==========================================================================
  // getSelectedTasks Tests
  // ==========================================================================

  describe('getSelectedTasks', () => {
    it('should return selected tasks from task list', () => {
      const { result } = renderBulkActions(['task-1', 'task-3'])

      const selectedTasks = result.current.getSelectedTasks()

      expect(selectedTasks).toHaveLength(2)
      expect(selectedTasks.map((t) => t.id)).toEqual(['task-1', 'task-3'])
    })

    it('should return empty array when no tasks selected', () => {
      const { result } = renderBulkActions([])

      const selectedTasks = result.current.getSelectedTasks()

      expect(selectedTasks).toHaveLength(0)
    })
  })

  // ==========================================================================
  // bulkComplete Tests
  // ==========================================================================

  describe('bulkComplete', () => {
    it('should filter out already completed tasks', async () => {
      const { result } = renderBulkActions(['task-1', 'task-3']) // task-3 is done

      await act(async () => {
        await result.current.bulkComplete()
      })

      // Only task-1 should be completed (task-3 is already done)
      expect(tasksService.bulkComplete).toHaveBeenCalledWith(['task-1'])
    })

    it('should show info toast when all tasks already complete', async () => {
      const { result } = renderBulkActions(['task-3']) // only completed task

      await act(async () => {
        await result.current.bulkComplete()
      })

      expect(toast.info).toHaveBeenCalledWith('All selected tasks are already complete')
      expect(tasksService.bulkComplete).not.toHaveBeenCalled()
    })

    it('should use backend when vault is open', async () => {
      mockVaultStatus.isOpen = true
      const { result } = renderBulkActions(['task-1', 'task-2'])

      await act(async () => {
        await result.current.bulkComplete()
      })

      expect(tasksService.bulkComplete).toHaveBeenCalledWith(['task-1', 'task-2'])
    })

    it('should fallback to individual updates when vault closed', async () => {
      mockVaultStatus.isOpen = false
      const { result } = renderBulkActions(['task-1', 'task-2'])

      await act(async () => {
        await result.current.bulkComplete()
      })

      expect(tasksService.bulkComplete).not.toHaveBeenCalled()
      expect(mockOnUpdateTask).toHaveBeenCalledTimes(2)
      expect(mockOnUpdateTask).toHaveBeenCalledWith(
        'task-1',
        expect.objectContaining({
          statusId: 'done-status',
          completedAt: expect.any(Date)
        })
      )
    })

    it('should show success toast with correct count', async () => {
      const { result } = renderBulkActions(['task-1', 'task-2'])

      await act(async () => {
        await result.current.bulkComplete()
      })

      expect(toast.success).toHaveBeenCalledWith(
        '2 tasks completed',
        expect.objectContaining({
          duration: 10000,
          action: expect.any(Object)
        })
      )
    })

    it('should call onComplete callback', async () => {
      const { result } = renderBulkActions(['task-1'])

      await act(async () => {
        await result.current.bulkComplete()
      })

      expect(mockOnComplete).toHaveBeenCalled()
    })

    it('should handle backend error', async () => {
      vi.mocked(tasksService.bulkComplete).mockResolvedValueOnce({
        success: false,
        error: 'Backend error'
      })

      const { result } = renderBulkActions(['task-1'])

      await act(async () => {
        await result.current.bulkComplete()
      })

      expect(toast.error).toHaveBeenCalledWith('Backend error')
    })
  })

  // ==========================================================================
  // bulkUncomplete Tests
  // ==========================================================================

  describe('bulkUncomplete', () => {
    it('should filter to only completed tasks', () => {
      const { result } = renderBulkActions(['task-1', 'task-3']) // task-1 is todo, task-3 is done

      act(() => {
        result.current.bulkUncomplete()
      })

      // Only task-3 should be uncompleted
      expect(mockOnUpdateTask).toHaveBeenCalledTimes(1)
      expect(mockOnUpdateTask).toHaveBeenCalledWith(
        'task-3',
        expect.objectContaining({
          statusId: 'todo-status',
          completedAt: null
        })
      )
    })

    it('should show info toast when no completed tasks selected', () => {
      const { result } = renderBulkActions(['task-1', 'task-2']) // both are todo

      act(() => {
        result.current.bulkUncomplete()
      })

      expect(toast.info).toHaveBeenCalledWith('No completed tasks selected')
      expect(mockOnUpdateTask).not.toHaveBeenCalled()
    })

    it('should show success toast with correct count', () => {
      const { result } = renderBulkActions(['task-3'])

      act(() => {
        result.current.bulkUncomplete()
      })

      expect(toast.success).toHaveBeenCalledWith('1 task restored')
    })
  })

  // ==========================================================================
  // bulkChangePriority Tests
  // ==========================================================================

  describe('bulkChangePriority', () => {
    it('should update priority for all selected tasks', () => {
      const { result } = renderBulkActions(['task-1', 'task-2'])

      act(() => {
        result.current.bulkChangePriority('high')
      })

      expect(mockOnUpdateTask).toHaveBeenCalledTimes(2)
      expect(mockOnUpdateTask).toHaveBeenCalledWith('task-1', { priority: 'high' })
      expect(mockOnUpdateTask).toHaveBeenCalledWith('task-2', { priority: 'high' })
    })

    it('should handle "none" priority', () => {
      const { result } = renderBulkActions(['task-1'])

      act(() => {
        result.current.bulkChangePriority('none')
      })

      expect(mockOnUpdateTask).toHaveBeenCalledWith('task-1', { priority: 'none' })
      expect(toast.success).toHaveBeenCalledWith('Priority removed for 1 task')
    })

    it('should show success toast with priority label', () => {
      const { result } = renderBulkActions(['task-1', 'task-2'])

      act(() => {
        result.current.bulkChangePriority('medium')
      })

      expect(toast.success).toHaveBeenCalledWith('Priority set to medium for 2 tasks')
    })

    it('should do nothing when no tasks selected', () => {
      const { result } = renderBulkActions([])

      act(() => {
        result.current.bulkChangePriority('high')
      })

      expect(mockOnUpdateTask).not.toHaveBeenCalled()
    })
  })

  // ==========================================================================
  // bulkChangeDueDate Tests
  // ==========================================================================

  describe('bulkChangeDueDate', () => {
    it('should set due date for all selected tasks', () => {
      const dueDate = new Date('2024-12-25')
      const { result } = renderBulkActions(['task-1', 'task-2'])

      act(() => {
        result.current.bulkChangeDueDate(dueDate)
      })

      expect(mockOnUpdateTask).toHaveBeenCalledWith('task-1', { dueDate })
      expect(mockOnUpdateTask).toHaveBeenCalledWith('task-2', { dueDate })
      expect(toast.success).toHaveBeenCalledWith('Due date set for 2 tasks')
    })

    it('should remove due date when null', () => {
      const { result } = renderBulkActions(['task-1'])

      act(() => {
        result.current.bulkChangeDueDate(null)
      })

      expect(mockOnUpdateTask).toHaveBeenCalledWith('task-1', { dueDate: null })
      expect(toast.success).toHaveBeenCalledWith('Due date removed from 1 task')
    })
  })

  // ==========================================================================
  // bulkMoveToProject Tests
  // ==========================================================================

  describe('bulkMoveToProject', () => {
    const targetProject = createMockProject({
      id: 'project-2',
      name: 'Target Project',
      statuses: [
        createMockStatus({ id: 'target-todo', name: 'To Do', type: 'todo' }),
        createMockStatus({ id: 'target-done', name: 'Done', type: 'done' })
      ]
    })

    it('should use backend when vault is open', async () => {
      mockVaultStatus.isOpen = true
      const { result } = renderHook(
        () =>
          useBulkActions({
            selectedIds: ['task-1', 'task-2'],
            tasks: mockTasks,
            projects: [mockProject, targetProject],
            onUpdateTask: mockOnUpdateTask,
            onDeleteTask: mockOnDeleteTask,
            onComplete: mockOnComplete
          }),
        { wrapper }
      )

      await act(async () => {
        await result.current.bulkMoveToProject('project-2')
      })

      expect(tasksService.bulkMove).toHaveBeenCalledWith(['task-1', 'task-2'], 'project-2')
    })

    it('should fallback to individual updates when vault closed', async () => {
      mockVaultStatus.isOpen = false
      const { result } = renderHook(
        () =>
          useBulkActions({
            selectedIds: ['task-1'],
            tasks: mockTasks,
            projects: [mockProject, targetProject],
            onUpdateTask: mockOnUpdateTask,
            onDeleteTask: mockOnDeleteTask,
            onComplete: mockOnComplete
          }),
        { wrapper }
      )

      await act(async () => {
        await result.current.bulkMoveToProject('project-2')
      })

      expect(tasksService.bulkMove).not.toHaveBeenCalled()
      expect(mockOnUpdateTask).toHaveBeenCalledWith(
        'task-1',
        expect.objectContaining({
          projectId: 'project-2',
          statusId: 'target-todo'
        })
      )
    })

    it('should find matching status type in target project', async () => {
      mockVaultStatus.isOpen = false

      // Task in progress status
      const progressTask = createMockTask({
        id: 'progress-task',
        projectId: 'project-1',
        statusId: 'progress-status'
      })

      const targetWithProgress = createMockProject({
        id: 'project-2',
        statuses: [
          createMockStatus({ id: 'target-todo', type: 'todo' }),
          createMockStatus({ id: 'target-progress', type: 'in_progress' }),
          createMockStatus({ id: 'target-done', type: 'done' })
        ]
      })

      const { result } = renderHook(
        () =>
          useBulkActions({
            selectedIds: ['progress-task'],
            tasks: [progressTask],
            projects: [mockProject, targetWithProgress],
            onUpdateTask: mockOnUpdateTask,
            onDeleteTask: mockOnDeleteTask,
            onComplete: mockOnComplete
          }),
        { wrapper }
      )

      await act(async () => {
        await result.current.bulkMoveToProject('project-2')
      })

      expect(mockOnUpdateTask).toHaveBeenCalledWith(
        'progress-task',
        expect.objectContaining({
          statusId: 'target-progress'
        })
      )
    })

    it('should show error for non-existent project', async () => {
      const { result } = renderBulkActions(['task-1'])

      await act(async () => {
        await result.current.bulkMoveToProject('non-existent')
      })

      expect(toast.error).toHaveBeenCalledWith('Project not found')
    })

    it('should show success toast with project name', async () => {
      const { result } = renderHook(
        () =>
          useBulkActions({
            selectedIds: ['task-1'],
            tasks: mockTasks,
            projects: [mockProject, targetProject],
            onUpdateTask: mockOnUpdateTask,
            onDeleteTask: mockOnDeleteTask,
            onComplete: mockOnComplete
          }),
        { wrapper }
      )

      await act(async () => {
        await result.current.bulkMoveToProject('project-2')
      })

      expect(toast.success).toHaveBeenCalledWith('1 task moved to Target Project')
    })
  })

  // ==========================================================================
  // bulkChangeStatus Tests
  // ==========================================================================

  describe('bulkChangeStatus', () => {
    it('should update status for all selected tasks', () => {
      const { result } = renderBulkActions(['task-1', 'task-2'])

      act(() => {
        result.current.bulkChangeStatus('progress-status')
      })

      expect(mockOnUpdateTask).toHaveBeenCalledWith('task-1', { statusId: 'progress-status' })
      expect(mockOnUpdateTask).toHaveBeenCalledWith('task-2', { statusId: 'progress-status' })
    })

    it('should set completedAt when moving to done status', () => {
      const { result } = renderBulkActions(['task-1'])

      act(() => {
        result.current.bulkChangeStatus('done-status')
      })

      expect(mockOnUpdateTask).toHaveBeenCalledWith(
        'task-1',
        expect.objectContaining({
          statusId: 'done-status',
          completedAt: expect.any(Date)
        })
      )
    })

    it('should clear completedAt when moving from done status', () => {
      const { result } = renderBulkActions(['task-3']) // task-3 is done

      act(() => {
        result.current.bulkChangeStatus('todo-status')
      })

      expect(mockOnUpdateTask).toHaveBeenCalledWith(
        'task-3',
        expect.objectContaining({
          statusId: 'todo-status',
          completedAt: null
        })
      )
    })

    it('should show success toast with status name', () => {
      const { result } = renderBulkActions(['task-1', 'task-2'])

      act(() => {
        result.current.bulkChangeStatus('progress-status')
      })

      expect(toast.success).toHaveBeenCalledWith('2 tasks moved to In Progress')
    })
  })

  // ==========================================================================
  // bulkArchive Tests
  // ==========================================================================

  describe('bulkArchive', () => {
    it('should use backend when vault is open', async () => {
      mockVaultStatus.isOpen = true
      const { result } = renderBulkActions(['task-1', 'task-2'])

      await act(async () => {
        await result.current.bulkArchive()
      })

      expect(tasksService.bulkArchive).toHaveBeenCalledWith(['task-1', 'task-2'])
    })

    it('should fallback to individual updates when vault closed', async () => {
      mockVaultStatus.isOpen = false
      const { result } = renderBulkActions(['task-1'])

      await act(async () => {
        await result.current.bulkArchive()
      })

      expect(tasksService.bulkArchive).not.toHaveBeenCalled()
      expect(mockOnUpdateTask).toHaveBeenCalledWith(
        'task-1',
        expect.objectContaining({
          archivedAt: expect.any(Date)
        })
      )
    })

    it('should show success toast with undo action', async () => {
      const { result } = renderBulkActions(['task-1', 'task-2'])

      await act(async () => {
        await result.current.bulkArchive()
      })

      expect(toast.success).toHaveBeenCalledWith(
        '2 tasks archived',
        expect.objectContaining({
          duration: 10000,
          action: expect.objectContaining({
            label: 'Undo'
          })
        })
      )
    })
  })

  // ==========================================================================
  // bulkDelete Tests
  // ==========================================================================

  describe('bulkDelete', () => {
    it('should use backend when vault is open', async () => {
      mockVaultStatus.isOpen = true
      const { result } = renderBulkActions(['task-1', 'task-2'])

      await act(async () => {
        await result.current.bulkDelete()
      })

      expect(tasksService.bulkDelete).toHaveBeenCalledWith(['task-1', 'task-2'])
    })

    it('should fallback to individual deletes when vault closed', async () => {
      mockVaultStatus.isOpen = false
      const { result } = renderBulkActions(['task-1', 'task-2'])

      await act(async () => {
        await result.current.bulkDelete()
      })

      expect(tasksService.bulkDelete).not.toHaveBeenCalled()
      expect(mockOnDeleteTask).toHaveBeenCalledWith('task-1')
      expect(mockOnDeleteTask).toHaveBeenCalledWith('task-2')
    })

    it('should show success toast', async () => {
      const { result } = renderBulkActions(['task-1'])

      await act(async () => {
        await result.current.bulkDelete()
      })

      expect(toast.success).toHaveBeenCalledWith(
        '1 task deleted',
        expect.objectContaining({
          description: 'This action can be undone for a short time.'
        })
      )
    })

    it('should handle backend error', async () => {
      vi.mocked(tasksService.bulkDelete).mockResolvedValueOnce({
        success: false,
        error: 'Delete failed'
      })

      const { result } = renderBulkActions(['task-1'])

      await act(async () => {
        await result.current.bulkDelete()
      })

      expect(toast.error).toHaveBeenCalledWith('Delete failed')
    })

    it('should do nothing when no tasks selected', async () => {
      const { result } = renderBulkActions([])

      await act(async () => {
        await result.current.bulkDelete()
      })

      expect(tasksService.bulkDelete).not.toHaveBeenCalled()
      expect(mockOnDeleteTask).not.toHaveBeenCalled()
    })
  })
})
