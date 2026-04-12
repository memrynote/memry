import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { renderWithProviders, userEvent } from '@tests/utils/render'
import { CalendarPage } from '@/pages/calendar'
import type {
  CalendarProjectionItem,
  CalendarRangeResponse,
  CalendarSourceRecord
} from '@/services/calendar-service'

const { mockUseCalendarRange, mockListSources, mockCreateEvent, mockUpdateEvent } = vi.hoisted(
  () => ({
    mockUseCalendarRange: vi.fn(),
    mockListSources: vi.fn(),
    mockCreateEvent: vi.fn(),
    mockUpdateEvent: vi.fn()
  })
)

vi.mock('@/hooks/use-calendar-range', () => ({
  useCalendarRange: mockUseCalendarRange
}))

vi.mock('@/services/calendar-service', () => {
  return {
    calendarService: {
      listSources: mockListSources,
      createEvent: mockCreateEvent,
      updateEvent: mockUpdateEvent
    },
    onCalendarChanged: vi.fn(() => () => {})
  }
})

const SAMPLE_SOURCES: CalendarSourceRecord[] = [
  {
    id: 'google-work',
    provider: 'google',
    kind: 'calendar',
    accountId: 'google-account',
    remoteId: 'remote-work',
    title: 'Work',
    timezone: 'UTC',
    color: '#2563eb',
    isPrimary: false,
    isSelected: true,
    isMemryManaged: false,
    syncCursor: null,
    syncStatus: 'ok',
    lastSyncedAt: null,
    metadata: null,
    archivedAt: null,
    syncedAt: null,
    createdAt: '2026-04-12T08:00:00.000Z',
    modifiedAt: '2026-04-12T08:00:00.000Z'
  }
]

const SAMPLE_ITEMS: CalendarProjectionItem[] = [
  {
    projectionId: 'event:event-1',
    sourceType: 'event',
    sourceId: 'event-1',
    title: 'Planning block',
    descriptionPreview: 'Write the launch brief',
    startAt: '2026-04-14T09:00:00.000Z',
    endAt: '2026-04-14T10:00:00.000Z',
    isAllDay: false,
    timezone: 'UTC',
    visualType: 'event',
    editability: { canMove: true, canResize: true, canEditText: true, canDelete: true },
    source: {
      provider: null,
      calendarSourceId: null,
      title: 'Memry',
      color: null,
      kind: null,
      isMemryManaged: true
    },
    binding: null
  },
  {
    projectionId: 'task:task-1',
    sourceType: 'task',
    sourceId: 'task-1',
    title: 'Due draft',
    descriptionPreview: null,
    startAt: '2026-04-14T13:00:00.000Z',
    endAt: '2026-04-14T14:00:00.000Z',
    isAllDay: false,
    timezone: 'UTC',
    visualType: 'task',
    editability: { canMove: true, canResize: true, canEditText: false, canDelete: true },
    source: {
      provider: null,
      calendarSourceId: null,
      title: 'Memry Tasks',
      color: null,
      kind: null,
      isMemryManaged: true
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
  },
  {
    projectionId: 'inbox_snooze:snooze-1',
    sourceType: 'inbox_snooze',
    sourceId: 'snooze-1',
    title: 'Review investor email',
    descriptionPreview: null,
    startAt: '2026-04-14T19:00:00.000Z',
    endAt: null,
    isAllDay: false,
    timezone: 'UTC',
    visualType: 'snooze',
    editability: { canMove: true, canResize: false, canEditText: false, canDelete: true },
    source: {
      provider: null,
      calendarSourceId: null,
      title: 'Memry Inbox',
      color: null,
      kind: null,
      isMemryManaged: true
    },
    binding: null
  },
  {
    projectionId: 'external_event:external-1',
    sourceType: 'external_event',
    sourceId: 'external-1',
    title: 'Customer call',
    descriptionPreview: 'Imported from Google',
    startAt: '2026-04-15T15:00:00.000Z',
    endAt: '2026-04-15T16:00:00.000Z',
    isAllDay: false,
    timezone: 'UTC',
    visualType: 'external_event',
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
  }
]

function mockRangeResponse(items: CalendarProjectionItem[]): CalendarRangeResponse {
  return { items }
}

describe('CalendarPage', () => {
  beforeEach(() => {
    mockCreateEvent.mockReset()
    mockUpdateEvent.mockReset()
    mockListSources.mockReset()
    mockUseCalendarRange.mockReset()

    mockListSources.mockResolvedValue({ sources: SAMPLE_SOURCES })
    mockUseCalendarRange.mockReturnValue({
      data: mockRangeResponse(SAMPLE_ITEMS),
      items: SAMPLE_ITEMS,
      isLoading: false,
      isFetching: false,
      error: null
    })
  })

  it('switches between day, week, month, and year views', async () => {
    const user = userEvent.setup()
    renderWithProviders(<CalendarPage />)

    await waitFor(() => expect(screen.getByRole('button', { name: 'Day' })).toBeInTheDocument())

    await user.click(screen.getByRole('button', { name: 'Day' }))
    expect(screen.getByTestId('calendar-view')).toHaveAttribute('data-view', 'day')

    await user.click(screen.getByRole('button', { name: 'Week' }))
    expect(screen.getByTestId('calendar-view')).toHaveAttribute('data-view', 'week')

    await user.click(screen.getByRole('button', { name: 'Month' }))
    expect(screen.getByTestId('calendar-view')).toHaveAttribute('data-view', 'month')

    await user.click(screen.getByRole('button', { name: 'Year' }))
    expect(screen.getByTestId('calendar-view')).toHaveAttribute('data-view', 'year')
  })

  it('filters imported Google calendars separately from Memry items', async () => {
    const user = userEvent.setup()
    renderWithProviders(<CalendarPage />)

    await waitFor(() => expect(screen.getByText('Customer call')).toBeInTheDocument())

    expect(screen.getByText('Planning block')).toBeInTheDocument()
    expect(screen.getByText('Customer call')).toBeInTheDocument()

    await user.click(screen.getByLabelText('Imported calendars'))
    expect(screen.queryByText('Customer call')).not.toBeInTheDocument()
    expect(screen.getByText('Planning block')).toBeInTheDocument()

    await user.click(screen.getByLabelText('Memry items'))
    expect(screen.queryByText('Planning block')).not.toBeInTheDocument()

    await user.click(screen.getByLabelText('Imported calendars'))
    expect(screen.getByText('Customer call')).toBeInTheDocument()
  })

  it('opens the event editor drawer for create and edit flows', async () => {
    const user = userEvent.setup()
    renderWithProviders(<CalendarPage />)

    await waitFor(() => expect(screen.getByRole('button', { name: 'New Event' })).toBeInTheDocument())

    await user.click(screen.getByRole('button', { name: 'New Event' }))
    expect(screen.getByRole('heading', { name: 'New Event' })).toBeInTheDocument()

    await user.click(screen.getAllByRole('button', { name: 'Close' })[0])
    await user.click(screen.getByText('Planning block'))

    expect(screen.getByText('Edit Event')).toBeInTheDocument()
  })

  it('renders projected task, reminder, and snooze items with distinct styling markers', async () => {
    renderWithProviders(<CalendarPage />)

    await waitFor(() => expect(screen.getByText('Due draft')).toBeInTheDocument())

    expect(screen.getByText('Due draft').closest('[data-visual-type]')).toHaveAttribute(
      'data-visual-type',
      'task'
    )
    expect(screen.getByText('Medication reminder').closest('[data-visual-type]')).toHaveAttribute(
      'data-visual-type',
      'reminder'
    )
    expect(screen.getByText('Review investor email').closest('[data-visual-type]')).toHaveAttribute(
      'data-visual-type',
      'snooze'
    )
  })
})
