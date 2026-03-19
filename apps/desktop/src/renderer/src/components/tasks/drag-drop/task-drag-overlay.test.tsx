import type React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'

import { TaskDragOverlay } from './task-drag-overlay'
import type { Task, Priority, RepeatConfig } from '@/data/sample-tasks'
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

const createRepeatConfig = (overrides: Partial<RepeatConfig> = {}): RepeatConfig => ({
  frequency: 'weekly',
  interval: 1,
  daysOfWeek: [1],
  endType: 'never',
  completedCount: 0,
  createdAt: new Date('2026-03-18T10:00:00Z'),
  ...overrides
})

describe('TaskDragOverlay', () => {
  beforeEach(() => {
    useDragContextMock.mockReset()
  })

  it('renders a list-specific drag overlay for single-task list drags', () => {
    const dueDate = new Date('2026-03-21T00:00:00Z')

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
        overSectionId: null,
        overColumnId: null,
        overlayWidth: 512,
        overlayRowVariant: 'task',
        overlayShowProjectBadge: true,
        overlayParentProgress: null,
        overlayParentExpanded: false,
        draggedTasks: [
          createTask({
            title: 'Review sync conflict edge cases',
            dueDate,
            isRepeating: true,
            repeatConfig: createRepeatConfig()
          })
        ],
        lastDroppedId: null
      }
    })

    render(<TaskDragOverlay projects={[createProject()]} />)

    const overlay = screen.getByTestId('drag-overlay')
    expect(overlay).toBeInTheDocument()
    expect(overlay).toHaveClass(
      'bg-card',
      'border-[#4C9EFF]',
      'border-[1.5px]',
      'rounded-md',
      'cursor-grabbing'
    )
    expect(overlay.className).not.toContain('bg-[#27272A]')
    expect(overlay).toHaveStyle({ width: '512px' })
    expect(overlay.className).not.toContain('rotate-2')
    expect(overlay).toHaveAttribute('data-overlay-row-variant', 'task')
    expect(screen.queryByTestId('overlay-drag-handle')).not.toBeInTheDocument()
    expect(screen.getByText('Review sync conflict edge cases')).toBeInTheDocument()
    expect(screen.getByText('Test Project')).toBeInTheDocument()
    expect(overlay.textContent).toContain('Mar 21')
  })

  it('renders the parent-row overlay variant with parent-specific metadata', () => {
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
        overSectionId: null,
        overColumnId: null,
        overlayWidth: 440,
        overlayRowVariant: 'parent',
        overlayShowProjectBadge: false,
        overlayParentProgress: { completed: 1, total: 3 },
        overlayParentExpanded: true,
        draggedTasks: [createTask({ title: 'Parent Overlay Task', subtaskIds: ['a', 'b', 'c'] })],
        lastDroppedId: null
      }
    })

    render(<TaskDragOverlay projects={[createProject()]} />)

    const overlay = screen.getByTestId('drag-overlay')
    expect(overlay).toHaveAttribute('data-overlay-row-variant', 'parent')
    expect(screen.getByText('1/3')).toBeInTheDocument()
    expect(screen.getByLabelText('Collapse subtasks')).toBeInTheDocument()
  })

  it('renders stacked row ghosts for list multi-drag overlays', () => {
    useDragContextMock.mockReturnValue({
      isMultiDrag: true,
      dragState: {
        isDragging: true,
        activeId: 'task-1',
        activeIds: ['task-1', 'task-2'],
        sourceType: 'list',
        sourceContainerId: 'flat',
        overId: null,
        overType: null,
        overSectionId: null,
        overColumnId: null,
        overlayWidth: 496,
        overlayRowVariant: 'task',
        overlayShowProjectBadge: false,
        overlayParentProgress: null,
        overlayParentExpanded: false,
        draggedTasks: [
          createTask({ id: 'task-1', title: 'First stacked task' }),
          createTask({ id: 'task-2', title: 'Second stacked task' })
        ],
        lastDroppedId: null
      }
    })

    render(<TaskDragOverlay projects={[createProject()]} />)

    const overlay = screen.getByTestId('drag-overlay')
    expect(overlay).toHaveAttribute('data-overlay-variant', 'list-multi')
    expect(screen.getAllByTestId('overlay-ghost-row')).toHaveLength(2)
    expect(screen.getByText('2')).toBeInTheDocument()
    expect(screen.getByText('First stacked task')).toBeInTheDocument()
  })
})
