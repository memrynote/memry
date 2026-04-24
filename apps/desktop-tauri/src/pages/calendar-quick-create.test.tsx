import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { renderWithProviders, userEvent } from '@tests/utils/render'
import { CalendarPage } from '@/pages/calendar'
import { CreateCalendarEventSchema } from '@memry/contracts/calendar-api'
import type { TimeGridSelection } from '@/components/calendar/use-time-grid-marquee'
import type { CalendarSourceRecord } from '@/services/calendar-service'

const {
  mockUseCalendarRange,
  mockListSources,
  mockCreateEvent,
  mockUpdateEvent,
  mockUseTimeGridMarquee,
  mockClearSelection
} = vi.hoisted(() => ({
  mockUseCalendarRange: vi.fn(),
  mockListSources: vi.fn(),
  mockCreateEvent: vi.fn(),
  mockUpdateEvent: vi.fn(),
  mockUseTimeGridMarquee: vi.fn(),
  mockClearSelection: vi.fn()
}))

vi.mock('@/hooks/use-calendar-range', () => ({
  useCalendarRange: mockUseCalendarRange
}))

vi.mock('@/services/calendar-service', () => ({
  calendarService: {
    listSources: mockListSources,
    createEvent: mockCreateEvent,
    updateEvent: mockUpdateEvent
  },
  onCalendarChanged: vi.fn(() => () => {})
}))

vi.mock('@/components/calendar/use-time-grid-marquee', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('@/components/calendar/use-time-grid-marquee')>()
  return {
    ...original,
    useTimeGridMarquee: mockUseTimeGridMarquee
  }
})

const NO_SOURCES: CalendarSourceRecord[] = []

function stubSelection(): TimeGridSelection {
  const today = new Date()
  const y = today.getFullYear()
  const m = String(today.getMonth() + 1).padStart(2, '0')
  const d = String(today.getDate()).padStart(2, '0')
  return {
    top: 960,
    height: 96,
    date: `${y}-${m}-${d}`,
    startAt: `${y}-${m}-${d}T10:00`,
    endAt: `${y}-${m}-${d}T11:00`,
    columnIndex: 0,
    anchorRect: { x: 100, y: 200, width: 300, height: 96 }
  }
}

describe('CalendarPage · marquee → quick-create → save', () => {
  beforeEach(() => {
    localStorage.clear()
    mockCreateEvent.mockReset()
    mockUpdateEvent.mockReset()
    mockListSources.mockReset()
    mockUseCalendarRange.mockReset()
    mockUseTimeGridMarquee.mockReset()
    mockClearSelection.mockReset()

    mockListSources.mockResolvedValue({ sources: NO_SOURCES })
    mockUseCalendarRange.mockReturnValue({
      data: { items: [] },
      items: [],
      isLoading: false,
      isFetching: false,
      error: null
    })
    mockUseTimeGridMarquee.mockReturnValue({
      selection: stubSelection(),
      isDragging: false,
      handlers: { onMouseDown: vi.fn(), onDoubleClick: vi.fn() },
      clearSelection: mockClearSelection
    })

    localStorage.setItem('calendar-view', 'day')
  })

  it('calls createEvent when the user clicks the Save button (regression for disabled-mid-click)', async () => {
    mockCreateEvent.mockResolvedValue({
      success: true,
      event: { id: 'event-new' }
    })
    const user = userEvent.setup()
    renderWithProviders(<CalendarPage />)

    await screen.findByTestId('quick-create-popover')
    await user.type(screen.getByPlaceholderText('New Event'), 'Clicked save')
    await user.click(screen.getByTestId('quick-create-save'))

    await waitFor(() => expect(mockCreateEvent).toHaveBeenCalledTimes(1))
    expect(mockCreateEvent.mock.calls[0][0].title).toBe('Clicked save')
  })

  it('calls createEvent with a Zod-valid payload when the user submits via Enter', async () => {
    mockCreateEvent.mockResolvedValue({
      success: true,
      event: { id: 'event-new' }
    })
    const user = userEvent.setup()
    renderWithProviders(<CalendarPage />)

    const popover = await screen.findByTestId('quick-create-popover')
    expect(popover).toBeInTheDocument()

    const titleInput = screen.getByPlaceholderText('New Event')
    await user.type(titleInput, 'Team sync{Enter}')

    await waitFor(() => expect(mockCreateEvent).toHaveBeenCalledTimes(1))

    const payload = mockCreateEvent.mock.calls[0][0]
    expect(payload.title).toBe('Team sync')
    expect(payload.isAllDay).toBe(false)

    const parsed = CreateCalendarEventSchema.safeParse(payload)
    expect(parsed.success).toBe(true)
  })

  it('closes the popover and invalidates calendar range queries on success', async () => {
    mockCreateEvent.mockResolvedValue({
      success: true,
      event: { id: 'event-new' }
    })
    const user = userEvent.setup()
    const { queryClient } = renderWithProviders(<CalendarPage />)
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')

    await screen.findByTestId('quick-create-popover')
    await user.type(screen.getByPlaceholderText('New Event'), 'Team sync{Enter}')

    await waitFor(() => expect(mockCreateEvent).toHaveBeenCalledTimes(1))

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ queryKey: ['calendar', 'range'] })
      )
    })
    expect(mockClearSelection).toHaveBeenCalled()
  })

  it('keeps the popover mounted and surfaces an error message when createEvent rejects', async () => {
    mockCreateEvent.mockRejectedValue(new Error('Database locked'))
    const user = userEvent.setup()
    renderWithProviders(<CalendarPage />)

    await screen.findByTestId('quick-create-popover')
    await user.type(screen.getByPlaceholderText('New Event'), 'Team sync{Enter}')

    await waitFor(() => expect(mockCreateEvent).toHaveBeenCalledTimes(1))

    expect(screen.getByTestId('quick-create-popover')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('New Event')).toHaveValue('Team sync')
    expect(screen.getByTestId('quick-create-error')).toHaveTextContent(/database locked/i)
    expect(mockClearSelection).not.toHaveBeenCalled()
  })

  it('surfaces the error and keeps the popover mounted when createEvent resolves with { success: false }', async () => {
    mockCreateEvent.mockResolvedValue({
      success: false,
      event: null,
      error: 'Validation failed: startAt: Invalid datetime'
    })
    const user = userEvent.setup()
    renderWithProviders(<CalendarPage />)

    await screen.findByTestId('quick-create-popover')
    await user.type(screen.getByPlaceholderText('New Event'), 'Team sync{Enter}')

    await waitFor(() => expect(mockCreateEvent).toHaveBeenCalledTimes(1))

    expect(screen.getByTestId('quick-create-popover')).toBeInTheDocument()
    expect(screen.getByTestId('quick-create-error')).toHaveTextContent(/validation failed/i)
    expect(mockClearSelection).not.toHaveBeenCalled()
  })
})
