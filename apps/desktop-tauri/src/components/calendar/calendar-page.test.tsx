import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { renderWithProviders, userEvent } from '@tests/utils/render'
import { CalendarPage } from '@/pages/calendar'
import type {
  CalendarProjectionItem,
  CalendarRangeResponse,
  CalendarSourceRecord
} from '@/services/calendar-service'

const { mockUseCalendarRange, mockListSources, mockCreateEvent, mockUpdateEvent, mockDeleteEvent } =
  vi.hoisted(() => ({
    mockUseCalendarRange: vi.fn(),
    mockListSources: vi.fn(),
    mockCreateEvent: vi.fn(),
    mockUpdateEvent: vi.fn(),
    mockDeleteEvent: vi.fn()
  }))

vi.mock('@/hooks/use-calendar-range', () => ({
  useCalendarRange: mockUseCalendarRange
}))

vi.mock('@/services/calendar-service', () => {
  return {
    calendarService: {
      listSources: mockListSources,
      createEvent: mockCreateEvent,
      updateEvent: mockUpdateEvent,
      deleteEvent: mockDeleteEvent,
      getEvent: vi.fn(async () => null)
    },
    onCalendarChanged: vi.fn(() => () => {}),
    listGoogleCalendars: vi.fn(async () => ({
      calendars: [],
      primary: null,
      currentDefaultId: null
    })),
    promoteExternalCalendarEvent: vi.fn(async () => ({ success: true, eventId: null })),
    setDefaultGoogleCalendar: vi.fn(async () => ({ success: true }))
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

const SAMPLE_DAY = new Date()

function isoAtLocalTime(hour: number, minute = 0, dayOffset = 0): string {
  const date = new Date(SAMPLE_DAY)
  date.setDate(date.getDate() + dayOffset)
  date.setHours(hour, minute, 0, 0)
  return date.toISOString()
}

const SAMPLE_ITEMS: CalendarProjectionItem[] = [
  {
    projectionId: 'event:event-1',
    sourceType: 'event',
    sourceId: 'event-1',
    title: 'Planning block',
    descriptionPreview: 'Write the launch brief',
    startAt: isoAtLocalTime(9),
    endAt: isoAtLocalTime(10),
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
    startAt: isoAtLocalTime(13),
    endAt: isoAtLocalTime(14),
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
    startAt: isoAtLocalTime(17),
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
    startAt: isoAtLocalTime(19),
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
    startAt: isoAtLocalTime(15, 0, 1),
    endAt: isoAtLocalTime(16, 0, 1),
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
  },
  {
    projectionId: 'event:event-google',
    sourceType: 'event',
    sourceId: 'event-google',
    title: 'Synced standup',
    descriptionPreview: null,
    startAt: isoAtLocalTime(11),
    endAt: isoAtLocalTime(12),
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
      isMemryManaged: true
    },
    binding: {
      provider: 'google',
      remoteCalendarId: 'remote-work',
      remoteEventId: 'google-evt-1',
      ownershipMode: 'memry',
      writebackMode: 'two_way'
    }
  }
]

function mockRangeResponse(items: CalendarProjectionItem[]): CalendarRangeResponse {
  return { items }
}

describe('CalendarPage', () => {
  beforeEach(() => {
    localStorage.clear()
    mockCreateEvent.mockReset()
    mockUpdateEvent.mockReset()
    mockDeleteEvent.mockReset()
    mockListSources.mockReset()
    mockUseCalendarRange.mockReset()

    mockDeleteEvent.mockResolvedValue({ success: true })
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

    await user.click(screen.getByLabelText('Filter calendars'))

    await user.click(screen.getByLabelText('Imported calendars'))
    expect(screen.queryByText('Customer call')).not.toBeInTheDocument()
    expect(screen.getByText('Planning block')).toBeInTheDocument()

    await user.click(screen.getByLabelText('Memry items'))
    expect(screen.queryByText('Planning block')).not.toBeInTheDocument()

    await user.click(screen.getByLabelText('Imported calendars'))
    expect(screen.getByText('Customer call')).toBeInTheDocument()
  })

  it('filters projection items by event type with color swatches in the filter popover', async () => {
    const user = userEvent.setup()
    renderWithProviders(<CalendarPage />)

    await user.click(screen.getByRole('button', { name: 'Day' }))

    await waitFor(() => expect(screen.getAllByText('Planning block').length).toBeGreaterThan(0))

    expect(screen.getAllByText('Due draft').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Medication reminder').length).toBeGreaterThan(0)

    await user.click(screen.getByLabelText('Filter calendars'))

    await user.click(screen.getByLabelText('Task'))
    expect(screen.queryByText('Due draft')).not.toBeInTheDocument()
    expect(screen.getAllByText('Planning block').length).toBeGreaterThan(0)

    await user.click(screen.getByLabelText('Reminder'))
    expect(screen.queryByText('Medication reminder')).not.toBeInTheDocument()

    await user.click(screen.getByLabelText('Task'))
    expect(screen.getAllByText('Due draft').length).toBeGreaterThan(0)
  })

  it('opens the event editor popover for create and edit flows', async () => {
    const user = userEvent.setup()
    renderWithProviders(<CalendarPage />)

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Create event' })).toBeInTheDocument()
    )

    await user.click(screen.getByRole('button', { name: 'Create event' }))
    expect(await screen.findByRole('dialog', { name: 'Create calendar event' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await user.click(screen.getByText('Planning block'))

    expect(await screen.findByRole('dialog', { name: 'Edit calendar event' })).toBeInTheDocument()
  })

  it('renders projected task, reminder, and snooze items with distinct styling markers', async () => {
    const user = userEvent.setup()
    renderWithProviders(<CalendarPage />)

    await user.click(screen.getByRole('button', { name: 'Day' }))

    await waitFor(() => expect(screen.getAllByText('Due draft').length).toBeGreaterThan(0))

    expect(screen.getAllByText('Due draft')[0].closest('[data-visual-type]')).toHaveAttribute(
      'data-visual-type',
      'task'
    )
    expect(
      screen.getAllByText('Medication reminder')[0].closest('[data-visual-type]')
    ).toHaveAttribute('data-visual-type', 'reminder')
    expect(
      screen.getAllByText('Review investor email')[0].closest('[data-visual-type]')
    ).toHaveAttribute('data-visual-type', 'snooze')
  })

  it('deletes a Memry-native event via the right-click menu without Google wording', async () => {
    const showContextMenu = vi.mocked(window.api.showContextMenu)
    showContextMenu.mockResolvedValueOnce('delete')

    const user = userEvent.setup()
    renderWithProviders(<CalendarPage />)

    await user.click(screen.getByRole('button', { name: 'Day' }))
    const chip = await screen.findByText('Planning block')
    const trigger = chip.closest('[data-visual-type]') as HTMLElement
    expect(trigger).not.toBeNull()

    fireEvent.contextMenu(trigger)

    await waitFor(() => expect(showContextMenu).toHaveBeenCalled())
    expect(showContextMenu.mock.lastCall?.[0]).toEqual([
      expect.objectContaining({ id: 'delete', label: 'Delete event' })
    ])

    const dialog = await screen.findByRole('alertdialog', { name: /delete event/i })
    expect(dialog).toHaveTextContent(/planning block/i)
    expect(dialog).not.toHaveTextContent(/google/i)

    await user.click(screen.getByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(mockDeleteEvent).toHaveBeenCalledWith('event-1'))
  })

  it('warns about Google Calendar when deleting a Google-bound event', async () => {
    vi.mocked(window.api.showContextMenu).mockResolvedValueOnce('delete')

    const user = userEvent.setup()
    renderWithProviders(<CalendarPage />)

    await user.click(screen.getByRole('button', { name: 'Day' }))
    const chip = await screen.findByText('Synced standup')
    const trigger = chip.closest('[data-visual-type]') as HTMLElement
    expect(trigger).not.toBeNull()

    fireEvent.contextMenu(trigger)

    const dialog = await screen.findByRole('alertdialog', { name: /delete event/i })
    expect(dialog).toHaveTextContent(/google calendar/i)

    await user.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(mockDeleteEvent).toHaveBeenCalledWith('event-google'))
  })

  it('cancels delete without calling the mutation', async () => {
    vi.mocked(window.api.showContextMenu).mockResolvedValueOnce('delete')

    const user = userEvent.setup()
    renderWithProviders(<CalendarPage />)

    await user.click(screen.getByRole('button', { name: 'Day' }))
    const chip = await screen.findByText('Planning block')
    fireEvent.contextMenu(chip.closest('[data-visual-type]') as HTMLElement)

    await screen.findByRole('alertdialog', { name: /delete event/i })
    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(mockDeleteEvent).not.toHaveBeenCalled()
  })

  it('does not show a delete menu for non-event projection items', async () => {
    const showContextMenu = vi.mocked(window.api.showContextMenu)

    const user = userEvent.setup()
    renderWithProviders(<CalendarPage />)

    await user.click(screen.getByRole('button', { name: 'Day' }))
    const taskChip = (await screen.findAllByText('Due draft'))[0]
    fireEvent.contextMenu(taskChip.closest('[data-visual-type]') as HTMLElement)

    expect(showContextMenu).not.toHaveBeenCalled()
  })
})
