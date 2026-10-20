import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { TasksWidget } from './tasks-widget'
import { defaultSort } from '@/data/tasks-data'

const makeTask = (id: string, title: string) => ({
  id,
  title,
  description: '',
  projectId: 'p1',
  statusId: 's1',
  priority: 'none' as const,
  dueDate: null,
  dueTime: null,
  isRepeating: false,
  repeatConfig: null,
  linkedNoteIds: [],
  sourceNoteId: null,
  tags: [],
  parentId: null as string | null,
  subtaskIds: [] as string[],
  createdAt: new Date(),
  completedAt: null,
  archivedAt: null
})

const tasks = [
  makeTask('t1', 'Alpha'),
  makeTask('t2', 'Beta'),
  makeTask('t3', 'Gamma'),
  makeTask('t4', 'Delta')
]

let mockTasks = tasks
let mockSavedFilters: Array<{ id: string; name: string; filters: unknown; sort?: unknown }> = []

vi.mock('@/hooks/use-reminders', () => ({
  useNextTaskReminders: () => new Map<string, string>()
}))
vi.mock('@/features/tasks/use-task-queries', () => ({
  useTaskWorkspaceData: () => ({
    tasks: mockTasks,
    projects: [],
    isLoading: false,
    error: null
  }),
  useTaskWorkspaceMutations: () => ({ updateTask: vi.fn() })
}))

vi.mock('@/hooks/use-task-filters', () => ({
  useSavedFilters: () => ({ savedFilters: mockSavedFilters })
}))

const applyFiltersAndSort = vi.fn((input: typeof tasks) => input)
vi.mock('@/lib/task-utils/task-filters', () => ({
  applyFiltersAndSort: (...args: unknown[]) => applyFiltersAndSort(...(args as [typeof tasks]))
}))

vi.mock('@/hooks/use-task-note-index', () => ({
  useTaskNoteIndex: () => undefined
}))

vi.mock('@/lib/task-utils/task-view-helpers', () => ({
  getFilteredTasks: (input: typeof tasks) => input,
  getTasksInDueWindow: (input: typeof tasks) => input
}))

const openTaskDetail = vi.fn()
vi.mock('@/components/tasks/task-detail-host', () => ({
  openTaskInTasksTab: vi.fn(),
  useOpenTaskDetail: () => openTaskDetail
}))

vi.mock('@/contexts/tabs/context', () => ({
  useTabActions: () => ({ openTab: vi.fn() })
}))

describe('TasksWidget', () => {
  beforeEach(() => {
    mockTasks = tasks
    mockSavedFilters = []
    applyFiltersAndSort.mockClear()
    applyFiltersAndSort.mockImplementation((input: typeof tasks) => input)
  })

  it('lists tasks', () => {
    render(<TasksWidget config={{}} size="M" />)
    expect(screen.getByText('Alpha')).toBeInTheDocument()
    expect(screen.getByText('Beta')).toBeInTheDocument()
  })

  it('respects the size limit', () => {
    render(<TasksWidget config={{}} size="S" />)
    expect(screen.getAllByTestId('task-item')).toHaveLength(3)
  })

  it('renders an empty state when there are no tasks', () => {
    mockTasks = []
    render(<TasksWidget config={{}} size="M" />)
    expect(screen.getByText('No tasks yet.')).toBeInTheDocument()
  })

  it('renders the selected saved filter via applyFiltersAndSort', () => {
    mockSavedFilters = [{ id: 'sf1', name: 'Mine', filters: { search: 'beta' } }]
    applyFiltersAndSort.mockImplementation(() => [makeTask('t2', 'Beta')])
    render(<TasksWidget config={{ savedFilterId: 'sf1' }} size="M" />)
    expect(screen.getByText('Beta')).toBeInTheDocument()
    expect(screen.queryByText('Alpha')).not.toBeInTheDocument()
    expect(applyFiltersAndSort).toHaveBeenCalledWith(
      tasks,
      { search: 'beta' },
      defaultSort,
      [],
      expect.any(Date),
      undefined
    )
  })

  it('falls back to the today view when the saved filter is missing', () => {
    mockSavedFilters = []
    render(<TasksWidget config={{ savedFilterId: 'gone' }} size="M" />)
    expect(screen.getByText('Alpha')).toBeInTheDocument()
    expect(applyFiltersAndSort).not.toHaveBeenCalled()
  })

  it('ignores the saved-filter path when no savedFilterId is set', () => {
    mockSavedFilters = [{ id: 'sf1', name: 'Mine', filters: { search: 'beta' } }]
    render(<TasksWidget config={{}} size="M" />)
    expect(screen.getByText('Alpha')).toBeInTheDocument()
    expect(applyFiltersAndSort).not.toHaveBeenCalled()
  })

  it('opens the task detail in place when a row is clicked', () => {
    render(<TasksWidget config={{}} size="M" />)
    fireEvent.click(screen.getByText('Alpha'))
    expect(openTaskDetail).toHaveBeenCalledWith('t1')
  })

  describe('subtasks', () => {
    const parent = { ...makeTask('t1', 'Parent'), subtaskIds: ['t2'] }
    const child = { ...makeTask('t2', 'Child'), parentId: 't1' }

    beforeEach(() => {
      localStorage.clear()
      mockTasks = [parent, child]
    })

    it('expands under a parent, once, and the choice survives a remount', () => {
      const { unmount } = render(<TasksWidget config={{ dateRange: 'all' }} size="M" />)
      expect(screen.queryByText('Child')).not.toBeInTheDocument()
      expect(screen.getAllByTestId('task-item')).toHaveLength(1)

      fireEvent.click(screen.getByRole('button', { name: 'Expand subtasks' }))
      expect(screen.getByText('Child')).toBeInTheDocument()
      expect(screen.getAllByTestId('task-item')).toHaveLength(1)

      unmount()
      render(<TasksWidget config={{ dateRange: 'all' }} size="M" />)
      expect(screen.getByText('Child')).toBeInTheDocument()

      fireEvent.click(screen.getByRole('button', { name: 'Collapse subtasks' }))
      expect(screen.queryByText('Child')).not.toBeInTheDocument()
    })
  })
})
