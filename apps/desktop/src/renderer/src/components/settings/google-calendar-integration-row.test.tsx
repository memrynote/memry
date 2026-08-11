import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { renderWithProviders, userEvent } from '@tests/utils/render'
import { IntegrationList } from './integration-list'
import type { CalendarProviderStatus, CalendarSourceRecord } from '@/services/calendar-service'
import { I18nextProvider } from 'react-i18next'
import type { i18n as I18nInstance } from 'i18next'
import { createRendererI18n } from '@memry/i18n/renderer'

const {
  mockGetGoogleCalendarStatus,
  mockConnectGoogleCalendarProvider,
  mockDisconnectGoogleCalendarProvider,
  mockRefreshGoogleCalendarProvider,
  mockListSources,
  mockUpdateSourceSelection,
  mockRetryGoogleCalendarSourceSync
} = vi.hoisted(() => ({
  mockGetGoogleCalendarStatus: vi.fn(),
  mockConnectGoogleCalendarProvider: vi.fn(),
  mockDisconnectGoogleCalendarProvider: vi.fn(),
  mockRefreshGoogleCalendarProvider: vi.fn(),
  mockListSources: vi.fn(),
  mockUpdateSourceSelection: vi.fn(),
  mockRetryGoogleCalendarSourceSync: vi.fn()
}))

vi.mock('@/services/calendar-service', () => ({
  getGoogleCalendarStatus: mockGetGoogleCalendarStatus,
  connectGoogleCalendarProvider: mockConnectGoogleCalendarProvider,
  disconnectGoogleCalendarProvider: mockDisconnectGoogleCalendarProvider,
  refreshGoogleCalendarProvider: mockRefreshGoogleCalendarProvider,
  retryGoogleCalendarSourceSync: mockRetryGoogleCalendarSourceSync,
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
  accounts: [],
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
  accounts: [
    {
      accountId: 'h4yfans@gmail.com',
      email: 'h4yfans@gmail.com',
      status: 'connected',
      lastSyncedAt: '2026-04-12T08:00:00.000Z',
      lastError: null
    }
  ],
  calendars: {
    total: 3,
    selected: 2,
    memryManaged: 1
  },
  lastSyncedAt: '2026-04-12T08:00:00.000Z'
}

const TWO_ACCOUNT_STATUS: CalendarProviderStatus = {
  ...CONNECTED_STATUS,
  accounts: [
    {
      accountId: 'alice@example.com',
      email: 'alice@example.com',
      status: 'connected',
      lastSyncedAt: '2026-04-12T08:00:00.000Z',
      lastError: null
    },
    {
      accountId: 'bob@example.com',
      email: 'bob@example.com',
      status: 'error',
      lastSyncedAt: '2026-04-11T22:30:00.000Z',
      lastError: 'token revoked by Google'
    }
  ]
}

const RECONNECT_REQUIRED_STATUS: CalendarProviderStatus = {
  ...CONNECTED_STATUS,
  hasLocalAuth: false,
  accounts: [
    {
      accountId: 'h4yfans@gmail.com',
      email: 'h4yfans@gmail.com',
      status: 'reconnect_required',
      lastSyncedAt: '2026-04-12T08:00:00.000Z',
      lastError: 'Refresh token no longer exists on this device'
    }
  ]
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
    title: 'memrynote',
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

let i18nEn: I18nInstance

function renderIntegrationList() {
  return renderWithProviders(
    <I18nextProvider i18n={i18nEn}>
      <IntegrationList />
    </I18nextProvider>
  )
}

describe('Google Calendar integration row', () => {
  beforeAll(async () => {
    i18nEn = await createRendererI18n({ locale: 'en' })
  })

  beforeEach(() => {
    mockGetGoogleCalendarStatus.mockReset()
    mockConnectGoogleCalendarProvider.mockReset()
    mockDisconnectGoogleCalendarProvider.mockReset()
    mockRefreshGoogleCalendarProvider.mockReset()
    mockListSources.mockReset()
    mockUpdateSourceSelection.mockReset()
    mockRetryGoogleCalendarSourceSync.mockReset()
  })

  function calendarSource(
    overrides: Partial<CalendarSourceRecord> & Pick<CalendarSourceRecord, 'id' | 'accountId'>
  ): CalendarSourceRecord {
    return {
      provider: 'google',
      kind: 'calendar',
      remoteId: overrides.id,
      title: 'Calendar',
      timezone: 'Europe/Istanbul',
      color: '#0ea5e9',
      isPrimary: false,
      isSelected: false,
      isMemryManaged: false,
      syncCursor: null,
      syncStatus: 'ok',
      lastSyncedAt: null,
      lastError: null,
      metadata: null,
      archivedAt: null,
      syncedAt: null,
      createdAt: '2026-04-12T08:00:00.000Z',
      modifiedAt: '2026-04-12T08:00:00.000Z',
      ...overrides
    } as CalendarSourceRecord
  }

  const TWO_ACCOUNT_SOURCES: CalendarSourceRecord[] = [
    calendarSource({
      id: 'google-calendar:alice-work',
      accountId: 'alice@example.com',
      title: 'Alice Work',
      isPrimary: true,
      isSelected: true
    }),
    calendarSource({
      id: 'google-calendar:alice-team',
      accountId: 'alice@example.com',
      title: 'Alice Team'
    }),
    calendarSource({
      id: 'google-calendar:bob-work',
      accountId: 'bob@example.com',
      title: 'Bob Work',
      isPrimary: true,
      isSelected: true
    })
  ]

  it('lists each account with only its own calendars underneath', async () => {
    mockGetGoogleCalendarStatus.mockResolvedValue(TWO_ACCOUNT_STATUS)
    mockListSources.mockResolvedValue({ sources: TWO_ACCOUNT_SOURCES })

    renderIntegrationList()

    const aliceGroup = await screen.findByTestId('calendar-account-group-alice@example.com')
    const bobGroup = await screen.findByTestId('calendar-account-group-bob@example.com')

    // A flat list gives no way to tell which account a calendar belongs to,
    // and two accounts can both have a calendar called "Work".
    expect(aliceGroup).toHaveTextContent('alice@example.com')
    expect(aliceGroup).toHaveTextContent('Alice Work')
    expect(aliceGroup).toHaveTextContent('Alice Team')
    expect(aliceGroup).not.toHaveTextContent('Bob Work')
    expect(bobGroup).toHaveTextContent('Bob Work')
    expect(bobGroup).not.toHaveTextContent('Alice Work')
  })

  it('offers adding a second Google account while one is already connected', async () => {
    const user = userEvent.setup()

    mockGetGoogleCalendarStatus.mockResolvedValue(CONNECTED_STATUS)
    mockListSources.mockResolvedValue({ sources: CONNECTED_SOURCES })
    mockConnectGoogleCalendarProvider.mockResolvedValue({
      success: true,
      status: TWO_ACCOUNT_STATUS
    })

    renderIntegrationList()

    const addAccount = await screen.findByTestId('calendar-add-account')
    await user.click(addAccount)

    expect(mockConnectGoogleCalendarProvider).toHaveBeenCalledTimes(1)
  })

  it('disconnects one account without touching the other', async () => {
    const user = userEvent.setup()

    mockGetGoogleCalendarStatus.mockResolvedValue(TWO_ACCOUNT_STATUS)
    mockListSources.mockResolvedValue({ sources: TWO_ACCOUNT_SOURCES })
    mockDisconnectGoogleCalendarProvider.mockResolvedValue({
      success: true,
      status: CONNECTED_STATUS
    })

    renderIntegrationList()

    const disconnectBob = await screen.findByTestId('calendar-account-disconnect-bob@example.com')
    await user.click(disconnectBob)

    // Without the account id the handler falls through to its disconnect-all
    // branch and takes the other account down too.
    expect(mockDisconnectGoogleCalendarProvider).toHaveBeenCalledWith('bob@example.com')
  })

  it('still offers a disconnect when the install reports no per-account rows', async () => {
    const user = userEvent.setup()

    // Legacy installs can be connected while every account source predates the
    // account_id column, so status.accounts comes back empty. Per-account
    // disconnect lives inside the groups, so with no groups the user would be
    // connected with no way out.
    mockGetGoogleCalendarStatus.mockResolvedValue({ ...CONNECTED_STATUS, accounts: [] })
    mockListSources.mockResolvedValue({ sources: CONNECTED_SOURCES })
    mockDisconnectGoogleCalendarProvider.mockResolvedValue({
      success: true,
      status: DISCONNECTED_STATUS
    })

    renderIntegrationList()

    const disconnect = await screen.findByTestId('calendar-disconnect-all')
    await user.click(disconnect)

    expect(mockDisconnectGoogleCalendarProvider).toHaveBeenCalledWith(undefined)
  })

  it('starts the Google Calendar connect flow from Settings', async () => {
    const user = userEvent.setup()

    mockGetGoogleCalendarStatus.mockResolvedValue(DISCONNECTED_STATUS)
    mockListSources.mockResolvedValue({ sources: [] })
    mockConnectGoogleCalendarProvider.mockResolvedValue({
      success: true,
      status: CONNECTED_STATUS
    })

    renderIntegrationList()

    await waitFor(() => expect(screen.getByRole('button', { name: 'Connect' })).toBeInTheDocument())

    await user.click(screen.getByRole('button', { name: 'Connect' }))

    expect(mockConnectGoogleCalendarProvider).toHaveBeenCalledTimes(1)
  })

  it('shows connection status, source toggles, the memrynote calendar, and disconnect controls', async () => {
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

    renderIntegrationList()

    await waitFor(() => expect(screen.getByText('Connected')).toBeInTheDocument())

    await user.click(screen.getByRole('checkbox', { name: 'Home' }))
    expect(mockUpdateSourceSelection).toHaveBeenCalledWith({
      id: 'google-calendar-home',
      isSelected: true
    })

    await user.click(screen.getByRole('button', { name: 'Disconnect' }))
    expect(mockDisconnectGoogleCalendarProvider).toHaveBeenCalledTimes(1)
  })

  const AGENT_ACCESS_LABEL = 'Let AI read Google Calendar events'

  it('#given no Google connection #then the AI access switch is not offered', async () => {
    mockGetGoogleCalendarStatus.mockResolvedValue(DISCONNECTED_STATUS)
    mockListSources.mockResolvedValue({ sources: [] })

    renderIntegrationList()

    await waitFor(() => expect(screen.getByRole('button', { name: 'Connect' })).toBeInTheDocument())
    expect(screen.queryByRole('switch', { name: AGENT_ACCESS_LABEL })).not.toBeInTheDocument()
  })

  it('#given consent was granted #then the AI access switch reads as on', async () => {
    mockGetGoogleCalendarStatus.mockResolvedValue(CONNECTED_STATUS)
    mockListSources.mockResolvedValue({ sources: CONNECTED_SOURCES })
    vi.mocked(window.api.settings.getCalendarGoogleSettings).mockResolvedValue({
      defaultTargetCalendarId: null,
      onboardingCompleted: true,
      promoteConfirmDismissed: false,
      pushEventsToGoogle: true,
      agentReadEventsConsent: true
    })

    renderIntegrationList()

    await waitFor(() =>
      expect(screen.getByRole('switch', { name: AGENT_ACCESS_LABEL })).toBeChecked()
    )
  })

  it('#given consent is unanswered #then the AI access switch reads as off', async () => {
    mockGetGoogleCalendarStatus.mockResolvedValue(CONNECTED_STATUS)
    mockListSources.mockResolvedValue({ sources: CONNECTED_SOURCES })
    vi.mocked(window.api.settings.getCalendarGoogleSettings).mockResolvedValue({
      defaultTargetCalendarId: null,
      onboardingCompleted: true,
      promoteConfirmDismissed: false,
      pushEventsToGoogle: true,
      agentReadEventsConsent: null
    })

    renderIntegrationList()

    await waitFor(() =>
      expect(screen.getByRole('switch', { name: AGENT_ACCESS_LABEL })).not.toBeChecked()
    )
  })

  it('#when the user grants AI access from Settings #then the answer is persisted', async () => {
    const user = userEvent.setup()
    mockGetGoogleCalendarStatus.mockResolvedValue(CONNECTED_STATUS)
    mockListSources.mockResolvedValue({ sources: CONNECTED_SOURCES })
    vi.mocked(window.api.settings.getCalendarGoogleSettings).mockResolvedValue({
      defaultTargetCalendarId: null,
      onboardingCompleted: true,
      promoteConfirmDismissed: false,
      pushEventsToGoogle: true,
      agentReadEventsConsent: null
    })

    renderIntegrationList()

    await waitFor(() =>
      expect(screen.getByRole('switch', { name: AGENT_ACCESS_LABEL })).toBeInTheDocument()
    )
    await user.click(screen.getByRole('switch', { name: AGENT_ACCESS_LABEL }))

    expect(window.api.settings.setCalendarGoogleSettings).toHaveBeenCalledWith({
      agentReadEventsConsent: true
    })
  })

  it('#when the user revokes AI access from Settings #then the answer is persisted', async () => {
    const user = userEvent.setup()
    mockGetGoogleCalendarStatus.mockResolvedValue(CONNECTED_STATUS)
    mockListSources.mockResolvedValue({ sources: CONNECTED_SOURCES })
    vi.mocked(window.api.settings.getCalendarGoogleSettings).mockResolvedValue({
      defaultTargetCalendarId: null,
      onboardingCompleted: true,
      promoteConfirmDismissed: false,
      pushEventsToGoogle: true,
      agentReadEventsConsent: true
    })

    renderIntegrationList()

    await waitFor(() =>
      expect(screen.getByRole('switch', { name: AGENT_ACCESS_LABEL })).toBeChecked()
    )
    await user.click(screen.getByRole('switch', { name: AGENT_ACCESS_LABEL }))

    expect(window.api.settings.setCalendarGoogleSettings).toHaveBeenCalledWith({
      agentReadEventsConsent: false
    })
  })

  it('#given an existing Google connection + onboardingCompleted=false #when the row mounts #then the onboarding dialog opens automatically (M2 review fix)', async () => {
    mockGetGoogleCalendarStatus.mockResolvedValue(CONNECTED_STATUS)
    mockListSources.mockResolvedValue({ sources: CONNECTED_SOURCES })
    vi.mocked(window.api.settings.getCalendarGoogleSettings).mockResolvedValue({
      defaultTargetCalendarId: null,
      onboardingCompleted: false,
      promoteConfirmDismissed: false
    })

    renderIntegrationList()

    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: /Which calendar should new memrynote events go to/i })
      ).toBeInTheDocument()
    })
  })

  it('shows a Retry button + lastError on calendar sources in error state and fires retry IPC (M6 T6)', async () => {
    const erroredSources: CalendarSourceRecord[] = CONNECTED_SOURCES.map((source) =>
      source.id === 'google-calendar-work'
        ? { ...source, syncStatus: 'error', lastError: 'Quota exceeded for project 123' }
        : source
    )

    mockGetGoogleCalendarStatus.mockResolvedValue(CONNECTED_STATUS)
    mockListSources.mockResolvedValue({ sources: erroredSources })
    mockRetryGoogleCalendarSourceSync.mockResolvedValue({
      success: true,
      source: { ...erroredSources[2], syncStatus: 'ok', lastError: null }
    })

    renderIntegrationList()

    await waitFor(() => expect(screen.getByText('Work')).toBeInTheDocument())

    const errorRow = screen.getByTestId('calendar-source-row-google-calendar-work')
    expect(errorRow).toHaveAttribute('data-sync-status', 'error')
    expect(screen.getByTestId('calendar-source-error-google-calendar-work')).toHaveTextContent(
      'Quota exceeded for project 123'
    )

    fireEvent.pointerDown(screen.getByTestId('calendar-source-retry-google-calendar-work'), {
      button: 0
    })

    await waitFor(() => {
      expect(mockRetryGoogleCalendarSourceSync).toHaveBeenCalledWith({
        sourceId: 'google-calendar-work'
      })
    })
  })

  it('renders one chip per connected Google account with status + email (M6 T3)', async () => {
    mockGetGoogleCalendarStatus.mockResolvedValue(TWO_ACCOUNT_STATUS)
    mockListSources.mockResolvedValue({ sources: CONNECTED_SOURCES })
    vi.mocked(window.api.settings.getCalendarGoogleSettings).mockResolvedValue({
      defaultTargetCalendarId: 'primary@example.com',
      onboardingCompleted: true,
      promoteConfirmDismissed: false
    })

    renderIntegrationList()

    await waitFor(() => expect(screen.getByText('alice@example.com')).toBeInTheDocument())
    expect(screen.getByText('bob@example.com')).toBeInTheDocument()

    const aliceChip = screen.getByTestId('calendar-account-chip-alice@example.com')
    const bobChip = screen.getByTestId('calendar-account-chip-bob@example.com')
    expect(aliceChip).toHaveAttribute('data-account-status', 'connected')
    expect(bobChip).toHaveAttribute('data-account-status', 'error')
    expect(bobChip).toHaveTextContent('token revoked by Google')
  })

  it('shows reconnect-required state for accounts missing local auth on this device', async () => {
    const user = userEvent.setup()

    mockGetGoogleCalendarStatus.mockResolvedValue(RECONNECT_REQUIRED_STATUS)
    mockListSources.mockResolvedValue({ sources: CONNECTED_SOURCES })
    mockConnectGoogleCalendarProvider.mockResolvedValue({
      success: true,
      status: CONNECTED_STATUS
    })
    vi.mocked(window.api.settings.getCalendarGoogleSettings).mockResolvedValue({
      defaultTargetCalendarId: 'primary@example.com',
      onboardingCompleted: true,
      promoteConfirmDismissed: false
    })

    renderIntegrationList()

    await waitFor(() => expect(screen.getByText('Reconnect Required')).toBeInTheDocument())

    const accountChip = screen.getByTestId('calendar-account-chip-h4yfans@gmail.com')
    expect(accountChip).toHaveAttribute('data-account-status', 'reconnect_required')
    expect(accountChip).toHaveTextContent('Reconnect Google')

    await user.click(screen.getByRole('button', { name: 'Reconnect Google' }))
    expect(mockConnectGoogleCalendarProvider).toHaveBeenCalledTimes(1)
  })

  it('#given an existing Google connection + onboardingCompleted=true #when the row mounts #then the onboarding dialog stays closed', async () => {
    mockGetGoogleCalendarStatus.mockResolvedValue(CONNECTED_STATUS)
    mockListSources.mockResolvedValue({ sources: CONNECTED_SOURCES })
    vi.mocked(window.api.settings.getCalendarGoogleSettings).mockResolvedValue({
      defaultTargetCalendarId: 'primary@example.com',
      onboardingCompleted: true,
      promoteConfirmDismissed: false
    })

    renderIntegrationList()

    // Wait for the connected row to render, then confirm no dialog appeared
    await waitFor(() => expect(screen.getByText('Connected')).toBeInTheDocument())
    expect(
      screen.queryByRole('heading', { name: /Which calendar should new memrynote events go to/i })
    ).not.toBeInTheDocument()
  })
})
