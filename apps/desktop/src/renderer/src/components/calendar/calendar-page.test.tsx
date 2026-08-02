import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { renderWithProviders, userEvent } from '@tests/utils/render'
import { CalendarPage } from '@/pages/calendar'
import type {
  CalendarProjectionItem,
  CalendarRangeResponse,
  CalendarSourceRecord
} from '@/services/calendar-service'

const {
  mockUseCalendarRange,
  mockListSources,
  mockCreateEvent,
  mockUpdateEvent,
  mockDeleteEvent,
  mockGetEvent,
  mockPromoteExternal,
  mockSnooze,
  mockUnsnooze,
  mockOpenTab,
  mockUseActiveTab
} = vi.hoisted(() => ({
  mockUseCalendarRange: vi.fn(),
  mockListSources: vi.fn(),
  mockCreateEvent: vi.fn(),
  mockUpdateEvent: vi.fn(),
  mockDeleteEvent: vi.fn(),
  mockGetEvent: vi.fn(),
  mockPromoteExternal: vi.fn(),
  mockSnooze: vi.fn(),
  mockUnsnooze: vi.fn(),
  mockOpenTab: vi.fn(),
  mockUseActiveTab: vi.fn()
}))

vi.mock('@/hooks/use-calendar-range', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/use-calendar-range')>()),
  useCalendarRange: mockUseCalendarRange
}))

vi.mock('@/contexts/tabs', () => ({
  useActiveTab: mockUseActiveTab,
  useTabActions: () => ({ openTab: mockOpenTab })
}))

vi.mock('@/services/calendar-service', () => {
  return {
    calendarService: {
      listSources: mockListSources,
      createEvent: mockCreateEvent,
      updateEvent: mockUpdateEvent,
      deleteEvent: mockDeleteEvent,
      getEvent: mockGetEvent
    },
    onCalendarChanged: vi.fn(() => () => {}),
    listGoogleCalendars: vi.fn(async () => ({
      calendars: [],
      primary: null,
      currentDefaultId: null
    })),
    promoteExternalCalendarEvent: mockPromoteExternal,
    setDefaultGoogleCalendar: vi.fn(async () => ({ success: true }))
  }
})

vi.mock('@/services/inbox-service', () => ({
  inboxService: {
    snooze: mockSnooze,
    unsnooze: mockUnsnooze
  }
}))

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

function localDateString(dayOffset = 0): string {
  const date = new Date(SAMPLE_DAY)
  date.setDate(date.getDate() + dayOffset)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
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
      title: 'memrynote',
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
      title: 'memrynote Tasks',
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
      title: 'memrynote Reminders',
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
      title: 'memrynote Inbox',
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
    mockGetEvent.mockReset()
    mockPromoteExternal.mockReset()
    mockSnooze.mockReset()
    mockUnsnooze.mockReset()
    mockListSources.mockReset()
    mockUseCalendarRange.mockReset()
    mockUseActiveTab.mockReset()

    mockDeleteEvent.mockResolvedValue({ success: true })
    mockGetEvent.mockResolvedValue(null)
    mockPromoteExternal.mockResolvedValue({ success: true, eventId: null })
    mockSnooze.mockResolvedValue({ success: true })
    mockUnsnooze.mockResolvedValue({ success: true })
    vi.mocked(window.api.settings.getCalendarGoogleSettings).mockResolvedValue({
      defaultTargetCalendarId: null,
      onboardingCompleted: true,
      promoteConfirmDismissed: false
    })
    vi.mocked(window.api.settings.setCalendarGoogleSettings).mockResolvedValue({ success: true })
    mockListSources.mockResolvedValue({ sources: SAMPLE_SOURCES })
    mockUseCalendarRange.mockReturnValue({
      data: mockRangeResponse(SAMPLE_ITEMS),
      items: SAMPLE_ITEMS,
      isLoading: false,
      isFetching: false,
      error: null
    })
    mockUseActiveTab.mockReturnValue(null)
  })

  describe('AI access consent prompt', () => {
    const PROMPT_TITLE = /Let AI read your Google Calendar events\?/i

    function mockConsent(agentReadEventsConsent: boolean | null): void {
      vi.mocked(window.api.settings.getCalendarGoogleSettings).mockResolvedValue({
        defaultTargetCalendarId: null,
        onboardingCompleted: true,
        promoteConfirmDismissed: false,
        pushEventsToGoogle: true,
        agentReadEventsConsent
      })
    }

    it('#given a Google connection and no answer yet #then the prompt opens on first calendar visit', async () => {
      mockConsent(null)

      renderWithProviders(<CalendarPage />)

      await waitFor(() =>
        expect(screen.getByRole('heading', { name: PROMPT_TITLE })).toBeInTheDocument()
      )
    })

    it('#given no Google calendars imported #then the prompt stays closed', async () => {
      mockConsent(null)
      mockListSources.mockResolvedValue({ sources: [] })

      renderWithProviders(<CalendarPage />)

      await waitFor(() => expect(mockListSources).toHaveBeenCalled())
      expect(screen.queryByRole('heading', { name: PROMPT_TITLE })).not.toBeInTheDocument()
    })

    it('#given the user already answered #then the prompt stays closed', async () => {
      mockConsent(false)

      renderWithProviders(<CalendarPage />)

      await waitFor(() => expect(window.api.settings.getCalendarGoogleSettings).toHaveBeenCalled())
      expect(screen.queryByRole('heading', { name: PROMPT_TITLE })).not.toBeInTheDocument()
    })

    it('#when the user allows #then consent is stored as granted and the prompt closes', async () => {
      const user = userEvent.setup()
      mockConsent(null)

      renderWithProviders(<CalendarPage />)

      await waitFor(() =>
        expect(screen.getByRole('heading', { name: PROMPT_TITLE })).toBeInTheDocument()
      )
      await user.click(screen.getByRole('button', { name: 'Allow' }))

      expect(window.api.settings.setCalendarGoogleSettings).toHaveBeenCalledWith({
        agentReadEventsConsent: true
      })
      await waitFor(() =>
        expect(screen.queryByRole('heading', { name: PROMPT_TITLE })).not.toBeInTheDocument()
      )
    })

    it('#when the user declines #then consent is stored as denied so we stop asking', async () => {
      const user = userEvent.setup()
      mockConsent(null)

      renderWithProviders(<CalendarPage />)

      await waitFor(() =>
        expect(screen.getByRole('heading', { name: PROMPT_TITLE })).toBeInTheDocument()
      )
      await user.click(screen.getByRole('button', { name: "Don't allow" }))

      expect(window.api.settings.setCalendarGoogleSettings).toHaveBeenCalledWith({
        agentReadEventsConsent: false
      })
      await waitFor(() =>
        expect(screen.queryByRole('heading', { name: PROMPT_TITLE })).not.toBeInTheDocument()
      )
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

  it('restores a persisted view and wires period navigation controls', async () => {
    const user = userEvent.setup()
    localStorage.setItem('calendar-view', 'year')

    renderWithProviders(<CalendarPage />)

    await waitFor(() =>
      expect(screen.getByTestId('calendar-view')).toHaveAttribute('data-view', 'year')
    )

    await user.click(screen.getByRole('button', { name: /previous/i }))
    await user.click(screen.getByRole('button', { name: /next/i }))
    await user.click(screen.getByRole('button', { name: /today/i }))

    expect(mockUseCalendarRange).toHaveBeenCalled()
  })

  it('filters imported Google calendars separately from memrynote items', async () => {
    const user = userEvent.setup()
    renderWithProviders(<CalendarPage />)

    await waitFor(() => expect(screen.getByText('Customer call')).toBeInTheDocument())

    expect(screen.getByText('Planning block')).toBeInTheDocument()
    expect(screen.getByText('Customer call')).toBeInTheDocument()

    await user.click(screen.getByLabelText('Filter calendars'))

    await user.click(screen.getByLabelText('Imported calendars'))
    expect(screen.queryByText('Customer call')).not.toBeInTheDocument()
    expect(screen.getByText('Planning block')).toBeInTheDocument()

    await user.click(screen.getByLabelText('memrynote items'))
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

  it('opens a focused calendar event from active tab view state', async () => {
    mockUseActiveTab.mockReturnValue({
      viewState: {
        focusCalendarEventId: 'event-1',
        focusDate: localDateString(),
        focusedAt: 123
      }
    })

    renderWithProviders(<CalendarPage />)

    expect(await screen.findByRole('dialog', { name: 'Edit calendar event' })).toBeInTheDocument()
    expect(screen.getByDisplayValue('Planning block')).toBeInTheDocument()
  })

  it('saves a newly created all-day event from the editor', async () => {
    const user = userEvent.setup()
    mockCreateEvent.mockResolvedValue({ success: true })

    renderWithProviders(<CalendarPage />)

    await user.click(screen.getByRole('button', { name: 'Create event' }))
    await user.type(await screen.findByPlaceholderText('New Event'), 'Launch day')
    await user.click(screen.getByRole('checkbox', { name: 'All day' }))
    fireEvent.pointerDown(screen.getByTestId('event-edit-save'), { button: 0 })

    await waitFor(() => expect(mockCreateEvent).toHaveBeenCalled())
    expect(mockCreateEvent.mock.lastCall?.[0]).toEqual(
      expect.objectContaining({
        title: 'Launch day',
        isAllDay: true,
        startAt: expect.any(String),
        endAt: expect.any(String)
      })
    )
  })

  it('saves edits from the edit popover', async () => {
    const user = userEvent.setup()
    mockUpdateEvent.mockResolvedValueOnce({ success: true })

    renderWithProviders(<CalendarPage />)

    await user.click(await screen.findByText('Planning block'))
    fireEvent.pointerDown(await screen.findByTestId('event-edit-save'), { button: 0 })

    await waitFor(() =>
      expect(mockUpdateEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'event-1',
          title: 'Planning block'
        })
      )
    )
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

  it('opens inbox snooze actions from projected snooze items', async () => {
    const user = userEvent.setup()
    renderWithProviders(<CalendarPage />)

    await user.click(screen.getByRole('button', { name: 'Day' }))
    await user.click((await screen.findAllByText('Review investor email'))[0])

    await user.click(screen.getByRole('button', { name: 'Open in inbox' }))
    expect(mockOpenTab).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'inbox',
        viewState: expect.objectContaining({ focusInboxItemId: 'snooze-1' })
      })
    )

    await user.click((await screen.findAllByText('Review investor email'))[0])
    await user.click(screen.getByRole('button', { name: 'Unsnooze now' }))
    await waitFor(() => expect(mockUnsnooze).toHaveBeenCalledWith('snooze-1'))
  })

  it('promotes external events directly when the confirmation is dismissed', async () => {
    const user = userEvent.setup()
    const api = window.api as typeof window.api & {
      settings: {
        getCalendarGoogleSettings: ReturnType<typeof vi.fn>
        setCalendarGoogleSettings: ReturnType<typeof vi.fn>
      }
    }
    api.settings.getCalendarGoogleSettings.mockResolvedValue({ promoteConfirmDismissed: true })
    mockPromoteExternal.mockResolvedValue({ success: true, eventId: 'event-promoted' })
    mockGetEvent.mockResolvedValue({
      id: 'event-promoted',
      title: 'Customer call',
      description: 'Imported from Google',
      location: 'Zoom',
      isAllDay: false,
      startAt: isoAtLocalTime(15, 0, 1),
      endAt: isoAtLocalTime(16, 0, 1),
      targetCalendarId: 'remote-work',
      attendees: [],
      reminders: { useDefault: true, overrides: [] },
      visibility: 'default',
      conferenceData: null
    })

    renderWithProviders(<CalendarPage />)

    await user.click(await screen.findByText('Customer call'))

    await waitFor(() =>
      expect(mockPromoteExternal).toHaveBeenCalledWith({ externalEventId: 'external-1' })
    )
    expect(api.settings.setCalendarGoogleSettings).not.toHaveBeenCalled()
    expect(await screen.findByRole('dialog', { name: 'Edit calendar event' })).toBeInTheDocument()
  })

  it('deletes a memrynote-native event via the right-click menu without Google wording', async () => {
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
      expect.objectContaining({ id: 'add-to-project', label: 'Add to project' }),
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
