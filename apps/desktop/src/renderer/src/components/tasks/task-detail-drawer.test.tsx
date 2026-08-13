import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nextProvider } from 'react-i18next'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { i18n as I18nInstance } from 'i18next'
import type { ReactElement, ReactNode } from 'react'
import { createRendererI18n } from '@memry/i18n/renderer'
import { TaskDetailDrawer, type TaskDetailDrawerProps } from './task-detail-drawer'
import type { Task, Priority, RepeatConfig } from '@/data/task-model'
import type { Project, Status } from '@/data/tasks-data'

import { notesService } from '@/services/notes-service'

vi.mock('@/services/notes-service', () => ({
  notesService: {
    get: vi.fn().mockResolvedValue(null),
    getFile: vi.fn().mockResolvedValue(null),
    list: vi.fn().mockResolvedValue({ notes: [] })
  }
}))

vi.mock('@/contexts/day-panel-context', () => ({
  useDayPanel: () => ({ isOpen: false, width: 320 })
}))

vi.mock('@/components/tasks/task-reminder-button', () => ({
  TaskReminderButton: () => null
}))

// BlockNote can't mount in jsdom; stub the description editor with a textarea.
vi.mock('@/components/tasks/task-description-editor', () => ({
  TaskDescriptionEditor: ({
    initialContent,
    onContentChange,
    placeholder
  }: {
    initialContent: string | null
    onContentChange?: (markdown: string) => void
    placeholder?: string
  }) => (
    <textarea
      placeholder={placeholder}
      defaultValue={initialContent ?? ''}
      onChange={(event) => onContentChange?.(event.target.value)}
    />
  )
}))

// TagAutocomplete fetches its own tag data (useAllTags/useTags: react-query +
// window.api). The drawer only cares that it wires tags/onTagsChange through
// to the drawer's update handler, so stub it here — its own behavior is
// covered by tag-autocomplete.test.tsx.
vi.mock('@/components/filing/tag-autocomplete', () => ({
  TagAutocomplete: ({
    tags,
    onTagsChange,
    placeholder
  }: {
    tags: string[]
    onTagsChange: (tags: string[]) => void
    placeholder?: string
  }) => (
    <div>
      <span data-testid="tag-autocomplete-tags">{tags.join(',')}</span>
      <button type="button" onClick={() => onTagsChange([...tags, 'new-tag'])}>
        {placeholder}
      </button>
    </div>
  )
}))

let i18nEn: I18nInstance

function renderWithI18n(ui: ReactElement) {
  // The drawer's Activity section reads through react-query, so the tree needs
  // a client. Retries off so a failed IPC stub surfaces immediately instead of
  // being retried past the test's timeout.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } }
  })
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18nEn}>{children}</I18nextProvider>
    </QueryClientProvider>
  )
  return render(ui, { wrapper: Wrapper })
}

beforeAll(async () => {
  i18nEn = await createRendererI18n({ locale: 'en' })
})

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
  tags: [],
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

  it('renders the task drawer at the default 266px width', () => {
    renderWithI18n(<TaskDetailDrawer {...defaultProps} />)

    const drawer = screen.getByRole('complementary')
    expect(drawer).toHaveStyle({ width: '266px' })
    expect(drawer.firstElementChild).toHaveStyle({ width: '266px' })
  })

  describe('status editing', () => {
    it('renders InteractiveStatusBadge with current status', () => {
      renderWithI18n(<TaskDetailDrawer {...defaultProps} />)

      const statusBtn = screen.getByRole('button', { name: /status:.*click to change/i })
      expect(statusBtn).toBeInTheDocument()
    })

    it('calls onUpdateTask with new statusId when status changed', async () => {
      const user = userEvent.setup()
      renderWithI18n(<TaskDetailDrawer {...defaultProps} />)

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
      renderWithI18n(<TaskDetailDrawer {...defaultProps} />)

      const priorityBtn = screen.getByRole('button', { name: /priority:.*click to change/i })
      expect(priorityBtn).toBeInTheDocument()
    })

    it('renders priority badge even when priority is none', () => {
      renderWithI18n(
        <TaskDetailDrawer {...defaultProps} task={createTask({ priority: 'none' as Priority })} />
      )

      const priorityBtn = screen.getByRole('button', { name: /priority:.*click to change/i })
      expect(priorityBtn).toBeInTheDocument()
    })

    it('calls onUpdateTask with new priority when changed', async () => {
      const user = userEvent.setup()
      renderWithI18n(<TaskDetailDrawer {...defaultProps} />)

      const priorityBtn = screen.getByRole('button', { name: /priority:.*click to change/i })
      await user.click(priorityBtn)

      const highOption = screen.getByText('High')
      await user.click(highOption)

      expect(defaultProps.onUpdateTask).toHaveBeenCalledWith('task-1', {
        priority: 'high'
      })
    })
  })

  describe('tag editing', () => {
    it('renders TagAutocomplete with the task current tags', () => {
      renderWithI18n(
        <TaskDetailDrawer {...defaultProps} task={createTask({ tags: ['work', 'urgent'] })} />
      )

      expect(screen.getByTestId('tag-autocomplete-tags')).toHaveTextContent('work,urgent')
    })

    it('calls onUpdateTask with new tags when tags changed', async () => {
      const user = userEvent.setup()
      const onUpdateTask = vi.fn()
      renderWithI18n(
        <TaskDetailDrawer
          {...defaultProps}
          onUpdateTask={onUpdateTask}
          task={createTask({ tags: ['work'] })}
        />
      )

      await user.click(screen.getByRole('button', { name: 'Tags' }))

      expect(onUpdateTask).toHaveBeenCalledWith('task-1', { tags: ['work', 'new-tag'] })
    })
  })

  describe('due date editing', () => {
    it('renders InteractiveDueDateBadge with current date', () => {
      renderWithI18n(<TaskDetailDrawer {...defaultProps} />)

      const dueDateBtn = screen.getByRole('button', { name: /due:.*click to change/i })
      expect(dueDateBtn).toBeInTheDocument()
    })

    it('renders due date badge even when no due date set', () => {
      renderWithI18n(<TaskDetailDrawer {...defaultProps} task={createTask({ dueDate: null })} />)

      const dueDateBtn = screen.getByRole('button', { name: /due:.*click to change/i })
      expect(dueDateBtn).toBeInTheDocument()
    })
  })

  describe('title editing', () => {
    it('renders editable input with task title', () => {
      renderWithI18n(<TaskDetailDrawer {...defaultProps} />)

      const titleInput = screen.getByPlaceholderText('Task name')
      expect(titleInput).toBeInTheDocument()
      expect(titleInput).toHaveValue('Test Task')
    })

    it('calls onUpdateTask with title update on typing', async () => {
      const user = userEvent.setup()
      const onUpdateTask = vi.fn()
      renderWithI18n(<TaskDetailDrawer {...defaultProps} onUpdateTask={onUpdateTask} />)

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
      renderWithI18n(<TaskDetailDrawer {...defaultProps} task={createTask({ description: '' })} />)

      const textarea = screen.getByPlaceholderText('Add a description…')
      expect(textarea).toBeInTheDocument()
      expect(textarea).toHaveValue('')
    })

    it('renders textarea with existing description', () => {
      renderWithI18n(
        <TaskDetailDrawer {...defaultProps} task={createTask({ description: 'Some notes here' })} />
      )

      const textarea = screen.getByPlaceholderText('Add a description…')
      expect(textarea).toHaveValue('Some notes here')
    })

    it('calls onUpdateTask with description update on typing', async () => {
      const user = userEvent.setup()
      const onUpdateTask = vi.fn()
      renderWithI18n(<TaskDetailDrawer {...defaultProps} onUpdateTask={onUpdateTask} />)

      const textarea = screen.getByPlaceholderText('Add a description…')
      await user.type(textarea, 'H')

      // Persistence is debounced, so wait for the update to flush.
      await waitFor(() =>
        expect(onUpdateTask).toHaveBeenCalledWith(
          'task-1',
          expect.objectContaining({ description: expect.any(String) })
        )
      )
    })
  })

  describe('project editing', () => {
    it('renders interactive project badge in properties grid', () => {
      renderWithI18n(<TaskDetailDrawer {...defaultProps} />)

      const projectBtn = screen.getByRole('button', { name: /project:.*click to change/i })
      expect(projectBtn).toBeInTheDocument()
    })

    it('shows project name and color indicator', () => {
      renderWithI18n(<TaskDetailDrawer {...defaultProps} />)

      const projectBtn = screen.getByRole('button', { name: /project:.*click to change/i })
      expect(projectBtn).toBeInTheDocument()
      expect(screen.getByText('Test Project')).toBeInTheDocument()
    })

    it('calls onUpdateTask with new projectId when project changed', async () => {
      const user = userEvent.setup()
      const onUpdateTask = vi.fn()
      renderWithI18n(<TaskDetailDrawer {...defaultProps} onUpdateTask={onUpdateTask} />)

      const projectBtn = screen.getByRole('button', { name: /project:.*click to change/i })
      await user.click(projectBtn)

      const workOption = screen.getByText('Work')
      await user.click(workOption)

      expect(onUpdateTask).toHaveBeenCalledWith('task-1', { projectId: 'project-2' })
    })

    it('shows Project label in properties grid row', () => {
      renderWithI18n(<TaskDetailDrawer {...defaultProps} />)

      expect(screen.getByText('Project')).toBeInTheDocument()
    })
  })

  describe('repeat section', () => {
    it('renders repeat section with add button for non-repeating task', () => {
      renderWithI18n(<TaskDetailDrawer {...defaultProps} />)

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
      renderWithI18n(
        <TaskDetailDrawer
          {...defaultProps}
          task={createTask({ isRepeating: true, repeatConfig })}
        />
      )

      expect(screen.getByRole('button', { name: /edit/i })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /stop repeating/i })).toBeInTheDocument()
    })

    it('appears after sub-issues in DOM order', () => {
      renderWithI18n(<TaskDetailDrawer {...defaultProps} />)

      const subIssuesLabel = screen.getByText('Sub-issues')
      const repeatLabel = screen.getByText('Repeat')

      const result = subIssuesLabel.compareDocumentPosition(repeatLabel)
      const FOLLOWING = Node.DOCUMENT_POSITION_FOLLOWING
      expect(result & FOLLOWING).toBe(FOLLOWING)
    })
  })

  describe('delete task', () => {
    it('renders delete button when onDeleteTask is provided', () => {
      renderWithI18n(<TaskDetailDrawer {...defaultProps} onDeleteTask={vi.fn()} />)

      const deleteBtn = screen.getByRole('button', { name: /delete task/i })
      expect(deleteBtn).toBeInTheDocument()
    })

    it('does not render delete button when onDeleteTask is not provided', () => {
      renderWithI18n(<TaskDetailDrawer {...defaultProps} />)

      expect(screen.queryByRole('button', { name: /delete task/i })).not.toBeInTheDocument()
    })

    it('shows confirmation dialog when delete button clicked', async () => {
      const user = userEvent.setup()
      renderWithI18n(<TaskDetailDrawer {...defaultProps} onDeleteTask={vi.fn()} />)

      await user.click(screen.getByRole('button', { name: /delete task/i }))

      expect(screen.getByText('Delete task?')).toBeInTheDocument()
      expect(
        screen.getByText('“Test Task” will be permanently deleted. This action cannot be undone.')
      ).toBeInTheDocument()
    })

    it('calls onDeleteTask with task id when deletion confirmed', async () => {
      const user = userEvent.setup()
      const onDeleteTask = vi.fn()
      renderWithI18n(<TaskDetailDrawer {...defaultProps} onDeleteTask={onDeleteTask} />)

      await user.click(screen.getByRole('button', { name: /delete task/i }))
      await user.click(screen.getByRole('button', { name: /^delete task$/i }))

      expect(onDeleteTask).toHaveBeenCalledWith('task-1')
    })

    it('does not call onDeleteTask when cancel is clicked', async () => {
      const user = userEvent.setup()
      const onDeleteTask = vi.fn()
      renderWithI18n(<TaskDetailDrawer {...defaultProps} onDeleteTask={onDeleteTask} />)

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

      renderWithI18n(
        <TaskDetailDrawer {...defaultProps} task={createTask({ linkedNoteIds: ['note-1'] })} />
      )

      const emoji = await screen.findByText('📝')
      expect(emoji).toBeInTheDocument()
    })

    it('labels note links as related items', () => {
      renderWithI18n(<TaskDetailDrawer {...defaultProps} task={createTask()} />)

      expect(screen.getByText('Related')).toBeInTheDocument()
      expect(screen.getByText('No related items yet')).toBeInTheDocument()
      expect(screen.queryByText('Linked Notes')).not.toBeInTheDocument()
    })

    it('shows remove button on hover and removes note when clicked', async () => {
      const user = userEvent.setup()
      const onUpdateTask = vi.fn()
      vi.mocked(notesService.get).mockResolvedValueOnce(mockNoteData)

      renderWithI18n(
        <TaskDetailDrawer
          {...defaultProps}
          onUpdateTask={onUpdateTask}
          task={createTask({ linkedNoteIds: ['note-1'] })}
        />
      )

      await screen.findByText('My Note')

      const removeBtn = screen.getByRole('button', { name: /remove related item/i })
      await user.click(removeBtn)

      expect(onUpdateTask).toHaveBeenCalledWith('task-1', { linkedNoteIds: [] })
    })

    it('calls onNoteClick when linked note row is clicked', async () => {
      const user = userEvent.setup()
      const onNoteClick = vi.fn()
      vi.mocked(notesService.get).mockResolvedValueOnce(mockNoteData)

      renderWithI18n(
        <TaskDetailDrawer
          {...defaultProps}
          onNoteClick={onNoteClick}
          task={createTask({ linkedNoteIds: ['note-1'] })}
        />
      )

      const noteRow = await screen.findByRole('button', { name: /remove related item/i })
      const row = noteRow.closest('[role="button"]')!
      await user.click(row)

      expect(onNoteClick).toHaveBeenCalledWith('note-1')
    })

    it('searches notes, links a selected note, removes fallback-note rows, and supports keyboard open', async () => {
      const user = userEvent.setup()
      const onUpdateTask = vi.fn()
      const onNoteClick = vi.fn()
      vi.mocked(notesService.get).mockRejectedValueOnce(new Error('missing note'))
      vi.mocked(notesService.list).mockResolvedValueOnce({
        notes: [
          { id: 'note-2', title: 'Second Note', emoji: null },
          { id: 'note-3', title: 'Third Note', emoji: 'T' }
        ]
      } as never)

      renderWithI18n(
        <TaskDetailDrawer
          {...defaultProps}
          task={createTask({ linkedNoteIds: ['note-1'] })}
          onUpdateTask={onUpdateTask}
          onNoteClick={onNoteClick}
        />
      )

      await screen.findByText('Loading…')
      fireEvent.keyDown(screen.getByText('Loading…').closest('[role="button"]')!, { key: 'Enter' })
      expect(onNoteClick).toHaveBeenCalledWith('note-1')

      await user.click(screen.getByRole('button', { name: /add related item/i }))
      await screen.findByPlaceholderText('Search related…')
      await user.type(screen.getByPlaceholderText('Search related…'), 'third')
      await user.click(await screen.findByText('Third Note'))

      expect(onUpdateTask).toHaveBeenCalledWith('task-1', {
        linkedNoteIds: ['note-1', 'note-3']
      })
    })
  })

  describe('subtasks and keyboard dismissal', () => {
    it('adds subtasks, toggles existing subtasks, and handles Escape states', async () => {
      const user = userEvent.setup()
      const onAddSubtask = vi.fn()
      const onToggleComplete = vi.fn()
      const onClose = vi.fn()
      vi.mocked(notesService.list).mockResolvedValueOnce({ notes: [] } as never)
      const parentTask = createTask({ subtaskIds: ['sub-1'] })
      const subtask = createTask({
        id: 'sub-1',
        title: 'Existing subtask',
        statusId: 'done',
        completedAt: new Date('2026-05-10')
      })

      renderWithI18n(
        <TaskDetailDrawer
          {...defaultProps}
          onAddSubtask={onAddSubtask}
          onToggleComplete={onToggleComplete}
          onClose={onClose}
          tasks={[parentTask, subtask]}
          task={parentTask}
        />
      )

      await user.click(screen.getByText('Existing subtask'))
      expect(onToggleComplete).toHaveBeenCalledWith('sub-1')

      await user.click(screen.getByRole('button', { name: /add sub-issue/i }))
      const subtaskInput = screen.getByPlaceholderText('Add sub-issue…')
      await user.type(subtaskInput, 'New subtask{enter}')
      expect(onAddSubtask).toHaveBeenCalledWith('task-1', 'New subtask')

      await user.click(screen.getByRole('button', { name: /add related item/i }))
      fireEvent.keyDown(document, { key: 'Escape' })
      expect(screen.queryByPlaceholderText('Search related…')).not.toBeInTheDocument()

      fireEvent.keyDown(document, { key: 'Escape' })
      expect(onClose).toHaveBeenCalled()
    })
  })
})
