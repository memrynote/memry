import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { KanbanColumn } from './kanban-column'
import type { Task } from '@/data/task-model'
import type { Project } from '@/data/tasks-data'
import type { KanbanColumnDef } from './kanban-columns'

let droppableOver = false
let dragState = {
  isDragging: false,
  overId: null as string | null,
  sourceContainerId: null as string | null,
  draggedTasks: [] as Task[]
}

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key.split('.').at(-1) ?? key })
}))

vi.mock('@dnd-kit/core', () => ({
  useDroppable: vi.fn(() => ({
    setNodeRef: vi.fn(),
    isOver: droppableOver
  }))
}))

vi.mock('@dnd-kit/sortable', () => ({
  SortableContext: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="sortable-context">{children}</div>
  ),
  verticalListSortingStrategy: {}
}))

vi.mock('@/contexts/drag-context', () => ({
  useDragContext: () => ({ dragState })
}))

vi.mock('./kanban-card', () => ({
  SortableKanbanCard: ({
    task,
    onClick,
    onToggleComplete,
    onToggleSelect
  }: {
    task: Task
    onClick: () => void
    onToggleComplete: () => void
    onToggleSelect: () => void
  }) => (
    <div>
      <button type="button" onClick={onClick}>
        card {task.title}
      </button>
      <button type="button" onClick={onToggleComplete}>
        complete {task.title}
      </button>
      <button type="button" onClick={onToggleSelect}>
        select {task.title}
      </button>
    </div>
  )
}))

vi.mock('./kanban-empty-column', () => ({
  KanbanEmptyColumn: ({ variant, isDropTarget }: { variant: string; isDropTarget: boolean }) => (
    <div data-testid="empty-column">
      {variant}:{String(isDropTarget)}
    </div>
  )
}))

const project: Project = {
  id: 'project-a',
  name: 'Alpha',
  color: '#336699',
  description: null,
  taskCount: 0,
  completedCount: 0,
  archivedAt: null,
  createdAt: new Date('2026-05-01T00:00:00.000Z'),
  updatedAt: new Date('2026-05-01T00:00:00.000Z'),
  statuses: [
    { id: 'todo', name: 'Todo', type: 'todo', color: '#999999', order: 0 },
    { id: 'done', name: 'Done', type: 'done', color: '#228855', order: 1 }
  ]
} as Project

const makeTask = (id: string, overrides: Partial<Task> = {}): Task =>
  ({
    id,
    title: `Task ${id}`,
    description: null,
    projectId: 'project-a',
    statusId: 'todo',
    priority: 'medium',
    dueDate: null,
    dueTime: null,
    completedAt: null,
    archivedAt: null,
    order: 0,
    createdAt: new Date('2026-05-01T00:00:00.000Z'),
    updatedAt: new Date('2026-05-01T00:00:00.000Z'),
    isRepeating: false,
    repeatConfig: null,
    ...overrides
  }) as Task

const todoColumn: KanbanColumnDef = {
  id: 'todo',
  title: 'Todo',
  statusType: 'todo',
  color: '#999999',
  project
}

describe('KanbanColumn major interactions', () => {
  beforeEach(() => {
    droppableOver = false
    dragState = {
      isDragging: false,
      overId: null,
      sourceContainerId: null,
      draggedTasks: []
    }
  })

  it('renders empty columns and quick-adds tasks', () => {
    const onQuickAdd = vi.fn()
    render(
      <KanbanColumn
        column={todoColumn}
        tasks={[]}
        allTasks={[]}
        projects={[project]}
        onQuickAdd={onQuickAdd}
      />
    )

    expect(screen.getByRole('region', { name: 'Todo column, 0 tasks' })).toBeInTheDocument()
    expect(screen.getByTestId('empty-column')).toHaveTextContent('default:false')

    fireEvent.click(screen.getByRole('button', { name: 'Add task to Todo' }))
    const input = screen.getByPlaceholderText('taskTitle')
    fireEvent.change(input, { target: { value: ' Draft rollout ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onQuickAdd).toHaveBeenCalledWith('Draft rollout', 'todo')

    fireEvent.click(screen.getByRole('button', { name: 'Add task to Todo' }))
    fireEvent.change(screen.getByPlaceholderText('taskTitle'), { target: { value: 'Cancel me' } })
    fireEvent.keyDown(screen.getByPlaceholderText('taskTitle'), { key: 'Escape' })
    expect(screen.queryByDisplayValue('Cancel me')).not.toBeInTheDocument()
  })

  it('renders visible cards, delegates card actions, and shows cross-column ghost state', () => {
    const onTaskClick = vi.fn()
    const onToggleComplete = vi.fn()
    const onToggleSelect = vi.fn()
    const tasks = [makeTask('a'), makeTask('b')]

    dragState = {
      isDragging: true,
      overId: 'b',
      sourceContainerId: 'other',
      draggedTasks: [makeTask('dragged', { title: 'Dragged task' })]
    }

    render(
      <KanbanColumn
        column={{ ...todoColumn, id: 'priority-urgent', title: 'Urgent' }}
        tasks={tasks}
        allTasks={tasks}
        projects={[project]}
        focusedTaskId="a"
        selectedTaskId="b"
        selectedIds={new Set(['a'])}
        isSelectionMode
        showProjectBadge
        onTaskClick={onTaskClick}
        onToggleComplete={onToggleComplete}
        onToggleSelect={onToggleSelect}
      />
    )

    expect(screen.getByText('Urgent')).toBeInTheDocument()
    expect(screen.getByText('Dragged task')).toBeInTheDocument()

    fireEvent.click(screen.getByText('card Task a'))
    fireEvent.click(screen.getByText('complete Task a'))
    fireEvent.click(screen.getByText('select Task a'))

    expect(onTaskClick).toHaveBeenCalledWith('a')
    expect(onToggleComplete).toHaveBeenCalledWith('a')
    expect(onToggleSelect).toHaveBeenCalledWith('a')
  })

  it('limits done columns, expands and collapses completed tasks, and shows drop placeholders', () => {
    const doneTasks = Array.from({ length: 7 }, (_, index) =>
      makeTask(String(index), {
        title: `Done ${index}`,
        statusId: 'done',
        completedAt: new Date('2026-05-10T00:00:00.000Z')
      })
    )
    droppableOver = true

    render(
      <KanbanColumn
        column={{
          id: 'done',
          title: 'Done',
          statusType: 'done',
          color: '#228855',
          project
        }}
        tasks={doneTasks}
        allTasks={doneTasks}
        projects={[project]}
      />
    )

    expect(screen.getByRole('region', { name: 'Done column, 7 tasks' })).toBeInTheDocument()
    expect(screen.getByText(/2 moreCompleted/)).toBeInTheDocument()
    expect(screen.queryByText('card Done 6')).not.toBeInTheDocument()
    expect(screen.getByText('dropHere')).toBeInTheDocument()

    fireEvent.click(screen.getByText(/2 moreCompleted/))
    expect(screen.getByText('card Done 6')).toBeInTheDocument()

    fireEvent.click(screen.getByText('showFewer'))
    expect(screen.queryByText('card Done 6')).not.toBeInTheDocument()
  })

  it('renders custom and empty drop-target column headers', () => {
    droppableOver = true

    const { rerender } = render(
      <KanbanColumn
        column={{
          id: 'custom-status',
          title: 'Waiting',
          statusType: 'custom',
          color: '#8844cc',
          project
        }}
        tasks={[]}
        allTasks={[]}
        projects={[project]}
      />
    )
    expect(screen.getByText('Waiting')).toBeInTheDocument()
    expect(screen.getByText('dropHere')).toBeInTheDocument()

    rerender(
      <KanbanColumn
        column={todoColumn}
        tasks={[]}
        allTasks={[]}
        projects={[project]}
        onQuickAdd={vi.fn()}
      />
    )
    expect(screen.getByText('dropHere')).toBeInTheDocument()
  })
})
