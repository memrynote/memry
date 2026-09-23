import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithProviders } from '@tests/utils/render'
import { I18nextProvider } from 'react-i18next'
import type { i18n as I18nInstance } from 'i18next'
import type { ReactElement } from 'react'
import { createRendererI18n } from '@memry/i18n/renderer'
import { localDayRange } from '@/lib/local-day-range'
import { JournalDayPanel } from './journal-day-panel'
import type { CalendarProjectionItem } from '@/services/calendar-service'

const {
  mockUseCalendarRange,
  mockListTasks,
  mockGetStats,
  mockCreateTask,
  mockResolveProject,
  mockOpenTab,
  mockUseDraggable
} = vi.hoisted(() => ({
  mockUseCalendarRange: vi.fn(),
  mockListTasks: vi.fn(),
  mockGetStats: vi.fn(),
  mockCreateTask: vi.fn(),
  mockResolveProject: vi.fn(),
  mockOpenTab: vi.fn(),
  mockUseDraggable: vi.fn((_config: unknown) => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    isDragging: false
  }))
}))

vi.mock('@dnd-kit/core', () => ({
  useDraggable: mockUseDraggable
}))

vi.mock('@/hooks/use-calendar-range', () => ({
  useCalendarRange: mockUseCalendarRange
}))

vi.mock('@/services/tasks-service', () => ({
  tasksService: {
    list: mockListTasks,
    getStats: mockGetStats,
    create: mockCreateTask
  },
  onTaskCreated: vi.fn(() => () => {}),
  onTaskUpdated: vi.fn(() => () => {}),
  onTaskDeleted: vi.fn(() => () => {}),
  onTaskCompleted: vi.fn(() => () => {})
}))

vi.mock('@/contexts/tasks', () => ({
  useTasksContext: () => ({
    projects: [
      {
        id: 'project-1',
        name: 'Personal',
        description: '',
        icon: 'folder',
        color: '#3b82f6',
        statuses: [
          { id: 'todo', name: 'To Do', color: '#6b7280', type: 'todo', order: 0 },
          { id: 'done', name: 'Done', color: '#10b981', type: 'done', order: 1 }
        ],
        isDefault: true,
        isArchived: false,
        createdAt: new Date('2026-04-12T08:00:00.000Z'),
        taskCount: 0
      }
    ]
  })
}))

vi.mock('@/contexts/tabs', () => ({
  useTabActions: () => ({
    openTab: mockOpenTab
  })
}))

vi.mock('@/lib/note-task-project', () => ({
  resolveProjectIdForNoteTask: mockResolveProject
}))

const SAMPLE_ITEMS: CalendarProjectionItem[] = [
  {
    projectionId: 'event:event-1',
    sourceType: 'event',
    sourceId: 'event-1',
    title: 'Customer call',
    descriptionPreview: 'Imported from Google',
    startAt: '2026-04-14T09:00:00.000Z',
    endAt: '2026-04-14T10:00:00.000Z',
    isAllDay: false,
    timezone: 'UTC',
    visualType: 'event',
    editability: { canMove: true, canResize: true, canEditText: true, canDelete: true },
    source: {
      provider: 'google',
      calendarSourceId: 'google-work',
      title: 'Work',
      color: '#2563eb',
      kind: 'calendar',
      isMemryManaged: false
    },
    binding: null,
    snoozeOffsetMinutes: null
  },
  {
    projectionId: 'reminder:reminder-1',
    sourceType: 'reminder',
    sourceId: 'reminder-1',
    title: 'Medication reminder',
    descriptionPreview: null,
    startAt: '2026-04-14T17:00:00.000Z',
    endAt: null,
    isAllDay: false,
    timezone: 'UTC',
    visualType: 'reminder',
    editability: { canMove: true, canResize: false, canEditText: false, canDelete: true },
    source: {
      provider: null,
      calendarSourceId: null,
      title: 'memrynote Reminders',
      color: null,
      kind: null,
      isMemryManaged: true
    },
    binding: null,
    snoozeOffsetMinutes: null
  }
]

let i18nInstance: I18nInstance

function renderPanel(ui: ReactElement) {
  return renderWithProviders(<I18nextProvider i18n={i18nInstance}>{ui}</I18nextProvider>)
}

describe('JournalDayPanel', () => {
  beforeAll(async () => {
    i18nInstance = await createRendererI18n({ locale: 'en' })
  })

  beforeEach(() => {
    mockUseCalendarRange.mockReset()
    mockListTasks.mockReset()
    mockGetStats.mockReset()
    mockOpenTab.mockReset()
    mockCreateTask.mockReset()
    mockResolveProject.mockReset()
    mockUseDraggable.mockClear()

    mockUseCalendarRange.mockReturnValue({
      data: { items: SAMPLE_ITEMS },
      items: SAMPLE_ITEMS,
      isLoading: false,
      isFetching: false,
      error: null
    })
    mockListTasks.mockResolvedValue({ tasks: [] })
    mockGetStats.mockResolvedValue({ overdue: 0 })
  })

  it('uses projected calendar items for the schedule instead of placeholder events', async () => {
    renderPanel(<JournalDayPanel date="2026-04-14" />)

    await waitFor(() =>
      expect(mockUseCalendarRange).toHaveBeenCalledWith(
        // Through the helper the panel uses, not literal instants: the window is the local
        // day, so its UTC form moves with the machine's zone (#1954).
        expect.objectContaining(localDayRange('2026-04-14'))
      )
    )

    expect(screen.getByText('Customer call')).toBeInTheDocument()
    expect(screen.getByText('Medication reminder')).toBeInTheDocument()
  })

  it('leaves the schedule to the time grid and keeps the task list when showSchedule is off', async () => {
    mockListTasks.mockResolvedValue({ tasks: [makeTask({ id: 'task-1', title: 'Draft brief' })] })

    renderPanel(<JournalDayPanel date="2026-04-14" showSchedule={false} />)

    expect(await screen.findByText('Draft brief')).toBeInTheDocument()
    expect(screen.queryByText('Customer call')).toBeNull()
  })

  it('makes each open task draggable onto a time grid as that task, and holds completed ones', async () => {
    mockListTasks.mockResolvedValue({
      tasks: [
        makeTask({ id: 'task-open', title: 'Draft brief' }),
        makeTask({
          id: 'task-done',
          title: 'Send invoice',
          completedAt: '2026-04-14T08:00:00.000Z'
        })
      ]
    })

    renderPanel(<JournalDayPanel date="2026-04-14" />)
    await screen.findByText('Send invoice')

    const configs = mockUseDraggable.mock.calls.map(([config]) => config)
    expect(configs).toContainEqual({
      id: 'day-panel-task:task-open',
      data: {
        type: 'calendar-task',
        sourceType: 'calendar',
        taskId: 'task-open',
        title: 'Draft brief',
        durationMinutes: null
      },
      disabled: false
    })
    expect(configs).toContainEqual({
      id: 'day-panel-task:task-done',
      data: {
        type: 'calendar-task',
        sourceType: 'calendar',
        taskId: 'task-done',
        title: 'Send invoice',
        durationMinutes: null
      },
      disabled: true
    })
  })

  it('heads the list with the task count and shows a timed task at its time', async () => {
    mockListTasks.mockResolvedValue({
      tasks: [
        makeTask({ id: 'task-timed', title: 'Book dentist', dueTime: '19:00' }),
        makeTask({ id: 'task-untimed', title: 'Renew passport' })
      ]
    })

    renderPanel(<JournalDayPanel date="2026-04-14" showSchedule={false} />)
    await screen.findByText('Book dentist')

    const tasks = screen.getByTestId('day-panel-tasks')
    expect(within(tasks).getByRole('heading')).toHaveTextContent('Tasks2')
    const rows = screen.getAllByTestId('day-panel-task-row')
    expect(within(rows[0]).getByText('7:00 PM')).toBeInTheDocument()
    expect(within(rows[1]).queryByText(/PM|AM/)).toBeNull()
  })

  it('creates a task due on the panel day from the add-task row', async () => {
    const user = userEvent.setup()
    mockResolveProject.mockResolvedValue('project-1')
    mockCreateTask.mockResolvedValue({ success: true, task: makeTask({ id: 'new' }) })

    renderPanel(<JournalDayPanel date="2026-04-14" showSchedule={false} />)

    await user.click(await screen.findByTestId('day-panel-add-task'))
    await user.type(screen.getByRole('textbox', { name: 'Add task' }), 'Call the bank{Enter}')

    await waitFor(() =>
      expect(mockCreateTask).toHaveBeenCalledWith({
        projectId: 'project-1',
        title: 'Call the bank',
        dueDate: '2026-04-14'
      })
    )
    expect(mockResolveProject).toHaveBeenCalledWith(expect.objectContaining({ noteId: null }))
    // Stays open and cleared for the next task.
    expect(screen.getByRole('textbox', { name: 'Add task' })).toHaveValue('')

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('textbox', { name: 'Add task' })).toBeNull()
    expect(screen.getByTestId('day-panel-add-task')).toBeInTheDocument()
  })
})

function makeTask(overrides: Record<string, unknown>) {
  return {
    projectId: 'project-1',
    statusId: 'todo',
    parentId: null,
    description: null,
    priority: 0,
    position: 0,
    dueDate: '2026-04-14',
    dueTime: null,
    durationMinutes: null,
    startDate: null,
    repeatConfig: null,
    repeatFrom: null,
    sourceNoteId: null,
    completedAt: null,
    archivedAt: null,
    createdAt: '2026-04-12T08:00:00.000Z',
    modifiedAt: '2026-04-12T08:00:00.000Z',
    tags: [],
    ...overrides
  }
}
