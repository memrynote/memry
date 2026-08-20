import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ProjectWidget } from './project-widget'
import type { ProjectHubData } from '@/pages/project/use-project-hub'

const hubMock = vi.fn()

vi.mock('@/pages/project/use-project-hub', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/pages/project/use-project-hub')>()),
  useProjectHub: (projectId: string | undefined) => hubMock(projectId)
}))

// The handlers hook reaches into the tasks context, the tab context and the undo
// stack; none of that is what this suite is about.
vi.mock('./use-project-widget-handlers', () => ({
  useProjectWidgetHandlers: () => ({
    onGoToTab: vi.fn(),
    onOpenTask: vi.fn(),
    onStatusChange: vi.fn(),
    onToggleComplete: vi.fn(),
    onPriorityChange: vi.fn(),
    onOpenNote: vi.fn(),
    onNoteIconChange: vi.fn(),
    onOpenFile: vi.fn(),
    onOpenEvent: vi.fn(),
    onAddTask: vi.fn(),
    onAddNote: vi.fn(),
    onAddFile: vi.fn(),
    onAddEvent: vi.fn()
  })
}))

vi.mock('@/contexts/tabs', () => ({ useTabActions: () => ({ openTab: vi.fn() }) }))

// Tab bodies are the project page's own components with their own suites; stub
// them so this test exercises the widget's branching, not their internals.
vi.mock('@/pages/project/tabs/overview-tab', () => ({
  OverviewTab: () => <div data-testid="overview-body" />
}))
vi.mock('@/pages/project/tabs/list-tab', () => ({
  ListTab: (p: { kind: string }) => <div data-testid="list-body">{p.kind}</div>
}))
vi.mock('@/pages/project/rows/task-row', () => ({
  TaskRow: (p: { task: { title: string } }) => <div data-testid="task-row">{p.task.title}</div>
}))

const project = {
  id: 'p1',
  name: 'Redesign',
  icon: null,
  color: '#ff671a',
  isArchived: false,
  statuses: [{ id: 's1', name: 'Todo', color: '#888', type: 'todo', order: 0 }]
}

function mockHub(overrides: Partial<ProjectHubData> = {}): void {
  hubMock.mockReturnValue({
    project,
    tasks: [],
    notes: [],
    pinnedNotes: [],
    files: [],
    events: [],
    counts: { tasks: 2, notes: 1, files: 0, events: 3 },
    progress: { done: 0, total: 0, pct: 0, statuses: [], overdue: 0 },
    homeNoteId: null,
    createdAt: null,
    modifiedAt: null,
    isLoading: false,
    refresh: vi.fn(),
    setHomeNoteId: vi.fn(),
    ...overrides
  })
}

beforeEach(() => {
  hubMock.mockReset()
  mockHub()
})

describe('ProjectWidget', () => {
  it('prompts for a project when none is configured', () => {
    render(<ProjectWidget config={{}} size="M" />)
    expect(screen.queryByTestId('project-widget-tabs')).not.toBeInTheDocument()
    expect(screen.queryByTestId('project-widget-missing')).not.toBeInTheDocument()
  })

  it('does not resolve a hub for an unconfigured widget', () => {
    render(<ProjectWidget config={{}} size="M" />)
    expect(hubMock).toHaveBeenCalledWith(undefined)
  })

  it('shows a skeleton while the configured project is still resolving', () => {
    mockHub({ project: null, isLoading: true })
    render(<ProjectWidget config={{ projectId: 'p1' }} size="M" />)
    expect(screen.getByLabelText(/loading/i)).toBeInTheDocument()
    expect(screen.queryByTestId('project-widget-missing')).not.toBeInTheDocument()
  })

  // Boards sync, so a project deleted or archived on one device leaves a widget
  // pointing at nothing on another. The widget must say so and stay put.
  it('reports a project that no longer exists instead of removing itself', () => {
    mockHub({ project: null, isLoading: false })
    render(<ProjectWidget config={{ projectId: 'gone' }} size="M" />)
    expect(screen.getByTestId('project-widget-missing')).toBeInTheDocument()
  })

  it('opens on Overview and switches tabs locally', async () => {
    const user = userEvent.setup()
    render(<ProjectWidget config={{ projectId: 'p1' }} size="M" />)

    expect(screen.getByTestId('overview-body')).toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: /notes/i }))
    expect(screen.getByTestId('list-body')).toHaveTextContent('notes')
    expect(screen.queryByTestId('overview-body')).not.toBeInTheDocument()
  })

  it('renders per-tab counts, and none for Overview', () => {
    render(<ProjectWidget config={{ projectId: 'p1' }} size="M" />)
    expect(screen.getByRole('tab', { name: /events/i })).toHaveTextContent('3')
    expect(screen.getByRole('tab', { name: /overview/i })).not.toHaveTextContent(/\d/)
  })

  it('renders plain task rows rather than the page virtualized list', async () => {
    const user = userEvent.setup()
    mockHub({ tasks: [{ id: 't1', title: 'Ship it', statusId: 's1' }] as never })
    render(<ProjectWidget config={{ projectId: 'p1' }} size="M" />)

    await user.click(screen.getByRole('tab', { name: /tasks/i }))
    expect(screen.getByTestId('task-row')).toHaveTextContent('Ship it')
  })
})
