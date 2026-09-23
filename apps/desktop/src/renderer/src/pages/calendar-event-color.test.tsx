import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { renderWithProviders, userEvent } from '@tests/utils/render'
import { CalendarPage } from '@/pages/calendar'
import type { CalendarProjectionItem } from '@/services/calendar-service'

const { mockUseCalendarRange, mockListSources, mockCreateEvent, mockUpdateEvent, mockGetEvent } =
  vi.hoisted(() => ({
    mockUseCalendarRange: vi.fn(),
    mockListSources: vi.fn(),
    mockCreateEvent: vi.fn(),
    mockUpdateEvent: vi.fn(),
    mockGetEvent: vi.fn()
  }))

vi.mock('@/hooks/use-calendar-range', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/use-calendar-range')>()),
  useCalendarRange: mockUseCalendarRange
}))

vi.mock('@/contexts/tabs', () => ({
  useActiveTab: () => null,
  useTabActions: () => ({ openTab: vi.fn() }),
  useTabActionsOptional: () => null
}))

vi.mock('@/services/calendar-service', () => ({
  calendarService: {
    listSources: mockListSources,
    createEvent: mockCreateEvent,
    updateEvent: mockUpdateEvent,
    getEvent: mockGetEvent
  },
  onCalendarChanged: vi.fn(() => () => {}),
  listGoogleCalendars: vi.fn(async () => ({
    calendars: [],
    primary: null,
    currentDefaultId: null
  })),
  promoteExternalCalendarEvent: vi.fn(),
  setDefaultGoogleCalendar: vi.fn(async () => ({ success: true }))
}))

function todayAt(hours: number): string {
  const date = new Date()
  date.setHours(hours, 0, 0, 0)
  return date.toISOString()
}

function colouredEvent(): CalendarProjectionItem {
  return {
    projectionId: 'event:event-1',
    sourceType: 'event',
    sourceId: 'event-1',
    title: 'Standup',
    descriptionPreview: null,
    startAt: todayAt(10),
    endAt: todayAt(11),
    isAllDay: false,
    timezone: 'UTC',
    visualType: 'event',
    editability: { canMove: true, canResize: true, canEditText: true, canDelete: true },
    source: {
      provider: null,
      calendarSourceId: null,
      title: 'memrynote',
      color: null,
      kind: null,
      isMemryManaged: true
    },
    binding: null,
    snoozeOffsetMinutes: null,
    color: 'red'
  }
}

function showItems(items: CalendarProjectionItem[]): void {
  mockUseCalendarRange.mockReturnValue({
    data: { items },
    items,
    isLoading: false,
    isFetching: false,
    error: null
  })
}

describe('CalendarPage event colour', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.clearAllMocks()
    mockListSources.mockResolvedValue({ sources: [] })
    mockCreateEvent.mockResolvedValue({ success: true, event: { id: 'event-new' } })
    mockUpdateEvent.mockResolvedValue({ success: true, event: null })
    mockGetEvent.mockResolvedValue(null)
    localStorage.setItem('calendar-view', 'day')
    showItems([])
  })

  it('creates the event with the colour picked in the form', async () => {
    const user = userEvent.setup()
    renderWithProviders(<CalendarPage />)
    await user.click(await screen.findByRole('button', { name: 'Create event' }))
    await screen.findByTestId('event-edit-popover')

    await user.type(screen.getByPlaceholderText('New Event'), 'Kickoff')
    await user.click(screen.getByRole('button', { name: 'Green' }))
    await user.click(screen.getByTestId('event-edit-save'))

    await waitFor(() =>
      expect(mockCreateEvent).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Kickoff', color: 'green' })
      )
    )
  })

  it('opens a coloured event with its colour selected and saves it back', async () => {
    showItems([colouredEvent()])
    const user = userEvent.setup()
    renderWithProviders(<CalendarPage />)

    await user.click(await screen.findByRole('button', { name: /Standup/ }))
    await screen.findByTestId('event-edit-popover')

    expect(screen.getByRole('button', { name: 'Red' })).toHaveAttribute('aria-pressed', 'true')
    await user.click(screen.getByTestId('event-edit-save'))

    await waitFor(() =>
      expect(mockUpdateEvent).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'event-1', color: 'red' })
      )
    )
  })
})
