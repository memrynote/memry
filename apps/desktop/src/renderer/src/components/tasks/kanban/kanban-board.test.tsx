import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Task } from '@/data/task-model'
import type { Project } from '@/data/tasks-data'
import { KanbanBoard } from './kanban-board'

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key })
}))

vi.mock('./kanban-column', () => ({
  KanbanColumn: ({
    column,
    tasks,
    focusedTaskId,
    onTaskClick,
    onToggleComplete,
    onQuickAdd,
    onToggleSelect,
    showProjectBadge
  }: {
    column: { id: string; title: string }
    tasks: Task[]
    focusedTaskId: string | null
    onTaskClick?: (taskId: string) => void
    onToggleComplete: (taskId: string) => void
    onQuickAdd?: (title: string, columnId: string) => void
    onToggleSelect?: (taskId: string) => void
    showProjectBadge: boolean
  }) => (
    <section data-testid={`column-${column.id}`}>
      <h2>{column.title}</h2>
      <span>focused:{focusedTaskId ?? 'none'}</span>
      <span>project badge:{String(showProjectBadge)}</span>
      {tasks.map((task) => (
        <button key={task.id} onClick={() => onTaskClick?.(task.id)}>
          {task.title}
        </button>
      ))}
      {tasks.map((task) => (
        <button key={`${task.id}-complete`} onClick={() => onToggleComplete(task.id)}>
          complete {task.id}
        </button>
      ))}
      {tasks.map((task) => (
        <button key={`${task.id}-select`} onClick={() => onToggleSelect?.(task.id)}>
          select {task.id}
        </button>
      ))}
      <button onClick={() => onQuickAdd?.('Quick task', column.id)}>quick add {column.id}</button>
    </section>
  )
}))

vi.mock('./kanban-drag-overlay', () => ({
  KanbanDragOverlay: () => <div data-testid="kanban-overlay" />
}))

function task(id: string, title: string, statusId: string): Task {
  return {
    id,
    title,
    description: '',
    projectId: 'project-1',
    statusId,
    priority: 'none',
    dueDate: null,
    dueTime: null,
    isRepeating: false,
    repeatConfig: null,
    linkedNoteIds: [],
    sourceNoteId: null,
    parentId: null,
    subtaskIds: [],
    createdAt: new Date('2026-05-10T00:00:00.000Z'),
    completedAt: null,
    archivedAt: null
  }
}

const projects: Project[] = [
  {
    id: 'project-1',
    name: 'Work',
    description: '',
    icon: 'briefcase',
    color: '#2563eb',
    statuses: [
      { id: 'todo', name: 'To Do', color: '#6b7280', type: 'todo', order: 0 },
      { id: 'done', name: 'Done', color: '#10b981', type: 'done', order: 1 }
    ],
    isDefault: true,
    isArchived: false,
    createdAt: new Date('2026-05-10T00:00:00.000Z'),
    taskCount: 2
  }
]

function expectFocused(taskId: string) {
  expect(
    screen.getAllByText((_, node) => node?.textContent === `focused:${taskId}`).length
  ).toBeGreaterThan(0)
}

describe('KanbanBoard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders project kanban columns, orders tasks, and forwards column actions', () => {
    const onToggleComplete = vi.fn()
    const onTaskClick = vi.fn()
    const onQuickAdd = vi.fn()
    const onToggleSelect = vi.fn()
    const getOrderedTasks = vi.fn((_sectionId: string, tasks: Task[]) => [...tasks].reverse())

    render(
      <KanbanBoard
        tasks={[task('task-1', 'First task', 'todo'), task('task-2', 'Second task', 'todo')]}
        projects={projects}
        selectedId="project-1"
        selectedType="project"
        selectedProjectId="project-1"
        sortField="status"
        getOrderedTasks={getOrderedTasks}
        onUpdateTask={vi.fn()}
        onToggleComplete={onToggleComplete}
        onTaskClick={onTaskClick}
        onQuickAdd={onQuickAdd}
        isSelectionMode
        selectedIds={new Set(['task-1'])}
        onToggleSelect={onToggleSelect}
      />
    )

    expect(screen.getByLabelText('kanban.board')).toHaveFocus()
    expect(screen.getByTestId('column-todo')).toBeInTheDocument()
    expect(getOrderedTasks).toHaveBeenCalled()

    fireEvent.click(screen.getByText('Second task'))
    expect(onTaskClick).toHaveBeenCalledWith('task-2')

    fireEvent.click(screen.getByText('complete task-1'))
    expect(onToggleComplete).toHaveBeenCalledWith('task-1')

    fireEvent.click(screen.getByText('select task-1'))
    expect(onToggleSelect).toHaveBeenCalledWith('task-1')

    fireEvent.click(screen.getByText('quick add todo'))
    expect(onQuickAdd).toHaveBeenCalledWith('Quick task', 'todo')
  })

  it('supports keyboard focus navigation and activation across columns', () => {
    const onToggleComplete = vi.fn()
    const onTaskClick = vi.fn()

    render(
      <KanbanBoard
        tasks={[task('task-1', 'First task', 'todo'), task('task-2', 'Second task', 'done')]}
        projects={projects}
        selectedId="all"
        selectedType="view"
        selectedProjectId={null}
        sortField="status"
        onUpdateTask={vi.fn()}
        onToggleComplete={onToggleComplete}
        onTaskClick={onTaskClick}
      />
    )

    const board = screen.getByLabelText('kanban.board')
    fireEvent.keyDown(board, { key: 'j' })
    expectFocused('task-1')

    fireEvent.keyDown(board, { key: 'ArrowDown' })
    expectFocused('task-2')

    fireEvent.keyDown(board, { key: ' ' })
    expect(onToggleComplete).toHaveBeenCalledWith('task-2')

    fireEvent.keyDown(board, { key: 'Enter' })
    expect(onTaskClick).toHaveBeenCalledWith('task-2')

    fireEvent.keyDown(board, { key: 'Escape' })
    expectFocused('none')

    const input = document.createElement('input')
    board.appendChild(input)
    fireEvent.keyDown(input, { key: 'j' })
    expectFocused('none')
  })
})
