import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { renderWithProviders } from '@tests/utils/render'
import { I18nextProvider } from 'react-i18next'
import type { i18n as I18nInstance } from 'i18next'
import type { ReactElement } from 'react'
import { createRendererI18n } from '@memry/i18n/renderer'
import { localDayRange } from '@/lib/local-day-range'
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
      title: 'memrynote Reminders',
      color: null,
      kind: null,
      isMemryManaged: true
    },
    binding: null
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
})
