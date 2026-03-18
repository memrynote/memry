import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'

import { SortableParentTaskRow } from './sortable-parent-task-row'
import type { Task, Priority } from '@/data/sample-tasks'
import type { Project, Status, StatusType } from '@/data/tasks-data'

const useSortableMock = vi.fn()
const useDragContextMock = vi.fn()
const useDroppedPrioritiesMock = vi.fn()

vi.mock('@dnd-kit/sortable', () => ({
  useSortable: (options: unknown) => useSortableMock(options)
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

vi.mock('@/contexts/dropped-priority-context', () => ({
  useDroppedPriorities: () => useDroppedPrioritiesMock()
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
    createStatus({ id: 'status-todo', name: 'To Do', type: 'todo', order: 0 }),
    createStatus({ id: 'status-done', name: 'Done', type: 'done', order: 1 })
  ],
  isDefault: false,
  isArchived: false,
  createdAt: new Date(),
  taskCount: 0,
  ...overrides
})

const createTask = (overrides: Partial<Task> = {}): Task => ({
  id: 'task-1',
  title: 'Parent Task',
  description: '',
  projectId: 'project-1',
  statusId: 'status-todo',
  priority: 'medium' as Priority,
  dueDate: null,
  dueTime: null,
  isRepeating: false,
  repeatConfig: null,
  linkedNoteIds: [],
  sourceNoteId: null,
  parentId: null,
  subtaskIds: ['subtask-1'],
  createdAt: new Date(),
  completedAt: null,
  archivedAt: null,
  ...overrides
})

describe('SortableParentTaskRow', () => {
  const setNodeRef = vi.fn()

  beforeEach(() => {
    useSortableMock.mockReset()
    useDragContextMock.mockReset()
    useDroppedPrioritiesMock.mockReset()
    setNodeRef.mockReset()

    useSortableMock.mockReturnValue({
      attributes: { role: 'button' },
      listeners: { onPointerDown: vi.fn() },
      setNodeRef,
      transform: null,
      transition: null,
      isDragging: false
    })

    useDragContextMock.mockReturnValue({
      dragState: {
        isDragging: false,
        activeId: null,
        activeIds: [],
        sourceType: 'list',
        sourceContainerId: null,
        overId: null,
        overType: null,
        draggedTasks: [],
        lastDroppedId: null
      }
    })

    useDroppedPrioritiesMock.mockReturnValue(new Map())
  })

  it('registers the parent row as a sortable list item with full drop metadata', () => {
    const project = createProject()
    const task = createTask()

    render(
      <SortableParentTaskRow
        task={task}
        project={project}
        projects={[project]}
        subtasks={[createTask({ id: 'subtask-1', parentId: task.id, title: 'Child Task' })]}
        progress={{ completed: 0, total: 1 }}
        isExpanded={false}
        isCompleted={false}
        sectionId="status-todo"
        sectionTaskIds={['task-1', 'task-2']}
        columnId="status-todo"
        onToggleExpand={vi.fn()}
        onToggleComplete={vi.fn()}
      />
    )

    expect(useSortableMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'task-1',
        data: expect.objectContaining({
          type: 'task',
          task,
          sectionId: 'status-todo',
          sectionTaskIds: ['task-1', 'task-2'],
          columnId: 'status-todo',
          sourceType: 'list'
        })
      })
    )

    expect(setNodeRef).toHaveBeenCalled()
    expect(screen.getByTestId('drag-handle')).toBeInTheDocument()
  })
})
