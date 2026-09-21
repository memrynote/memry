import type React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'

import { VirtualizedAllTasksView } from './virtualized-all-tasks-view'
import type { Task, Priority } from '@/data/task-model'
import type { Project, Status, StatusType } from '@/data/tasks-data'
import type { TaskNoteIndex } from '@/lib/task-note-index'

const useDroppableMock = vi.fn()
const useDragContextMock = vi.fn()
let noteIndexMock: TaskNoteIndex | undefined
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

// The real hook reaches for the notes list through TanStack Query, which this
// suite has no provider for; grouping itself is covered in task-grouping.test.
vi.mock('@/hooks/use-task-note-index', () => ({
  useTaskNoteIndex: (enabled: boolean) => (enabled ? noteIndexMock : undefined)
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
  title: 'Task One',
  description: '',
  projectId: 'project-1',
  statusId: 'p1-todo',
  priority: 'none' as Priority,
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

describe('VirtualizedAllTasksView list DnD metadata', () => {
  beforeEach(() => {
    useDroppableMock.mockReset()
    useDragContextMock.mockReset()
    measureMock.mockReset()
    measureElementMock.mockReset()
    noteIndexMock = undefined
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

  it('makes mutable grouped headers droppable with explicit list column ids', () => {
    const project = createProject()

    render(
      <VirtualizedAllTasksView
        tasks={[
          createTask({ id: 'task-high', title: 'High Priority', priority: 'high' }),
          createTask({ id: 'task-low', title: 'Low Priority', priority: 'low' })
        ]}
        projects={[project]}
        onToggleComplete={vi.fn()}
        onQuickAdd={vi.fn()}
        sortField="priority"
        sortDirection="asc"
      />
    )

    expect(useDroppableMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: 'column',
          columnId: 'priority-high'
        })
      })
    )
  })

  it('renders one inert header per source folder when grouping by folder', () => {
    const project = createProject()
    noteIndexMock = new Map([
      ['note-msa', { id: 'note-msa', title: 'MSA', folderPath: 'Acme/Legal' }],
      ['note-kickoff', { id: 'note-kickoff', title: 'Kickoff', folderPath: 'Acme/Meetings' }]
    ])

    render(
      <VirtualizedAllTasksView
        tasks={[
          createTask({ id: 'task-msa', title: 'Redline MSA', sourceNoteId: 'note-msa' }),
          createTask({ id: 'task-kickoff', title: 'Share deck', sourceNoteId: 'note-kickoff' }),
          createTask({ id: 'task-loose', title: 'Buy milk' })
        ]}
        projects={[project]}
        onToggleComplete={vi.fn()}
        onQuickAdd={vi.fn()}
        sortField="folder"
        sortDirection="asc"
      />
    )

    expect(screen.getByText('Acme / Legal')).toBeInTheDocument()
    expect(screen.getByText('Acme / Meetings')).toBeInTheDocument()
    expect(screen.getByText('No note')).toBeInTheDocument()
    // A folder is not a task field, so its header must not accept a drop.
    expect(useDroppableMock).not.toHaveBeenCalled()
  })

  it('keeps createdAt groups and done headers inert', () => {
    const project = createProject()
    const now = new Date()

    render(
      <VirtualizedAllTasksView
        tasks={[createTask({ id: 'task-open', title: 'Open Task', createdAt: now })]}
        doneTasks={[
          createTask({
            id: 'task-done',
            title: 'Done Task',
            createdAt: now,
            completedAt: now,
            statusId: 'p1-done'
          })
        ]}
        projects={[project]}
        onToggleComplete={vi.fn()}
        onQuickAdd={vi.fn()}
        sortField="createdAt"
        sortDirection="desc"
      />
    )

    expect(useDroppableMock).not.toHaveBeenCalled()
  })

  it('remeasures the virtualized list when drag layout state changes', () => {
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
      tasks: [
        createTask({ id: 'task-high', title: 'High Priority', priority: 'high' }),
        createTask({ id: 'task-low', title: 'Low Priority', priority: 'low' })
      ],
      projects: [project],
      onToggleComplete: vi.fn(),
      onQuickAdd: vi.fn(),
      sortField: 'priority' as const,
      sortDirection: 'asc' as const
    }

    const { rerender } = render(<VirtualizedAllTasksView {...props} />)
    expect(measureMock).toHaveBeenCalledTimes(1)

    measureMock.mockClear()
    dragState = {
      ...dragState,
      isDragging: true,
      activeId: 'task-low',
      activeIds: ['task-low'],
      sourceContainerId: 'priority-low',
      overId: 'task-high',
      overType: 'task',
      overSectionId: 'priority-high',
      overColumnId: 'priority-high',
      overTaskEdge: 'before',
      sectionDropPosition: 'start'
    }

    rerender(<VirtualizedAllTasksView {...props} />)

    expect(measureMock).toHaveBeenCalledTimes(1)
  })
})
