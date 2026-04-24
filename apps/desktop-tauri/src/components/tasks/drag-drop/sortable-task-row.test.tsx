import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

import { SortableTaskRow } from './sortable-task-row'
import type { Task, Priority } from '@/data/sample-tasks'
import type { Project, Status, StatusType } from '@/data/tasks-data'

const useSortableMock = vi.fn()
const useDragContextMock = vi.fn()
const useDroppedPrioritiesMock = vi.fn()

vi.mock('@dnd-kit/sortable', () => ({
  useSortable: (options: unknown) => useSortableMock(options),
  sortableKeyboardCoordinates: vi.fn()
}))

vi.mock('@dnd-kit/utilities', () => ({
  CSS: {
    Transform: {
      toString: (transform: { x: number; y: number; scaleX?: number; scaleY?: number } | null) =>
        transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined
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
  title: 'List Task',
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
  subtaskIds: [],
  createdAt: new Date(),
  completedAt: null,
  archivedAt: null,
  ...overrides
})

describe('SortableTaskRow', () => {
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
        isDragging: true,
        activeId: 'task-3',
        activeIds: ['task-3'],
        sourceType: 'list',
        sourceContainerId: 'priority-low',
        overId: 'task-2',
        overType: 'task',
        overSectionId: 'priority-high',
        overColumnId: 'priority-high',
        draggedTasks: [],
        lastDroppedId: null
      }
    })

    useDroppedPrioritiesMock.mockReturnValue(new Map())
  })

  it('resolves target-section visual state from normalized drag metadata', () => {
    const project = createProject()

    render(
      <SortableTaskRow
        task={createTask({ id: 'task-2' })}
        project={project}
        projects={[project]}
        isCompleted={false}
        sectionId="priority-high"
        sectionTaskIds={['task-2', 'task-4']}
        columnId="priority-high"
        onToggleComplete={vi.fn()}
      />
    )

    expect(screen.getByLabelText(/^Task: List Task/)).toHaveAttribute(
      'data-section-drag-state',
      'target-highlighted'
    )
  })

  it('keeps target-section rows highlighted when hovering a row without column metadata', () => {
    const project = createProject()

    useDragContextMock.mockReturnValue({
      dragState: {
        isDragging: true,
        activeId: 'task-3',
        activeIds: ['task-3'],
        sourceType: 'list',
        sourceContainerId: 'priority-low',
        overId: 'task-2',
        overType: 'task',
        overSectionId: 'priority-high',
        overColumnId: null,
        draggedTasks: [],
        lastDroppedId: null
      }
    })

    render(
      <SortableTaskRow
        task={createTask({ id: 'task-2' })}
        project={project}
        projects={[project]}
        isCompleted={false}
        sectionId="priority-high"
        sectionTaskIds={['task-2', 'task-4']}
        columnId="priority-high"
        onToggleComplete={vi.fn()}
      />
    )

    expect(screen.getByLabelText(/^Task: List Task/)).toHaveAttribute(
      'data-section-drag-state',
      'target-highlighted'
    )
  })

  it('registers overlay metadata for row-shaped list previews', () => {
    const project = createProject()
    const task = createTask()

    render(
      <SortableTaskRow
        task={task}
        project={project}
        projects={[project]}
        isCompleted={false}
        showProjectBadge
        sectionId="flat"
        sectionTaskIds={['task-1']}
        columnId="flat"
        onToggleComplete={vi.fn()}
      />
    )

    expect(useSortableMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          overlayRowVariant: 'task',
          overlayShowProjectBadge: true
        })
      })
    )
  })

  it('suppresses target-section transforms during cross-section list drags', () => {
    const project = createProject()

    useSortableMock.mockReturnValue({
      attributes: { role: 'button' },
      listeners: { onPointerDown: vi.fn() },
      setNodeRef,
      transform: { x: 0, y: 48, scaleX: 1, scaleY: 1 },
      transition: null,
      isDragging: false
    })

    render(
      <SortableTaskRow
        task={createTask({ id: 'task-2' })}
        project={project}
        projects={[project]}
        isCompleted={false}
        sectionId="priority-high"
        sectionTaskIds={['task-2', 'task-4']}
        columnId="priority-high"
        onToggleComplete={vi.fn()}
      />
    )

    expect((screen.getByTestId('sortable-task-row') as HTMLDivElement).style.transform).toBe('')
  })

  it('suppresses source and intermediate-section transforms during cross-section list drags', () => {
    const project = createProject()

    useDragContextMock.mockReturnValue({
      dragState: {
        isDragging: true,
        activeId: 'task-source',
        activeIds: ['task-source'],
        sourceType: 'list',
        sourceContainerId: 'priority-medium',
        overId: 'task-urgent',
        overType: 'task',
        overSectionId: 'priority-urgent',
        overColumnId: 'priority-urgent',
        overTaskEdge: 'before',
        sectionDropPosition: null,
        draggedTasks: [],
        lastDroppedId: null
      }
    })

    useSortableMock.mockReturnValue({
      attributes: { role: 'button' },
      listeners: { onPointerDown: vi.fn() },
      setNodeRef,
      transform: { x: 0, y: 48, scaleX: 1, scaleY: 1 },
      transition: null,
      isDragging: true
    })

    const { rerender } = render(
      <SortableTaskRow
        task={createTask({ id: 'task-source', title: 'Source Task' })}
        project={project}
        projects={[project]}
        isCompleted={false}
        sectionId="priority-medium"
        sectionTaskIds={['task-source']}
        columnId="priority-medium"
        onToggleComplete={vi.fn()}
      />
    )

    expect((screen.getByTestId('sortable-task-row') as HTMLDivElement).style.transform).toBe('')

    useSortableMock.mockReturnValue({
      attributes: { role: 'button' },
      listeners: { onPointerDown: vi.fn() },
      setNodeRef,
      transform: { x: 0, y: 48, scaleX: 1, scaleY: 1 },
      transition: null,
      isDragging: false
    })

    rerender(
      <SortableTaskRow
        task={createTask({ id: 'task-high', title: 'Intermediate Task' })}
        project={project}
        projects={[project]}
        isCompleted={false}
        sectionId="priority-high"
        sectionTaskIds={['task-high']}
        columnId="priority-high"
        onToggleComplete={vi.fn()}
      />
    )

    expect((screen.getByTestId('sortable-task-row') as HTMLDivElement).style.transform).toBe('')
  })

  it('keeps sortable transforms enabled for same-section reorder drags', () => {
    const project = createProject()

    useDragContextMock.mockReturnValue({
      dragState: {
        isDragging: true,
        activeId: 'task-1',
        activeIds: ['task-1'],
        sourceType: 'list',
        sourceContainerId: 'priority-high',
        overId: 'task-2',
        overType: 'task',
        overSectionId: 'priority-high',
        overColumnId: 'priority-high',
        overTaskEdge: 'after',
        sectionDropPosition: null,
        draggedTasks: [],
        lastDroppedId: null
      }
    })

    useSortableMock.mockReturnValue({
      attributes: { role: 'button' },
      listeners: { onPointerDown: vi.fn() },
      setNodeRef,
      transform: { x: 0, y: 48, scaleX: 1, scaleY: 1 },
      transition: null,
      isDragging: false
    })

    render(
      <SortableTaskRow
        task={createTask({ id: 'task-2' })}
        project={project}
        projects={[project]}
        isCompleted={false}
        sectionId="priority-high"
        sectionTaskIds={['task-1', 'task-2']}
        columnId="priority-high"
        onToggleComplete={vi.fn()}
      />
    )

    expect((screen.getByTestId('sortable-task-row') as HTMLDivElement).style.transform).toBe(
      'translate3d(0px, 48px, 0)'
    )
  })

  it('shows a cross-section insertion indicator on the hovered target row', () => {
    const project = createProject()

    useDragContextMock.mockReturnValue({
      dragState: {
        isDragging: true,
        activeId: 'task-9',
        activeIds: ['task-9'],
        sourceType: 'list',
        sourceContainerId: 'priority-low',
        overId: 'task-2',
        overType: 'task',
        overSectionId: 'priority-high',
        overColumnId: 'priority-high',
        overTaskEdge: 'after',
        sectionDropPosition: null,
        draggedTasks: [],
        lastDroppedId: null
      }
    })

    render(
      <SortableTaskRow
        task={createTask({ id: 'task-2' })}
        project={project}
        projects={[project]}
        isCompleted={false}
        sectionId="priority-high"
        sectionTaskIds={['task-2', 'task-4']}
        columnId="priority-high"
        onToggleComplete={vi.fn()}
      />
    )

    expect(screen.getByTestId('list-drop-indicator')).toHaveAttribute(
      'data-drop-indicator',
      'reorder'
    )
  })
})
