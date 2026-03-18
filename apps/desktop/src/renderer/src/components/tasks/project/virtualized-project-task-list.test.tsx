import type React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'

import { VirtualizedProjectTaskList } from './virtualized-project-task-list'
import type { Task, Priority } from '@/data/sample-tasks'
import type { Project, Status, StatusType } from '@/data/tasks-data'

const useDroppableMock = vi.fn()
const useDragContextMock = vi.fn()
const measureMock = vi.fn()
let virtualizerCount = 0
const expandedIdsMock = new Set<string>()
const toggleExpandedMock = vi.fn()
const measureElementMock = vi.fn()
const virtualizerMock = {
  getTotalSize: () => virtualizerCount * 40,
  getVirtualItems: () =>
    Array.from({ length: virtualizerCount }, (_, index) => ({
      index,
      key: index,
      start: index * 40,
      size: 40
    })),
  measure: measureMock,
  measureElement: measureElementMock
}

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => {
    virtualizerCount = count
    return virtualizerMock
  }
}))

vi.mock('@dnd-kit/sortable', () => ({
  SortableContext: ({ children }: { children: React.ReactNode }) => children,
  verticalListSortingStrategy: {}
}))

vi.mock('@dnd-kit/core', async () => {
  const actual = await vi.importActual<typeof import('@dnd-kit/core')>('@dnd-kit/core')
  return {
    ...actual,
    useDroppable: (options: unknown) => {
      useDroppableMock(options)
      return { setNodeRef: vi.fn(), isOver: false }
    }
  }
})

vi.mock('@/hooks', () => ({
  useExpandedTasks: () => ({
    expandedIds: expandedIdsMock,
    toggleExpanded: toggleExpandedMock
  })
}))

vi.mock('@/contexts/drag-context', () => ({
  useDragContext: () => useDragContextMock()
}))

vi.mock('@/components/tasks/drag-drop', async () => {
  const actual = await vi.importActual<typeof import('@/components/tasks/drag-drop')>(
    '@/components/tasks/drag-drop'
  )

  return {
    ...actual,
    SortableTaskRow: ({
      task,
      sectionId,
      columnId
    }: {
      task: Task
      sectionId: string
      columnId?: string
    }) => (
      <div
        data-testid="sortable-task-row"
        data-task-id={task.id}
        data-section-id={sectionId}
        data-column-id={columnId ?? ''}
      />
    ),
    SortableParentTaskRow: ({
      task,
      sectionId,
      columnId
    }: {
      task: Task
      sectionId: string
      columnId?: string
    }) => (
      <div
        data-testid="sortable-parent-task-row"
        data-task-id={task.id}
        data-section-id={sectionId}
        data-column-id={columnId ?? ''}
      />
    )
  }
})

const createStatus = (overrides: Partial<Status> = {}): Status => ({
  id: 'p1-todo',
  name: 'To Do',
  color: '#6b7280',
  type: 'todo' as StatusType,
  order: 0,
  ...overrides
})

const createProject = (overrides: Partial<Project> = {}): Project => ({
  id: 'project-1',
  name: 'Project One',
  description: '',
  icon: 'folder',
  color: '#3b82f6',
  statuses: [
    createStatus({ id: 'p1-todo', name: 'To Do', type: 'todo', order: 0 }),
    createStatus({ id: 'p1-progress', name: 'In Progress', type: 'in_progress', order: 1 }),
    createStatus({ id: 'p1-done', name: 'Done', type: 'done', order: 2 })
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
  statusId: 'p1-todo',
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

describe('VirtualizedProjectTaskList list DnD metadata', () => {
  beforeEach(() => {
    useDroppableMock.mockReset()
    useDragContextMock.mockReset()
    measureMock.mockReset()
    measureElementMock.mockReset()
    useDragContextMock.mockReturnValue({
      dragState: {
        isDragging: false,
        activeId: null,
        activeIds: [],
        sourceType: 'list',
        sourceContainerId: null,
        overId: null,
        overType: null,
        overSectionId: null,
        overColumnId: null,
        overTaskEdge: null,
        sectionDropPosition: null,
        draggedTasks: [],
        lastDroppedId: null
      }
    })
  })

  it('makes project status headers droppable and renders parent rows through sortable wrappers', () => {
    const project = createProject()

    render(
      <VirtualizedProjectTaskList
        tasks={[
          createTask({ id: 'parent-task', statusId: 'p1-todo' }),
          createTask({
            id: 'subtask-1',
            title: 'Child Task',
            parentId: 'parent-task',
            subtaskIds: [],
            statusId: 'p1-todo'
          })
        ]}
        project={project}
        onToggleComplete={vi.fn()}
        onQuickAdd={vi.fn()}
      />
    )

    expect(useDroppableMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: 'column',
          columnId: 'p1-todo'
        })
      })
    )

    expect(screen.getByTestId('sortable-parent-task-row')).toHaveAttribute(
      'data-column-id',
      'p1-todo'
    )
  })

  it('remeasures the project virtualized list when drag layout state changes', () => {
    const project = createProject()
    let dragState = {
      isDragging: false,
      activeId: null as string | null,
      activeIds: [] as string[],
      sourceType: 'list' as const,
      sourceContainerId: null as string | null,
      overId: null as string | null,
      overType: null as 'task' | 'column' | null,
      overSectionId: null as string | null,
      overColumnId: null as string | null,
      overTaskEdge: null as 'before' | 'after' | null,
      sectionDropPosition: null as 'start' | 'end' | null,
      draggedTasks: [],
      lastDroppedId: null as string | null
    }

    useDragContextMock.mockImplementation(() => ({ dragState }))

    const props = {
      tasks: [createTask({ id: 'task-1', statusId: 'p1-todo' })],
      project,
      onToggleComplete: vi.fn(),
      onQuickAdd: vi.fn()
    }

    const { rerender } = render(<VirtualizedProjectTaskList {...props} />)
    expect(measureMock).toHaveBeenCalledTimes(1)

    measureMock.mockClear()
    dragState = {
      ...dragState,
      isDragging: true,
      activeId: 'task-1',
      activeIds: ['task-1'],
      sourceContainerId: 'p1-todo',
      overId: 'p1-progress',
      overType: 'column',
      overSectionId: 'p1-progress',
      overColumnId: 'p1-progress',
      sectionDropPosition: 'start'
    }

    rerender(<VirtualizedProjectTaskList {...props} />)

    expect(measureMock).toHaveBeenCalledTimes(1)
  })
})
