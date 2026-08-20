import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
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
  parentId: null,
  subtaskIds: [],
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

vi.mock('@/lib/task-utils/task-view-helpers', () => ({
  getFilteredTasks: (input: typeof tasks) => input,
  getTasksInDueWindow: (input: typeof tasks) => input
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
    expect(applyFiltersAndSort).toHaveBeenCalledWith(tasks, { search: 'beta' }, defaultSort, [])
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
})
