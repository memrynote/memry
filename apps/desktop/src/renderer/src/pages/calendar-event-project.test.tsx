import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { renderWithProviders, userEvent } from '@tests/utils/render'
import { CalendarPage } from '@/pages/calendar'
import type { CalendarSourceRecord } from '@/services/calendar-service'

const {
  mockUseCalendarRange,
  mockListSources,
  mockCreateEvent,
  mockUpdateEvent,
  mockLinkProjectItem,
  mockOpenTab
} = vi.hoisted(() => ({
  mockUseCalendarRange: vi.fn(),
  mockListSources: vi.fn(),
  mockCreateEvent: vi.fn(),
  mockUpdateEvent: vi.fn(),
  mockLinkProjectItem: vi.fn(),
  mockOpenTab: vi.fn()
}))

vi.mock('@/hooks/use-calendar-range', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/use-calendar-range')>()),
  useCalendarRange: mockUseCalendarRange
}))

vi.mock('@/contexts/tabs', () => ({
  useActiveTab: () => null,
  useTabActions: () => ({ openTab: mockOpenTab })
}))

vi.mock('@/services/calendar-service', () => ({
  calendarService: {
    listSources: mockListSources,
    createEvent: mockCreateEvent,
    updateEvent: mockUpdateEvent
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

// The project field is exercised in its own test; here it only needs to put a
// project id into the draft so the page's post-create link is observable.
vi.mock('@/components/calendar/event-project-field', () => ({
  EventProjectField: ({
    value,
    onChange
  }: {
    value: string | null
    onChange: (id: string | null) => void
  }) => (
    <button type="button" data-value={value ?? ''} onClick={() => onChange('p1')}>
      stub-pick-project
    </button>
  )
}))

vi.mock('@/services/tasks-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/tasks-service')>()),
  tasksService: {
    linkProjectItem: mockLinkProjectItem
  }
}))

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() }
}))

const NO_SOURCES: CalendarSourceRecord[] = []

describe('CalendarPage · create with a project selected', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.clearAllMocks()
    mockListSources.mockResolvedValue({ sources: NO_SOURCES })
    mockUseCalendarRange.mockReturnValue({
      data: { items: [] },
      items: [],
      isLoading: false,
      isFetching: false,
      error: null
    })
    mockCreateEvent.mockResolvedValue({ success: true, event: { id: 'event-new' } })
    mockLinkProjectItem.mockResolvedValue({ success: true })
    localStorage.setItem('calendar-view', 'day')
  })

  async function openCreatePopover(user: ReturnType<typeof userEvent.setup>): Promise<void> {
    await user.click(await screen.findByRole('button', { name: 'Create event' }))
    await screen.findByTestId('event-edit-popover')
  }

  it('links the created event to the drafted project', async () => {
    const user = userEvent.setup()
    renderWithProviders(<CalendarPage />)
    await openCreatePopover(user)

    await user.type(screen.getByPlaceholderText('New Event'), 'Kickoff')
    await user.click(screen.getByText('stub-pick-project'))
    await user.click(screen.getByTestId('event-edit-save'))

    await waitFor(() => expect(mockCreateEvent).toHaveBeenCalledTimes(1))
    await waitFor(() =>
      expect(mockLinkProjectItem).toHaveBeenCalledWith({
        projectId: 'p1',
        itemType: 'calendar_event',
        itemId: 'event-new'
      })
    )
  })

  it('does not link when no project was selected', async () => {
    const user = userEvent.setup()
    renderWithProviders(<CalendarPage />)
    await openCreatePopover(user)

    await user.type(screen.getByPlaceholderText('New Event'), 'Kickoff')
    await user.click(screen.getByTestId('event-edit-save'))

    await waitFor(() => expect(mockCreateEvent).toHaveBeenCalledTimes(1))
    expect(mockLinkProjectItem).not.toHaveBeenCalled()
  })

  it('keeps the created event when linking fails', async () => {
    mockLinkProjectItem.mockResolvedValue({ success: false, error: 'link failed' })
    const user = userEvent.setup()
    renderWithProviders(<CalendarPage />)
    await openCreatePopover(user)

    await user.type(screen.getByPlaceholderText('New Event'), 'Kickoff')
    await user.click(screen.getByText('stub-pick-project'))
    await user.click(screen.getByTestId('event-edit-save'))

    await waitFor(() => expect(mockLinkProjectItem).toHaveBeenCalled())
    // The popover closes on a successful create even though the link failed.
    await waitFor(() => expect(screen.queryByTestId('event-edit-popover')).not.toBeInTheDocument())
  })
})
