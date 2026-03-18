import type React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'

import { TaskDragOverlay } from './task-drag-overlay'
import type { Task, Priority } from '@/data/sample-tasks'
import type { Project, Status, StatusType } from '@/data/tasks-data'

const useDragContextMock = vi.fn()

vi.mock('@dnd-kit/core', () => ({
  DragOverlay: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  defaultDropAnimationSideEffects: vi.fn(() => ({}))
}))

vi.mock('@dnd-kit/utilities', () => ({
  CSS: {
    Transform: {
      toString: () => undefined
    }
  }
}))

vi.mock('@/contexts/drag-context', () => ({
  useDragContext: () => useDragContextMock()
}))

const createStatus = (overrides: Partial<Status> = {}): Status => ({
  id: 'status-todo',
  name: 'To Do',
  color: '#6b7280',
  type: 'todo' as StatusType,
  order: 0,
  ...overrides
})

const createProject = (overrides: Partial<Project> = {}): Project => ({
  id: 'project-1',
  name: 'Test Project',
  description: '',
  icon: 'folder',
  color: '#3b82f6',
  statuses: [
    createStatus({ id: 'p1-todo', name: 'To Do', type: 'todo', order: 0 }),
    createStatus({ id: 'p1-done', name: 'Done', type: 'done', order: 1 })
  ],
  isDefault: false,
  isArchived: false,
  createdAt: new Date(),
  taskCount: 0,
  ...overrides
})

const createTask = (overrides: Partial<Task> = {}): Task => ({
  id: 'task-1',
  title: 'Overlay Task',
  description: '',
  projectId: 'project-1',
  statusId: 'p1-todo',
  priority: 'medium' as Priority,
  dueDate: null,
  dueTime: null,
  isRepeating: false,
  repeatConfig: null,
  linkedNoteIds: [],
  sourceNoteId: null,
  parentId: null,
  subtaskIds: [],
  createdAt: new Date(),
  completedAt: null,
  archivedAt: null,
  ...overrides
})

describe('TaskDragOverlay', () => {
  beforeEach(() => {
    useDragContextMock.mockReset()
  })

  it('renders a stable drag overlay root for single-task list drags', () => {
    useDragContextMock.mockReturnValue({
      isMultiDrag: false,
      dragState: {
        isDragging: true,
        activeId: 'task-1',
        activeIds: ['task-1'],
        sourceType: 'list',
        sourceContainerId: 'flat',
        overId: null,
        overType: null,
        draggedTasks: [createTask()],
        lastDroppedId: null
      }
    })

    render(<TaskDragOverlay projects={[createProject()]} />)

    expect(screen.getByTestId('drag-overlay')).toBeInTheDocument()
    expect(screen.getByText('Overlay Task')).toBeInTheDocument()
  })
})
