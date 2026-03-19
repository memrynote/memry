import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { Task, Priority } from '@/data/sample-tasks'
import type { Project, StatusType, Status } from '@/data/tasks-data'
import { KanbanCardContent } from './kanban-card'

vi.mock('@/contexts/drag-context', () => ({
  useDragContext: () => ({
    dragState: { lastDroppedId: null },
    setDragState: vi.fn(),
    resetDragState: vi.fn(),
    isMultiDrag: false,
    dragCount: 0
  })
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
})
