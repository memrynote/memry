import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

import { TaskSection } from './task-section'
import { DragProvider } from '@/contexts/drag-context'
import type { Task, Priority } from '@/data/sample-tasks'
import type { Project, StatusType, Status } from '@/data/tasks-data'

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

const project = createProject()
const tasks = [createTask()]

const renderWithDragProvider = (ui: React.ReactElement): ReturnType<typeof render> =>
  render(
    <DragProvider tasks={tasks} selectedIds={new Set()}>
      {ui}
    </DragProvider>
  )

describe('TaskSection', () => {
  const baseProps = {
    id: 'urgent',
    title: 'Urgent',
    count: 1,
    tasks,
    projects: [project],
    variant: 'default' as const,
    onToggleComplete: vi.fn()
  }

  it('renders section with title', () => {
    renderWithDragProvider(<TaskSection {...baseProps} />)

    const section = screen.getByRole('region')
    expect(section).toBeTruthy()
  })

  it('renders task rows inside sortable context', () => {
    renderWithDragProvider(<TaskSection {...baseProps} />)

    expect(screen.getByLabelText(/^Task: Test Task/)).toBeTruthy()
  })

  it('renders empty message when no tasks', () => {
    renderWithDragProvider(
      <TaskSection {...baseProps} tasks={[]} count={0} emptyMessage="Nothing here" />
    )

    expect(screen.getByText('Nothing here')).toBeTruthy()
  })

  it('renders add task button when showAddTask is true', () => {
    const onAddTask = vi.fn()
    renderWithDragProvider(
      <TaskSection {...baseProps} tasks={[]} count={0} showAddTask onAddTask={onAddTask} />
    )

    expect(screen.getByText('+ Add task')).toBeTruthy()
  })
})
