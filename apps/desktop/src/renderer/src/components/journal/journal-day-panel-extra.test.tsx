import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { JournalDayPanel } from './journal-day-panel'

const mocks = vi.hoisted(() => ({
  openTab: vi.fn(),
  invalidateQueries: vi.fn(),
  complete: vi.fn(),
  uncomplete: vi.fn(),
  update: vi.fn(),
  scheduleItems: [] as any[],
  tasks: [] as any[],
  overdueCount: 0
}))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values ? `${key}:${JSON.stringify(values)}` : key,
    i18n: { language: 'en-US' }
  })
}))

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: mocks.invalidateQueries }),
  useQuery: ({ queryKey }: { queryKey: unknown[] }) =>
    queryKey.includes('overdue-count') ? { data: mocks.overdueCount } : { data: mocks.tasks }
}))

vi.mock('@/hooks/use-calendar-range', () => ({
  useCalendarRange: () => ({ items: mocks.scheduleItems })
}))

vi.mock('@/services/tasks-service', () => ({
  tasksService: {
    complete: mocks.complete,
    uncomplete: mocks.uncomplete,
    update: mocks.update,
    list: vi.fn(),
    getStats: vi.fn()
  },
  onTaskCreated: (cb: () => void) => {
    cb()
    return vi.fn()
  },
  onTaskUpdated: () => vi.fn(),
  onTaskDeleted: () => vi.fn(),
  onTaskCompleted: () => vi.fn()
}))

vi.mock('@/contexts/tasks', () => ({
  useTasksContext: () => ({
    projects: [
      {
        id: 'project-1',
        statuses: [
          { id: 'todo', type: 'todo', name: 'Todo', color: '#888888' },
          { id: 'done', type: 'done', name: 'Done', color: '#00aa00' }
        ]
      }
    ]
  })
}))

vi.mock('@/contexts/tabs', () => ({
  useTabActions: () => ({ openTab: mocks.openTab })
}))

vi.mock('@/hooks/use-general-settings', () => ({
  useGeneralSettings: () => ({ settings: { clockFormat: '24h' } })
}))

vi.mock('@/components/tasks/inline-status-popover', () => ({
  InlineStatusPopover: ({ onToggleComplete, onStatusChange }: any) => (
    <div>
      <button type="button" onClick={onToggleComplete}>
        toggle status
      </button>
      <button type="button" onClick={() => onStatusChange('done')}>
        set done
      </button>
    </div>
  )
}))

vi.mock('@/components/tasks/inline-priority-popover', () => ({
  InlinePriorityPopover: ({ onPriorityChange }: any) => (
    <button type="button" onClick={() => onPriorityChange('urgent')}>
      set urgent
    </button>
  )
}))

vi.mock('@/components/tasks/subtask-progress-indicator', () => ({
  SubtaskProgressIndicator: ({ completed, total }: { completed: number; total: number }) => (
    <span>
      subtasks:{completed}/{total}
    </span>
  )
}))

describe('JournalDayPanel extra coverage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.overdueCount = 2
    mocks.scheduleItems = [
      {
        projectionId: 'event:1',
        visualType: 'event',
        startAt: '2026-05-10T09:00:00.000Z',
        endAt: '2026-05-10T10:30:00.000Z',
        isAllDay: false,
        title: 'Planning',
        source: { provider: null },
        snoozeOffsetMinutes: null
      },
      {
        projectionId: 'external:1',
        visualType: 'external_event',
        startAt: '2026-05-10T11:00:00.000Z',
        endAt: '2026-05-11T11:30:00.000Z',
        isAllDay: false,
        title: 'Partner call',
        source: { provider: 'google' },
        snoozeOffsetMinutes: null
      },
      {
        projectionId: 'reminder:1',
        visualType: 'reminder',
        startAt: '2026-05-10T12:00:00.000Z',
        endAt: null,
        isAllDay: true,
        title: 'Take medicine',
        source: { provider: null },
        snoozeOffsetMinutes: -90
      },
      {
        projectionId: 'snooze:1',
        visualType: 'snooze',
        startAt: '2026-05-10T13:00:00.000Z',
        endAt: null,
        isAllDay: false,
        title: 'Review inbox',
        source: { provider: null },
        snoozeOffsetMinutes: null
      },
      {
        projectionId: 'task:ignored',
        visualType: 'task',
        startAt: '2026-05-10T13:00:00.000Z',
        endAt: null,
        isAllDay: false,
        title: 'Filtered task',
        source: { provider: null },
        snoozeOffsetMinutes: null
      }
    ]
    mocks.tasks = [
      {
        id: 'task-1',
        projectId: 'project-1',
        statusId: 'todo',
        priority: 4,
        completedAt: null,
        title: 'Ship tests',
        subtaskCount: 3,
        completedSubtaskCount: 1
      },
      {
        id: 'task-2',
        projectId: 'project-1',
        statusId: 'done',
        priority: 0,
        completedAt: '2026-05-10T12:00:00.000Z',
        title: 'Done task',
        subtaskCount: 0,
        completedSubtaskCount: 0
      }
    ]
  })

  it('renders schedule/task rows and drives task/navigation actions', () => {
    const onHoverColor = vi.fn()
    render(<JournalDayPanel date="2026-05-10" onHoverColor={onHoverColor} />)

    expect(screen.getByText('Planning')).toBeInTheDocument()
    expect(screen.getByText('Partner call')).toBeInTheDocument()
    expect(screen.getByText('Take medicine')).toBeInTheDocument()
    expect(screen.getByText('-1h30m')).toBeInTheDocument()
    expect(screen.getByText('Ship tests')).toBeInTheDocument()
    expect(screen.getByText('subtasks:1/3')).toBeInTheDocument()

    fireEvent.mouseEnter(screen.getByText('Planning').closest('div')!)
    expect(onHoverColor).toHaveBeenCalled()

    fireEvent.click(screen.getAllByRole('button', { name: 'toggle status' })[0])
    expect(mocks.complete).toHaveBeenCalledWith({ id: 'task-1' })

    fireEvent.click(screen.getAllByRole('button', { name: 'toggle status' })[1])
    expect(mocks.uncomplete).toHaveBeenCalledWith('task-2')

    fireEvent.click(screen.getAllByRole('button', { name: 'set done' })[0])
    expect(mocks.update).toHaveBeenCalledWith({ id: 'task-1', statusId: 'done' })

    fireEvent.click(screen.getAllByRole('button', { name: 'set urgent' })[0])
    expect(mocks.update).toHaveBeenCalledWith({ id: 'task-1', priority: 4 })

    fireEvent.click(screen.getByText('Ship tests'))
    expect(mocks.openTab).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'tasks',
        viewState: { openTaskId: 'task-1', selectedProjectId: 'project-1' }
      })
    )

    fireEvent.click(screen.getByRole('button', { name: /count.overdue/ }))
    expect(mocks.openTab).toHaveBeenCalledWith(expect.objectContaining({ type: 'tasks' }))
  })

  it('returns null without content and collapses populated content from the header', () => {
    mocks.scheduleItems = []
    mocks.tasks = []
    const { container, rerender } = render(<JournalDayPanel date="2026-05-11" />)
    expect(container).toBeEmptyDOMElement()

    mocks.scheduleItems = [
      {
        projectionId: 'event:1',
        visualType: 'event',
        startAt: '2026-05-11T09:00:00.000Z',
        endAt: null,
        isAllDay: false,
        title: 'Only event',
        source: { provider: null },
        snoozeOffsetMinutes: null
      }
    ]
    rerender(<JournalDayPanel date="2026-05-11" />)
    expect(screen.getByText('Only event')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /May/ }))
    expect(screen.queryByText('Only event')).not.toBeInTheDocument()
  })
})
