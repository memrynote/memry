import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, screen, waitFor } from '@testing-library/react'
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

function stubSelection(
  overrides: Partial<TimeGridSelection> & { daysOffset?: number; columnIndex?: number } = {}
): TimeGridSelection {
  const daysOffset = overrides.daysOffset ?? 0
  const base = new Date()
  base.setDate(base.getDate() + daysOffset)
  const y = base.getFullYear()
  const m = String(base.getMonth() + 1).padStart(2, '0')
  const d = String(base.getDate()).padStart(2, '0')
  return {
    top: 960,
    height: 96,
    date: `${y}-${m}-${d}`,
    startAt: `${y}-${m}-${d}T10:00`,
    endAt: `${y}-${m}-${d}T11:00`,
    columnIndex: overrides.columnIndex ?? 0,
    anchorRect: { x: 100, y: 200, width: 300, height: 96 },
    ...overrides
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

  // H2 — Save button click path must behave identically to Enter
  it('submits via Save button click (not only Enter)', async () => {
    mockCreateEvent.mockResolvedValue({ success: true, event: { id: 'event-new' } })
    const user = userEvent.setup()
    renderWithProviders(<CalendarPage />)

    await screen.findByTestId('quick-create-popover')
    await user.type(screen.getByPlaceholderText('New Event'), 'Design review')
    await user.click(screen.getByRole('button', { name: /save/i }))

    await waitFor(() => expect(mockCreateEvent).toHaveBeenCalledTimes(1))
    const payload = mockCreateEvent.mock.calls[0][0]
    expect(payload.title).toBe('Design review')
    expect(CreateCalendarEventSchema.safeParse(payload).success).toBe(true)
    await waitFor(() => expect(mockClearSelection).toHaveBeenCalled())
  })

  // H6 — isSubmitting guard must hold across a rapid double-Enter
  it('does not create the event twice on rapid double-Enter', async () => {
    mockCreateEvent.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ success: true, event: { id: 'event-new' } }), 50)
        })
    )
    const user = userEvent.setup()
    renderWithProviders(<CalendarPage />)

    await screen.findByTestId('quick-create-popover')
    const input = screen.getByPlaceholderText('New Event')
    await user.type(input, 'Team sync')
    await user.keyboard('{Enter}{Enter}')

    await waitFor(() => expect(mockCreateEvent).toHaveBeenCalled())
    // Small settle window so a second accidental call would appear
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80))
    })
    expect(mockCreateEvent).toHaveBeenCalledTimes(1)
  })

  // H5 — past dates must succeed (user goal)
  it('creates an event when the selected date is in the past', async () => {
    mockCreateEvent.mockResolvedValue({ success: true, event: { id: 'event-past' } })
    mockUseTimeGridMarquee.mockReturnValue({
      selection: stubSelection({ daysOffset: -30 }),
      isDragging: false,
      handlers: { onMouseDown: vi.fn(), onDoubleClick: vi.fn() },
      clearSelection: mockClearSelection
    })
    const user = userEvent.setup()
    renderWithProviders(<CalendarPage />)

    await screen.findByTestId('quick-create-popover')
    await user.type(screen.getByPlaceholderText('New Event'), 'Retro notes{Enter}')

    await waitFor(() => expect(mockCreateEvent).toHaveBeenCalledTimes(1))
    const payload = mockCreateEvent.mock.calls[0][0]
    expect(payload.title).toBe('Retro notes')
    const parsed = CreateCalendarEventSchema.safeParse(payload)
    expect(parsed.success).toBe(true)
    // Confirm the startAt really is in the past
    expect(new Date(payload.startAt).getTime()).toBeLessThan(Date.now())
  })

  // H3 — week view: submit works when the selection lives on column 3 (Wednesday-ish)
  it('week view variant: createEvent is called when submitting from column 3', async () => {
    mockCreateEvent.mockResolvedValue({ success: true, event: { id: 'event-wk' } })
    mockUseTimeGridMarquee.mockReturnValue({
      selection: stubSelection({ columnIndex: 3 }),
      isDragging: false,
      handlers: { onMouseDown: vi.fn(), onDoubleClick: vi.fn() },
      clearSelection: mockClearSelection
    })

    const user = userEvent.setup()
    renderWithProviders(<CalendarPage />)

    // Switch to week view via the view-switcher button — more reliable than
    // relying on localStorage initial state under CI.
    await user.click(screen.getByRole('button', { name: 'Week', exact: true }))

    await screen.findByTestId('quick-create-popover')
    await user.type(screen.getByPlaceholderText('New Event'), 'Sprint planning{Enter}')

    await waitFor(() => expect(mockCreateEvent).toHaveBeenCalledTimes(1))
    expect(mockCreateEvent.mock.calls[0][0].title).toBe('Sprint planning')
  })
})
