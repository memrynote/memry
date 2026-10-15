import type { ReactElement } from 'react'
import { I18nextProvider } from 'react-i18next'
import type { i18n as I18nInstance } from 'i18next'
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { DragEndEvent } from '@dnd-kit/core'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRendererI18n } from '@memry/i18n/renderer'
import type { CalendarProjectionItem } from '@/services/calendar-service'
import type { TaskListItem } from '@/services/tasks-service'
import type { DragState } from '@/contexts/drag-context'
import type { Task } from '@/data/task-model'
import { useDragHandlers } from '@/hooks/use-drag-handlers'
import { JournalDayPanel } from '@/components/journal/journal-day-panel'
import { timelineDropData } from './use-timeline-drag'
import { TIMELINE_HOUR_HEIGHT } from './timeline-layout'

const mocks = vi.hoisted(() => ({
  items: [] as CalendarProjectionItem[],
  tasks: [] as TaskListItem[],
  flags: new Set(['calendar', 'tasks']),
  complete: vi.fn(),
  update: vi.fn(),
  openTab: vi.fn()
}))

vi.mock('@/hooks/use-calendar-range', () => ({
  useCalendarRange: () => ({ items: mocks.items })
}))

vi.mock('@/hooks/use-feature-flags', () => ({
  useFeatureFlags: () => ({ isEnabled: (flag: string) => mocks.flags.has(flag) })
}))

vi.mock('@/hooks/use-general-settings', () => ({
  useGeneralSettings: () => ({ settings: { clockFormat: '24h' } })
}))

vi.mock('@/services/tasks-service', () => ({
  tasksService: {
    list: vi.fn(async () => ({ tasks: mocks.tasks })),
    getStats: vi.fn(async () => ({ overdue: 0 })),
    complete: mocks.complete,
    uncomplete: vi.fn(),
    update: mocks.update
  },
  onTaskCreated: () => () => {},
  onTaskUpdated: () => () => {},
  onTaskDeleted: () => () => {},
  onTaskCompleted: () => () => {}
}))

vi.mock('@/contexts/tasks', () => ({
  useTasksContext: () => ({ projects: [], tasks: [] })
}))

vi.mock('@/contexts/tabs', () => ({
  useTabActions: () => ({ openTab: mocks.openTab })
}))

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

let i18nInstance: I18nInstance

function renderPanel(ui: ReactElement): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <I18nextProvider i18n={i18nInstance}>
      <QueryClientProvider client={client}>{ui}</QueryClientProvider>
    </I18nextProvider>
  )
}

function localIso(date: string, hour: number, minute = 0): string {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(y, m - 1, d, hour, minute).toISOString()
}

function taskBlock(id: string, date: string, hour: number): CalendarProjectionItem {
  return {
    projectionId: `task:${id}`,
    sourceType: 'task',
    sourceId: id,
    title: `Task ${id}`,
    descriptionPreview: null,
    startAt: localIso(date, hour),
    endAt: null,
    isAllDay: false,
    timezone: 'UTC',
    visualType: 'task',
    editability: { canMove: true, canResize: true, canEditText: true, canDelete: true },
    source: { provider: null, calendarSourceId: null, title: null, color: null, kind: null },
    binding: null
  } as unknown as CalendarProjectionItem
}

function listTask(overrides: Partial<TaskListItem>): TaskListItem {
  return {
    id: 'task',
    projectId: 'project-1',
    statusId: null,
    parentId: null,
    title: 'Task',
    description: null,
    priority: 0,
    position: 0,
    dueDate: '2026-05-10',
    dueTime: null,
    startDate: null,
    repeatConfig: null,
    repeatFrom: null,
    sourceNoteId: null,
    completedAt: null,
    archivedAt: null,
    createdAt: '2026-05-01T00:00:00.000Z',
    modifiedAt: '2026-05-01T00:00:00.000Z',
    ...overrides
  }
}

beforeAll(async () => {
  i18nInstance = await createRendererI18n({ locale: 'en' })
})

beforeEach(() => {
  vi.clearAllMocks()
  mocks.items = []
  mocks.tasks = []
  mocks.flags = new Set(['calendar', 'tasks'])
})

afterEach(() => {
  vi.useRealTimers()
})

describe('day panel timeline', () => {
  it('lists only open tasks without a time under Unscheduled', async () => {
    mocks.tasks = [
      listTask({ id: 'a', title: 'Write brief' }),
      listTask({ id: 'b', title: 'Timed call', dueTime: '10:00' }),
      listTask({ id: 'c', title: 'Already done', completedAt: '2026-05-10T08:00:00.000Z' })
    ]
    renderPanel(<JournalDayPanel date="2026-05-10" />)

    expect(await screen.findByText('Write brief')).toBeInTheDocument()
    expect(screen.getByText('Unscheduled')).toBeInTheDocument()
    expect(screen.queryByText('Timed call')).not.toBeInTheDocument()
    expect(screen.queryByText('Already done')).not.toBeInTheDocument()
  })

  it('shows the plain task list and no timeline with the calendar flag off', async () => {
    mocks.flags = new Set(['tasks'])
    mocks.tasks = [
      listTask({ id: 'b', title: 'Timed call', dueTime: '10:00' }),
      listTask({ id: 'c', title: 'Already done', completedAt: '2026-05-10T08:00:00.000Z' })
    ]
    renderPanel(<JournalDayPanel date="2026-05-10" />)

    expect(await screen.findByText('Timed call')).toBeInTheDocument()
    expect(screen.getByText('Already done')).toBeInTheDocument()
    expect(screen.queryByTestId('day-timeline')).not.toBeInTheDocument()
  })

  it('draws no task blocks and no task list with the tasks flag off', () => {
    mocks.flags = new Set(['calendar'])
    mocks.items = [taskBlock('t1', '2026-05-10', 9)]
    renderPanel(<JournalDayPanel date="2026-05-10" />)

    expect(screen.getByTestId('day-timeline')).toBeInTheDocument()
    expect(screen.queryByTestId('timeline-task')).not.toBeInTheDocument()
    expect(screen.queryByText('Unscheduled')).not.toBeInTheDocument()
  })

  it('draws a timed task without a duration as a 30 minute block and completes it from its checkbox', () => {
    mocks.items = [taskBlock('t1', '2026-05-10', 9)]
    renderPanel(<JournalDayPanel date="2026-05-10" />)

    const block = screen.getByTestId('timeline-task')
    expect(block).toHaveAttribute('data-start', '09:00')
    expect(block).toHaveAttribute('data-end', '09:30')
    expect(block.style.height).toBe(`${TIMELINE_HOUR_HEIGHT / 2 - 1}px`)

    fireEvent.click(screen.getByRole('checkbox', { name: 'Complete Task t1' }))
    expect(mocks.complete).toHaveBeenCalledWith({ id: 't1' })
  })

  it('resizes a block from its bottom edge to 1 h, then 2 h', () => {
    mocks.items = [taskBlock('t1', '2026-05-10', 9)]
    renderPanel(<JournalDayPanel date="2026-05-10" />)
    const handle = screen.getByTestId('timeline-task-resize')

    fireEvent.pointerDown(handle, { button: 0, clientY: 100 })
    fireEvent.pointerMove(window, { clientY: 100 + TIMELINE_HOUR_HEIGHT / 2 })
    expect(screen.getByTestId('timeline-task')).toHaveAttribute('data-end', '10:00')
    fireEvent.pointerUp(window, { clientY: 100 + TIMELINE_HOUR_HEIGHT / 2 })
    expect(mocks.update).toHaveBeenLastCalledWith({ id: 't1', durationMinutes: 60 })

    fireEvent.pointerDown(handle, { button: 0, clientY: 100 })
    fireEvent.pointerUp(window, { clientY: 100 + TIMELINE_HOUR_HEIGHT * 1.6 })
    expect(mocks.update).toHaveBeenLastCalledWith({ id: 't1', durationMinutes: 120 })
    fireEvent.click(screen.getByTestId('timeline-task'))
    expect(mocks.openTab).not.toHaveBeenCalled()
  })

  it('opens the task from a focused block on Enter', () => {
    mocks.items = [taskBlock('t1', '2026-05-10', 9)]
    renderPanel(<JournalDayPanel date="2026-05-10" />)
    const block = screen.getByTestId('timeline-task')
    block.focus()
    fireEvent.keyDown(block, { key: 'Enter' })
    expect(mocks.openTab).toHaveBeenCalledWith(
      expect.objectContaining({ viewState: expect.objectContaining({ openTaskId: 't1' }) })
    )
  })

  it('opens today at now - 15 min with a now line', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 4, 10, 13, 45))
    renderPanel(<JournalDayPanel date="2026-05-10" />)
    const scroller = screen.getByTestId('day-timeline-scroll')
    await waitFor(() => expect(scroller.scrollTop).toBe(13.5 * TIMELINE_HOUR_HEIGHT))
    expect(screen.getByTestId('timeline-now')).toBeInTheDocument()
  })

  it('opens another day at 08:00 with no now line', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 4, 10, 13, 45))
    renderPanel(<JournalDayPanel date="2026-05-12" />)
    expect(screen.getByTestId('day-timeline-scroll').scrollTop).toBe(8 * TIMELINE_HOUR_HEIGHT)
    expect(screen.queryByTestId('timeline-now')).not.toBeInTheDocument()
  })
})

describe('dropping onto the day panel', () => {
  const dragState = { activeIds: ['task-1'], overType: 'date' } as DragState

  function task(overrides: Partial<Task>): Task {
    return {
      id: 'task-1',
      title: 'Task',
      description: '',
      projectId: 'project-1',
      statusId: 'todo',
      priority: 'none',
      dueDate: new Date(2026, 4, 10),
      dueTime: null,
      isRepeating: false,
      repeatConfig: null,
      repeatFrom: null,
      linkedNoteIds: [],
      sourceNoteId: null,
      tags: [],
      parentId: null,
      subtaskIds: [],
      createdAt: new Date(2026, 4, 1),
      completedAt: null,
      archivedAt: null,
      ...overrides
    }
  }

  function drop(tasks: Task[], overData: Record<string, unknown>): ReturnType<typeof vi.fn> {
    const onUpdateTask = vi.fn()
    const { result } = renderHook(() =>
      useDragHandlers({ tasks, projects: [], onUpdateTask, onDeleteTask: vi.fn() })
    )
    const event = {
      active: { id: 'task-1', data: { current: {} }, rect: { current: { translated: null } } },
      over: { id: 'target', data: { current: overData }, rect: { top: 0 } }
    } as unknown as DragEndEvent
    act(() => result.current.handleDragEnd(event, dragState))
    return onUpdateTask
  }

  const slotAt = (hour: number, minute: number) => () => (hour + minute / 60) * TIMELINE_HOUR_HEIGHT

  it('schedules an unscheduled task at the half hour under it for 30 minutes', () => {
    const onUpdateTask = drop([task({})], timelineDropData('2026-05-12', slotAt(14, 20)))
    expect(onUpdateTask).toHaveBeenCalledWith('task-1', {
      dueDate: new Date(2026, 4, 12, 14, 30),
      dueTime: '14:30',
      durationMinutes: 30
    })
  })

  it('moves a block and keeps its duration', () => {
    const onUpdateTask = drop(
      [task({ dueTime: '09:00', durationMinutes: 120 })],
      timelineDropData('2026-05-10', slotAt(16, 0))
    )
    expect(onUpdateTask).toHaveBeenCalledWith('task-1', {
      dueDate: new Date(2026, 4, 10, 16, 0),
      dueTime: '16:00'
    })
  })

  it('clears the time when a block drops on the Unscheduled list', () => {
    const onUpdateTask = drop([task({ dueTime: '09:00', durationMinutes: 60 })], {
      type: 'date',
      date: new Date(2026, 4, 10),
      dateKey: '2026-05-10',
      dueTime: null
    })
    expect(onUpdateTask).toHaveBeenCalledWith('task-1', {
      dueDate: new Date(2026, 4, 10),
      dueTime: null
    })
  })
})
