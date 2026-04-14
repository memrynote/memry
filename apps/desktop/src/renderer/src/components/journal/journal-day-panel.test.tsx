import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { renderWithProviders } from '@tests/utils/render'
import { JournalDayPanel } from './journal-day-panel'
import type { CalendarProjectionItem } from '@/services/calendar-service'

const { mockUseCalendarRange, mockListTasks, mockGetStats, mockOpenTab } = vi.hoisted(() => ({
  mockUseCalendarRange: vi.fn(),
  mockListTasks: vi.fn(),
  mockGetStats: vi.fn(),
  mockOpenTab: vi.fn()
}))

vi.mock('@/hooks/use-calendar-range', () => ({
  useCalendarRange: mockUseCalendarRange
}))

vi.mock('@/services/tasks-service', () => ({
  tasksService: {
    list: mockListTasks,
    getStats: mockGetStats
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
    binding: null
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
      title: 'Memry Reminders',
      color: null,
      kind: null,
      isMemryManaged: true
    },
    binding: null
  }
]

describe('JournalDayPanel', () => {
  beforeEach(() => {
    mockUseCalendarRange.mockReset()
    mockListTasks.mockReset()
    mockGetStats.mockReset()
    mockOpenTab.mockReset()

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
    renderWithProviders(<JournalDayPanel date="2026-04-14" />)

    await waitFor(() =>
      expect(mockUseCalendarRange).toHaveBeenCalledWith(
        expect.objectContaining({
          startAt: '2026-04-14T00:00:00.000Z',
          endAt: '2026-04-15T00:00:00.000Z'
        })
      )
    )

    expect(screen.getByText('Customer call')).toBeInTheDocument()
    expect(screen.getByText('Medication reminder')).toBeInTheDocument()
  })
})
