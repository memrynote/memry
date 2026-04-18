import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { renderWithProviders, userEvent } from '@tests/utils/render'
import { IntegrationList } from './integration-list'
import type { CalendarProviderStatus, CalendarSourceRecord } from '@/services/calendar-service'

const {
  mockGetGoogleCalendarStatus,
  mockConnectGoogleCalendarProvider,
  mockDisconnectGoogleCalendarProvider,
  mockRefreshGoogleCalendarProvider,
  mockListSources,
  mockUpdateSourceSelection
} = vi.hoisted(() => ({
  mockGetGoogleCalendarStatus: vi.fn(),
  mockConnectGoogleCalendarProvider: vi.fn(),
  mockDisconnectGoogleCalendarProvider: vi.fn(),
  mockRefreshGoogleCalendarProvider: vi.fn(),
  mockListSources: vi.fn(),
  mockUpdateSourceSelection: vi.fn()
}))

vi.mock('@/services/calendar-service', () => ({
  getGoogleCalendarStatus: mockGetGoogleCalendarStatus,
  connectGoogleCalendarProvider: mockConnectGoogleCalendarProvider,
  disconnectGoogleCalendarProvider: mockDisconnectGoogleCalendarProvider,
  refreshGoogleCalendarProvider: mockRefreshGoogleCalendarProvider,
  updateGoogleCalendarSourceSelection: mockUpdateSourceSelection,
  onCalendarChanged: vi.fn(() => () => {}),
  calendarService: {
    listSources: mockListSources,
    updateSourceSelection: mockUpdateSourceSelection
  },
  listGoogleCalendars: vi.fn(async () => ({
    calendars: [],
    primary: null,
    currentDefaultId: null
  })),
  setDefaultGoogleCalendar: vi.fn(async () => ({ success: true })),
  promoteExternalCalendarEvent: vi.fn(async () => ({ success: true, eventId: null }))
}))

const DISCONNECTED_STATUS: CalendarProviderStatus = {
  provider: 'google',
  connected: false,
  hasLocalAuth: false,
  account: null,
  calendars: {
    total: 0,
    selected: 0,
    memryManaged: 0
  },
  lastSyncedAt: null
}

const CONNECTED_STATUS: CalendarProviderStatus = {
  provider: 'google',
  connected: true,
  hasLocalAuth: true,
  account: { id: 'google-account-1', title: 'h4yfans@gmail.com' },
  calendars: {
    total: 3,
    selected: 2,
    memryManaged: 1
  },
  lastSyncedAt: '2026-04-12T08:00:00.000Z'
}

const CONNECTED_SOURCES: CalendarSourceRecord[] = [
  {
    id: 'google-account-1',
    provider: 'google',
    kind: 'account',
    accountId: null,
    remoteId: 'acct-1',
    title: 'h4yfans@gmail.com',
    timezone: 'Europe/Istanbul',
    color: null,
    isPrimary: false,
    isSelected: false,
    isMemryManaged: false,
    syncCursor: null,
    syncStatus: 'ok',
    lastSyncedAt: '2026-04-12T08:00:00.000Z',
    metadata: null,
    archivedAt: null,
    syncedAt: '2026-04-12T08:00:00.000Z',
    createdAt: '2026-04-12T08:00:00.000Z',
    modifiedAt: '2026-04-12T08:00:00.000Z'
  },
  {
    id: 'google-calendar-memry',
    provider: 'google',
    kind: 'calendar',
    accountId: 'google-account-1',
    remoteId: 'memry',
    title: 'Memry',
    timezone: 'Europe/Istanbul',
    color: '#5E6AD2',
    isPrimary: false,
    isSelected: true,
    isMemryManaged: true,
    syncCursor: null,
    syncStatus: 'ok',
    lastSyncedAt: '2026-04-12T08:00:00.000Z',
    metadata: null,
    archivedAt: null,
    syncedAt: '2026-04-12T08:00:00.000Z',
    createdAt: '2026-04-12T08:00:00.000Z',
    modifiedAt: '2026-04-12T08:00:00.000Z'
  },
  {
    id: 'google-calendar-work',
    provider: 'google',
    kind: 'calendar',
    accountId: 'google-account-1',
    remoteId: 'work',
    title: 'Work',
    timezone: 'Europe/Istanbul',
    color: '#2563eb',
    isPrimary: true,
    isSelected: true,
    isMemryManaged: false,
    syncCursor: null,
    syncStatus: 'ok',
    lastSyncedAt: '2026-04-12T08:00:00.000Z',
    metadata: null,
    archivedAt: null,
    syncedAt: '2026-04-12T08:00:00.000Z',
    createdAt: '2026-04-12T08:00:00.000Z',
    modifiedAt: '2026-04-12T08:00:00.000Z'
  },
  {
    id: 'google-calendar-home',
    provider: 'google',
    kind: 'calendar',
    accountId: 'google-account-1',
    remoteId: 'home',
    title: 'Home',
    timezone: 'Europe/Istanbul',
    color: '#16a34a',
    isPrimary: false,
    isSelected: false,
    isMemryManaged: false,
    syncCursor: null,
    syncStatus: 'ok',
    lastSyncedAt: '2026-04-12T08:00:00.000Z',
    metadata: null,
    archivedAt: null,
    syncedAt: '2026-04-12T08:00:00.000Z',
    createdAt: '2026-04-12T08:00:00.000Z',
    modifiedAt: '2026-04-12T08:00:00.000Z'
  }
]

describe('Google Calendar integration row', () => {
  beforeEach(() => {
    mockGetGoogleCalendarStatus.mockReset()
    mockConnectGoogleCalendarProvider.mockReset()
    mockDisconnectGoogleCalendarProvider.mockReset()
    mockRefreshGoogleCalendarProvider.mockReset()
    mockListSources.mockReset()
    mockUpdateSourceSelection.mockReset()
  })

  it('starts the Google Calendar connect flow from Settings', async () => {
    const user = userEvent.setup()

    mockGetGoogleCalendarStatus.mockResolvedValue(DISCONNECTED_STATUS)
    mockListSources.mockResolvedValue({ sources: [] })
    mockConnectGoogleCalendarProvider.mockResolvedValue({
      success: true,
      status: CONNECTED_STATUS
    })

    renderWithProviders(<IntegrationList />)

    await waitFor(() => expect(screen.getByRole('button', { name: 'Connect' })).toBeInTheDocument())

    await user.click(screen.getByRole('button', { name: 'Connect' }))

    expect(mockConnectGoogleCalendarProvider).toHaveBeenCalledTimes(1)
  })

  it('shows connection status, source toggles, the Memry calendar, and disconnect controls', async () => {
    const user = userEvent.setup()

    mockGetGoogleCalendarStatus.mockResolvedValue(CONNECTED_STATUS)
    mockListSources.mockResolvedValue({ sources: CONNECTED_SOURCES })
    mockDisconnectGoogleCalendarProvider.mockResolvedValue({
      success: true,
      status: DISCONNECTED_STATUS
    })
    mockUpdateSourceSelection.mockResolvedValue({
      success: true,
      source: { ...CONNECTED_SOURCES[3], isSelected: true }
    })

    renderWithProviders(<IntegrationList />)

    await waitFor(() => expect(screen.getByText('Connected')).toBeInTheDocument())

    await user.click(screen.getByRole('checkbox', { name: 'Home' }))
    expect(mockUpdateSourceSelection).toHaveBeenCalledWith({
      id: 'google-calendar-home',
      isSelected: true
    })

    await user.click(screen.getByRole('button', { name: 'Disconnect' }))
    expect(mockDisconnectGoogleCalendarProvider).toHaveBeenCalledTimes(1)
  })

  it('#given an existing Google connection + onboardingCompleted=false #when the row mounts #then the onboarding dialog opens automatically (M2 review fix)', async () => {
    mockGetGoogleCalendarStatus.mockResolvedValue(CONNECTED_STATUS)
    mockListSources.mockResolvedValue({ sources: CONNECTED_SOURCES })
    vi.mocked(window.api.settings.getCalendarGoogleSettings).mockResolvedValue({
      defaultTargetCalendarId: null,
      onboardingCompleted: false,
      promoteConfirmDismissed: false
    })

    renderWithProviders(<IntegrationList />)

    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: /Which calendar should new Memry events go to/i })
      ).toBeInTheDocument()
    })
  })

  it('#given an existing Google connection + onboardingCompleted=true #when the row mounts #then the onboarding dialog stays closed', async () => {
    mockGetGoogleCalendarStatus.mockResolvedValue(CONNECTED_STATUS)
    mockListSources.mockResolvedValue({ sources: CONNECTED_SOURCES })
    vi.mocked(window.api.settings.getCalendarGoogleSettings).mockResolvedValue({
      defaultTargetCalendarId: 'primary@example.com',
      onboardingCompleted: true,
      promoteConfirmDismissed: false
    })

    renderWithProviders(<IntegrationList />)

    // Wait for the connected row to render, then confirm no dialog appeared
    await waitFor(() => expect(screen.getByText('Connected')).toBeInTheDocument())
    expect(
      screen.queryByRole('heading', { name: /Which calendar should new Memry events go to/i })
    ).not.toBeInTheDocument()
  })
})
