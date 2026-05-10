import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { Task, Priority } from '@/data/task-model'
import type { Project, StatusType, Status } from '@/data/tasks-data'
import { KanbanCardContent, SortableKanbanCard } from './kanban-card'

const mocks = vi.hoisted(() => ({
  dragState: { lastDroppedId: null as string | null },
  sortableState: {
    attributes: { 'data-sortable': 'task' },
    listeners: { onPointerDown: vi.fn() },
    setNodeRef: vi.fn(),
    transform: { x: 12, y: 4, scaleX: 1, scaleY: 1 },
    transition: 'transform 150ms',
    isDragging: false
  }
}))

vi.mock('@/contexts/drag-context', () => ({
  useDragContext: () => ({
    dragState: mocks.dragState,
    setDragState: vi.fn(),
    resetDragState: vi.fn(),
    isMultiDrag: false,
    dragCount: 0
  })
}))

vi.mock('@dnd-kit/sortable', () => ({
  useSortable: vi.fn(() => mocks.sortableState)
}))

vi.mock('@dnd-kit/utilities', () => ({
  CSS: {
    Transform: {
      toString: vi.fn(() => 'translate3d(12px, 4px, 0)')
    }
  }
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
  title: 'Test Task',
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

describe('KanbanCardContent', () => {
  const project = createProject({ name: 'Memry' })

  beforeEach(() => {
    mocks.dragState.lastDroppedId = null
    mocks.sortableState.isDragging = false
    mocks.sortableState.setNodeRef.mockClear()
  })

  describe('project badge visibility', () => {
    it('renders project badge by default when project is provided', () => {
      // #given
      const task = createTask()

      // #when
      render(<KanbanCardContent task={task} project={project} allTasks={[task]} />)

      // #then
      expect(screen.getByText('Memry')).toBeInTheDocument()
    })

    it('hides project badge when showProjectBadge is false', () => {
      // #given
      const task = createTask()

      // #when
      render(
        <KanbanCardContent
          task={task}
          project={project}
          allTasks={[task]}
          showProjectBadge={false}
        />
      )

      // #then
      expect(screen.queryByText('Memry')).not.toBeInTheDocument()
    })

    it('shows project badge when showProjectBadge is true', () => {
      // #given
      const task = createTask()

      // #when
      render(
        <KanbanCardContent
          task={task}
          project={project}
          allTasks={[task]}
          showProjectBadge={true}
        />
      )

      // #then
      expect(screen.getByText('Memry')).toBeInTheDocument()
    })
  })

  it('renders priority, overdue, repeat, subtask, linked-note, focus, and dropped states', () => {
    mocks.dragState.lastDroppedId = 'task-1'
    const task = createTask({
      priority: 'high',
      dueDate: new Date('2026-01-01T00:00:00.000Z'),
      dueTime: '09:30',
      isRepeating: true,
      repeatConfig: {
        frequency: 'weekly',
        interval: 1,
        daysOfWeek: [1],
        endType: 'never',
        completedCount: 0,
        createdAt: new Date('2026-01-01T00:00:00.000Z')
      },
      linkedNoteIds: ['note-1', 'note-2'],
      subtaskIds: ['sub-1', 'sub-2']
    })
    const subtaskDone = createTask({
      id: 'sub-1',
      title: 'Done subtask',
      parentId: 'task-1',
      completedAt: new Date('2026-01-02T00:00:00.000Z')
    })
    const subtaskOpen = createTask({ id: 'sub-2', title: 'Open subtask', parentId: 'task-1' })

    render(
      <KanbanCardContent
        task={task}
        project={project}
        allTasks={[task, subtaskDone, subtaskOpen]}
        isFocused
      />
    )

    const card = screen.getByRole('button', { name: 'Test Task' })
    expect(card.className).toContain('animate-drop-flash')
    expect(card.className).toContain('ring-primary/40')
    expect(screen.getByText('High')).toBeInTheDocument()
    expect(screen.getByText(/late/i)).toBeInTheDocument()
    expect(screen.getByText('2')).toBeInTheDocument()
    expect(screen.getByText('1/2')).toBeInTheDocument()
  })

  it('drives click, keyboard complete, and selection-mode branches', () => {
    const onClick = vi.fn()
    const onToggleComplete = vi.fn()
    const onToggleSelect = vi.fn()

    const { rerender } = render(
      <KanbanCardContent
        task={createTask({ dueDate: new Date(Date.now() + 86400000), priority: 'medium' })}
        allTasks={[]}
        onClick={onClick}
        onToggleComplete={onToggleComplete}
      />
    )

    const card = screen.getByRole('button', { name: 'Test Task' })
    fireEvent.click(card)
    fireEvent.keyDown(card, { key: 'Enter' })
    fireEvent.keyDown(card, { key: ' ' })
    expect(onClick).toHaveBeenCalledTimes(2)
    expect(onToggleComplete).toHaveBeenCalledTimes(1)
    expect(screen.getByText('Medium')).toBeInTheDocument()

    rerender(
      <KanbanCardContent
        task={createTask({ id: 'select-task', title: 'Select task' })}
        allTasks={[]}
        isSelectionMode
        isSelected
        onClick={onClick}
        onToggleSelect={onToggleSelect}
      />
    )

    const selectedCard = screen.getByRole('button', { name: 'Select task' })
    fireEvent.click(selectedCard)
    fireEvent.keyDown(selectedCard, { key: ' ' })
    expect(onToggleSelect).toHaveBeenCalledTimes(2)
    expect(selectedCard).toHaveAttribute('aria-selected', 'true')
  })

  it('renders done and dragging variants plus sortable drag metadata', () => {
    mocks.sortableState.isDragging = true
    const task = createTask({
      id: 'done-task',
      title: 'Done task',
      completedAt: new Date(),
      dueDate: new Date(),
      priority: 'urgent'
    })

    const { rerender } = render(<KanbanCardContent task={task} allTasks={[]} isDone />)
    expect(screen.getByText('Just now')).toBeInTheDocument()
    expect(screen.queryByText('Urgent')).not.toBeInTheDocument()

    rerender(
      <SortableKanbanCard
        task={createTask({ id: 'sortable-task', title: 'Sortable task' })}
        allTasks={[]}
        columnId="todo"
        sectionTaskIds={['sortable-task']}
      />
    )

    const sortable = screen.getByRole('button', { name: 'Sortable task' })
    expect(sortable).toHaveStyle({ transform: 'translate3d(12px, 4px, 0)' })
    expect(sortable.className).toContain('border-dashed')
    expect(mocks.sortableState.setNodeRef).toHaveBeenCalled()
  })
})
