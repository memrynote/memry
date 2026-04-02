import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TaskDetailDrawer, type TaskDetailDrawerProps } from './task-detail-drawer'
import type { Task, Priority, RepeatConfig } from '@/data/sample-tasks'
import type { Project, Status } from '@/data/tasks-data'

import { notesService } from '@/services/notes-service'

vi.mock('@/services/notes-service', () => ({
  notesService: {
    get: vi.fn().mockResolvedValue(null),
    list: vi.fn().mockResolvedValue({ notes: [] })
  }
}))

vi.mock('@/contexts/day-panel-context', () => ({
  useDayPanel: () => ({ isOpen: false, width: 320 })
}))

const statuses: Status[] = [
  { id: 'todo', name: 'To Do', color: '#6B7280', type: 'todo', order: 0 },
  { id: 'in-progress', name: 'In Progress', color: '#F59E0B', type: 'in_progress', order: 1 },
  { id: 'done', name: 'Done', color: '#10B981', type: 'done', order: 2 }
]

const project: Project = {
  id: 'project-1',
  name: 'Test Project',
  color: '#6366F1',
  statuses,
  isArchived: false
}

const createTask = (overrides: Partial<Task> = {}): Task => ({
  id: 'task-1',
  title: 'Test Task',
  description: '',
  projectId: 'project-1',
  statusId: 'todo',
  priority: 'medium' as Priority,
  dueDate: new Date('2026-04-15'),
  dueTime: null,
  isRepeating: false,
  repeatConfig: null,
  linkedNoteIds: [],
  sourceNoteId: null,
  parentId: null,
  subtaskIds: [],
  createdAt: new Date('2026-01-01'),
  completedAt: null,
  archivedAt: null,
  ...overrides
})

const project2: Project = {
  id: 'project-2',
  name: 'Work',
  color: '#EF4444',
  statuses: [
    { id: 'w-todo', name: 'Backlog', color: '#6B7280', type: 'todo', order: 0 },
    { id: 'w-done', name: 'Shipped', color: '#10B981', type: 'done', order: 1 }
  ],
  isArchived: false
}

const defaultProps: TaskDetailDrawerProps = {
  task: createTask(),
  isOpen: true,
  onClose: vi.fn(),
  tasks: [],
  projects: [project, project2],
  onToggleComplete: vi.fn(),
  onUpdateTask: vi.fn(),
  onAddSubtask: vi.fn()
}

describe('TaskDetailDrawer — editable properties', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('status editing', () => {
    it('renders InteractiveStatusBadge with current status', () => {
      render(<TaskDetailDrawer {...defaultProps} />)

      const statusBtn = screen.getByRole('button', { name: /status:.*click to change/i })
      expect(statusBtn).toBeInTheDocument()
    })

    it('calls onUpdateTask with new statusId when status changed', async () => {
      const user = userEvent.setup()
      render(<TaskDetailDrawer {...defaultProps} />)

      const statusBtn = screen.getByRole('button', { name: /status:.*click to change/i })
      await user.click(statusBtn)

      const inProgressOption = screen.getByText('In Progress')
      await user.click(inProgressOption)

      expect(defaultProps.onUpdateTask).toHaveBeenCalledWith('task-1', {
        statusId: 'in-progress'
      })
    })
  })

  describe('priority editing', () => {
    it('renders InteractivePriorityBadge with current priority', () => {
      render(<TaskDetailDrawer {...defaultProps} />)

      const priorityBtn = screen.getByRole('button', { name: /priority:.*click to change/i })
      expect(priorityBtn).toBeInTheDocument()
    })

    it('renders priority badge even when priority is none', () => {
      render(
        <TaskDetailDrawer {...defaultProps} task={createTask({ priority: 'none' as Priority })} />
      )

      const priorityBtn = screen.getByRole('button', { name: /priority:.*click to change/i })
      expect(priorityBtn).toBeInTheDocument()
    })

    it('calls onUpdateTask with new priority when changed', async () => {
      const user = userEvent.setup()
      render(<TaskDetailDrawer {...defaultProps} />)

      const priorityBtn = screen.getByRole('button', { name: /priority:.*click to change/i })
      await user.click(priorityBtn)

      const highOption = screen.getByText('High')
      await user.click(highOption)

      expect(defaultProps.onUpdateTask).toHaveBeenCalledWith('task-1', {
        priority: 'high'
      })
    })
  })

  describe('due date editing', () => {
    it('renders InteractiveDueDateBadge with current date', () => {
      render(<TaskDetailDrawer {...defaultProps} />)

      const dueDateBtn = screen.getByRole('button', { name: /due:.*click to change/i })
      expect(dueDateBtn).toBeInTheDocument()
    })

    it('renders due date badge even when no due date set', () => {
      render(<TaskDetailDrawer {...defaultProps} task={createTask({ dueDate: null })} />)

      const dueDateBtn = screen.getByRole('button', { name: /due:.*click to change/i })
      expect(dueDateBtn).toBeInTheDocument()
    })
  })

  describe('title editing', () => {
    it('renders editable input with task title', () => {
      render(<TaskDetailDrawer {...defaultProps} />)

      const titleInput = screen.getByPlaceholderText('Task name')
      expect(titleInput).toBeInTheDocument()
      expect(titleInput).toHaveValue('Test Task')
    })

    it('calls onUpdateTask with title update on typing', async () => {
      const user = userEvent.setup()
      const onUpdateTask = vi.fn()
      render(<TaskDetailDrawer {...defaultProps} onUpdateTask={onUpdateTask} />)

      const titleInput = screen.getByPlaceholderText('Task name')
      await user.type(titleInput, 'X')

      expect(onUpdateTask).toHaveBeenCalledWith(
        'task-1',
        expect.objectContaining({ title: expect.any(String) })
      )
    })
  })

  describe('description editing', () => {
    it('renders textarea even when description is empty', () => {
      render(<TaskDetailDrawer {...defaultProps} task={createTask({ description: '' })} />)

      const textarea = screen.getByPlaceholderText('Add a description...')
      expect(textarea).toBeInTheDocument()
      expect(textarea).toHaveValue('')
    })

    it('renders textarea with existing description', () => {
      render(
        <TaskDetailDrawer {...defaultProps} task={createTask({ description: 'Some notes here' })} />
      )

      const textarea = screen.getByPlaceholderText('Add a description...')
      expect(textarea).toHaveValue('Some notes here')
    })

    it('calls onUpdateTask with description update on typing', async () => {
      const user = userEvent.setup()
      const onUpdateTask = vi.fn()
      render(<TaskDetailDrawer {...defaultProps} onUpdateTask={onUpdateTask} />)

      const textarea = screen.getByPlaceholderText('Add a description...')
      await user.type(textarea, 'H')

      expect(onUpdateTask).toHaveBeenCalledWith(
        'task-1',
        expect.objectContaining({ description: expect.any(String) })
      )
    })
  })

  describe('project editing', () => {
    it('renders interactive project badge in properties grid', () => {
      render(<TaskDetailDrawer {...defaultProps} />)

      const projectBtn = screen.getByRole('button', { name: /project:.*click to change/i })
      expect(projectBtn).toBeInTheDocument()
    })

    it('shows project name and color indicator', () => {
      render(<TaskDetailDrawer {...defaultProps} />)

      const projectBtn = screen.getByRole('button', { name: /project:.*click to change/i })
      expect(projectBtn).toBeInTheDocument()
      expect(screen.getByText('Test Project')).toBeInTheDocument()
    })

    it('calls onUpdateTask with new projectId when project changed', async () => {
      const user = userEvent.setup()
      const onUpdateTask = vi.fn()
      render(<TaskDetailDrawer {...defaultProps} onUpdateTask={onUpdateTask} />)

      const projectBtn = screen.getByRole('button', { name: /project:.*click to change/i })
      await user.click(projectBtn)

      const workOption = screen.getByText('Work')
      await user.click(workOption)

      expect(onUpdateTask).toHaveBeenCalledWith('task-1', { projectId: 'project-2' })
    })

    it('shows Project label in properties grid row', () => {
      render(<TaskDetailDrawer {...defaultProps} />)

      expect(screen.getByText('Project')).toBeInTheDocument()
    })
  })

  describe('repeat section', () => {
    it('renders repeat section with add button for non-repeating task', () => {
      render(<TaskDetailDrawer {...defaultProps} />)

      expect(screen.getByText('Repeat')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /add repeat/i })).toBeInTheDocument()
    })

    it('renders repeat info for repeating task', () => {
      const repeatConfig: RepeatConfig = {
        frequency: 'weekly',
        interval: 1,
        daysOfWeek: [1],
        endType: 'never',
        completedCount: 2,
        createdAt: new Date('2026-01-01')
      }
      render(
        <TaskDetailDrawer
          {...defaultProps}
          task={createTask({ isRepeating: true, repeatConfig })}
        />
      )

      expect(screen.getByRole('button', { name: /edit/i })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /stop repeating/i })).toBeInTheDocument()
    })

    it('appears after sub-issues in DOM order', () => {
      render(<TaskDetailDrawer {...defaultProps} />)

      const subIssuesLabel = screen.getByText('Sub-issues')
      const repeatLabel = screen.getByText('Repeat')

      const result = subIssuesLabel.compareDocumentPosition(repeatLabel)
      const FOLLOWING = Node.DOCUMENT_POSITION_FOLLOWING
      expect(result & FOLLOWING).toBe(FOLLOWING)
    })
  })

  describe('delete task', () => {
    it('renders delete button when onDeleteTask is provided', () => {
      render(<TaskDetailDrawer {...defaultProps} onDeleteTask={vi.fn()} />)

      const deleteBtn = screen.getByRole('button', { name: /delete task/i })
      expect(deleteBtn).toBeInTheDocument()
    })

    it('does not render delete button when onDeleteTask is not provided', () => {
      render(<TaskDetailDrawer {...defaultProps} />)

      expect(screen.queryByRole('button', { name: /delete task/i })).not.toBeInTheDocument()
    })

    it('shows confirmation dialog when delete button clicked', async () => {
      const user = userEvent.setup()
      render(<TaskDetailDrawer {...defaultProps} onDeleteTask={vi.fn()} />)

      await user.click(screen.getByRole('button', { name: /delete task/i }))

      expect(screen.getByText('Delete task?')).toBeInTheDocument()
      expect(screen.getByText(/will be permanently deleted/)).toBeInTheDocument()
    })

    it('calls onDeleteTask with task id when deletion confirmed', async () => {
      const user = userEvent.setup()
      const onDeleteTask = vi.fn()
      render(<TaskDetailDrawer {...defaultProps} onDeleteTask={onDeleteTask} />)

      await user.click(screen.getByRole('button', { name: /delete task/i }))
      await user.click(screen.getByRole('button', { name: /^delete task$/i }))

      expect(onDeleteTask).toHaveBeenCalledWith('task-1')
    })

    it('does not call onDeleteTask when cancel is clicked', async () => {
      const user = userEvent.setup()
      const onDeleteTask = vi.fn()
      render(<TaskDetailDrawer {...defaultProps} onDeleteTask={onDeleteTask} />)

      await user.click(screen.getByRole('button', { name: /delete task/i }))
      await user.click(screen.getByRole('button', { name: /cancel/i }))

      expect(onDeleteTask).not.toHaveBeenCalled()
    })
  })

  describe('linked notes', () => {
    const mockNoteData = {
      id: 'note-1',
      title: 'My Note',
      emoji: '📝',
      content: '',
      folderId: null,
      createdAt: new Date(),
      modifiedAt: new Date(),
      isPinned: false,
      isStarred: false
    } as ReturnType<typeof notesService.get> extends Promise<infer T> ? T : never

    it('shows emoji instead of NoteIcon when note has emoji', async () => {
      vi.mocked(notesService.get).mockResolvedValueOnce(mockNoteData)

      render(
        <TaskDetailDrawer {...defaultProps} task={createTask({ linkedNoteIds: ['note-1'] })} />
      )

      const emoji = await screen.findByText('📝')
      expect(emoji).toBeInTheDocument()
    })

    it('shows remove button on hover and removes note when clicked', async () => {
      const user = userEvent.setup()
      const onUpdateTask = vi.fn()
      vi.mocked(notesService.get).mockResolvedValueOnce(mockNoteData)

      render(
        <TaskDetailDrawer
          {...defaultProps}
          onUpdateTask={onUpdateTask}
          task={createTask({ linkedNoteIds: ['note-1'] })}
        />
      )

      await screen.findByText('My Note')

      const removeBtn = screen.getByRole('button', { name: /remove link to/i })
      await user.click(removeBtn)

      expect(onUpdateTask).toHaveBeenCalledWith('task-1', { linkedNoteIds: [] })
    })

    it('calls onNoteClick when linked note row is clicked', async () => {
      const user = userEvent.setup()
      const onNoteClick = vi.fn()
      vi.mocked(notesService.get).mockResolvedValueOnce(mockNoteData)

      render(
        <TaskDetailDrawer
          {...defaultProps}
          onNoteClick={onNoteClick}
          task={createTask({ linkedNoteIds: ['note-1'] })}
        />
      )

      const noteRow = await screen.findByRole('button', { name: /remove link to/i })
      const row = noteRow.closest('[role="button"]')!
      await user.click(row)

      expect(onNoteClick).toHaveBeenCalledWith('note-1')
    })
  })
})
