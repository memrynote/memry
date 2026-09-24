import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import type { i18n as I18nInstance } from 'i18next'
import { createRendererI18n } from '@memry/i18n/renderer'
import type {
  CalendarProviderCapabilities,
  CalendarProviderDescriptor,
  CalendarProviderStatus
} from '@memry/contracts/calendar-api'
import { renderWithProviders, userEvent } from '@tests/utils/render'
import { CalendarProviderSections } from './calendar-provider-sections'

const mocks = vi.hoisted(() => ({
  listProviders: vi.fn(),
  getProviderStatus: vi.fn(),
  listSources: vi.fn(),
  connectProvider: vi.fn(),
  checkProviderWriterCompat: vi.fn(),
  disconnectProvider: vi.fn(),
  refreshProvider: vi.fn(),
  updateSourceSelection: vi.fn(),
  retrySourceSync: vi.fn(),
  listProviderCalendars: vi.fn(),
  setDefaultProviderCalendar: vi.fn()
}))

vi.mock('@/services/calendar-service', () => ({
  onCalendarChanged: vi.fn(() => () => {}),
  calendarService: mocks
}))

vi.mock('@/components/settings/google-calendar-connection', () => ({
  GoogleCalendarConnection: () => <div data-testid="google-section-body">google</div>
}))

vi.mock('@/components/settings/ics-calendar-subscriptions', () => ({
  IcsCalendarSubscriptions: () => <div data-testid="ics-section-body">ics</div>
}))

const BASE: CalendarProviderCapabilities = {
  supportsWrite: false,
  supportsCreateCalendar: false,
  supportsPush: false,
  supportsMultiAccount: true,
  requiresMemryAccount: false,
  mirrorScope: 'synced',
  sourceScope: 'synced',
  incrementalMode: 'sync-collection',
  authFlow: 'basic',
  pollIntervalMs: 15 * 60 * 1000
}

const PROVIDERS: CalendarProviderDescriptor[] = [
  {
    id: 'google',
    capabilities: { ...BASE, supportsWrite: true, supportsPush: true, authFlow: 'oauth2' }
  },
  { id: 'ics', capabilities: { ...BASE, supportsMultiAccount: false, authFlow: 'url' } },
  { id: 'read-only-dav', capabilities: BASE },
  {
    id: 'writable-single',
    capabilities: { ...BASE, supportsWrite: true, supportsMultiAccount: false }
  }
]

function status(provider: string, connected: boolean): CalendarProviderStatus {
  return {
    provider,
    connected,
    hasLocalAuth: connected,
    account: connected ? { id: `${provider}-account`, title: 'me@example.com' } : null,
    accounts: connected
      ? [
          {
            accountId: `${provider}-account`,
            email: 'me@example.com',
            status: 'connected',
            lastSyncedAt: null,
            lastError: null
          }
        ]
      : [],
    calendars: { total: 0, selected: 0, memryManaged: 0 },
    lastSyncedAt: null
  }
}

let i18nEn: I18nInstance

function renderSections(): void {
  renderWithProviders(
    <I18nextProvider i18n={i18nEn}>
      <CalendarProviderSections />
    </I18nextProvider>
  )
}

describe('provider-aware Settings → Calendar shell (#1395)', () => {
  beforeAll(async () => {
    i18nEn = await createRendererI18n({ locale: 'en' })
  })

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.listProviders.mockResolvedValue({ providers: PROVIDERS })
    mocks.getProviderStatus.mockImplementation(async ({ provider }: { provider: string }) =>
      status(provider, true)
    )
    mocks.listSources.mockResolvedValue({ sources: [] })
    mocks.listProviderCalendars.mockResolvedValue({
      provider: 'writable-single',
      calendars: [],
      primary: null,
      currentDefaultId: null
    })
    mocks.setDefaultProviderCalendar.mockResolvedValue({ success: true })
    window.api = {
      ...window.api,
      settings: {
        ...window.api.settings,
        getCalendarProviderSettings: vi.fn(async () => ({
          agentReadEventsConsent: null,
          pushEventsToProvider: true
        })),
        setCalendarProviderSettings: vi.fn(async () => ({ success: true }))
      }
    }
  })

  it('renders one section per provider main offers, Google and ICS with their own components', async () => {
    renderSections()

    expect(await screen.findByTestId('calendar-provider-section-read-only-dav')).toBeInTheDocument()
    expect(
      within(screen.getByTestId('calendar-provider-section-google')).getByTestId(
        'google-section-body'
      )
    ).toBeInTheDocument()
    expect(
      within(screen.getByTestId('calendar-provider-section-ics')).getByTestId('ics-section-body')
    ).toBeInTheDocument()
    // A provider main left out (another platform's) does not exist here.
    expect(screen.queryByTestId('calendar-provider-section-macos-calendar')).toBeNull()
  })

  it('a read-only provider shows the badge and its poll interval, and no push switch', async () => {
    renderSections()

    const panel = await screen.findByTestId('calendar-provider-panel-read-only-dav')
    expect(
      await within(panel).findByTestId('calendar-provider-read-only-read-only-dav')
    ).toBeInTheDocument()
    expect(within(panel).getByTestId('calendar-provider-poll-read-only-dav')).toHaveTextContent(
      'every 15 minutes'
    )
    expect(within(panel).queryByTestId('calendar-provider-push-read-only-dav')).toBeNull()
    // Every non-Google provider gets its own AI answer.
    expect(
      await within(panel).findByTestId('calendar-provider-agent-access-read-only-dav')
    ).toBeInTheDocument()
  })

  it('a writable provider offers the push switch and no read-only badge', async () => {
    renderSections()

    const panel = await screen.findByTestId('calendar-provider-panel-writable-single')
    expect(
      await within(panel).findByTestId('calendar-provider-push-writable-single')
    ).toBeInTheDocument()
    expect(within(panel).queryByTestId('calendar-provider-read-only-writable-single')).toBeNull()
  })

  it('a writable provider can hold the default calendar; choosing one sets it (#2372)', async () => {
    mocks.listProviderCalendars.mockImplementation(async ({ provider }: { provider: string }) => ({
      provider,
      calendars:
        provider === 'writable-single'
          ? [
              {
                id: 'https://dav.example.com/work/',
                title: 'Work',
                timezone: null,
                color: null,
                isPrimary: false
              }
            ]
          : [],
      primary: null,
      currentDefaultId: null
    }))
    const user = userEvent.setup()
    renderSections()

    const select = await screen.findByTestId('calendar-provider-default-target-writable-single')
    expect(screen.queryByTestId('calendar-provider-default-target-read-only-dav')).toBeNull()
    await user.selectOptions(select, 'https://dav.example.com/work/')
    expect(mocks.setDefaultProviderCalendar).toHaveBeenCalledWith({
      provider: 'writable-single',
      calendarId: 'https://dav.example.com/work/'
    })
  })

  it('multi-account providers list accounts with Add account; single-connection ones do not', async () => {
    renderSections()

    const multi = await screen.findByTestId('calendar-provider-panel-read-only-dav')
    expect(
      await within(multi).findByTestId('calendar-provider-account-read-only-dav-account')
    ).toBeInTheDocument()
    expect(
      within(multi).getByTestId('calendar-provider-add-account-read-only-dav')
    ).toBeInTheDocument()

    const single = screen.getByTestId('calendar-provider-panel-writable-single')
    await within(single).findByRole('button', { name: 'Disconnect' })
    expect(within(single).queryByTestId('calendar-provider-add-account-writable-single')).toBeNull()
    expect(
      within(single).queryByTestId('calendar-provider-account-writable-single-account')
    ).toBeNull()
  })

  it('a basic-auth provider that is not connected shows the server, username and app password form', async () => {
    mocks.getProviderStatus.mockImplementation(async ({ provider }: { provider: string }) =>
      status(provider, false)
    )
    renderSections()

    const form = await screen.findByTestId('calendar-basic-connect-read-only-dav')
    expect(within(form).getByLabelText('Server address')).toBeInTheDocument()
    expect(within(form).getByLabelText('Username')).toBeInTheDocument()
    expect(within(form).getByLabelText('App password')).toBeInTheDocument()
  })

  it('a writable provider lists outdated devices and connects only after an acknowledgement (#1396)', async () => {
    mocks.getProviderStatus.mockImplementation(async ({ provider }: { provider: string }) =>
      status(provider, false)
    )
    mocks.checkProviderWriterCompat.mockResolvedValue({
      required: true,
      verified: true,
      minVersion: '2026.925.0',
      outdatedDevices: [
        { id: 'old-pc', name: 'Old PC', platform: 'windows', appVersion: '2026.919.1' }
      ]
    })
    mocks.connectProvider.mockResolvedValue({
      success: true,
      status: status('writable-single', true)
    })
    const user = userEvent.setup()
    renderSections()

    const form = await screen.findByTestId('calendar-basic-connect-writable-single')
    await user.type(within(form).getByLabelText('Server address'), 'https://dav.example.com')
    await user.type(within(form).getByLabelText('Username'), 'me')
    await user.type(within(form).getByLabelText('App password'), 'secret')
    await user.click(within(form).getByRole('button', { name: 'Connect' }))

    const warning = await within(form).findByTestId('calendar-writer-compat-warning')
    expect(warning).toHaveTextContent('Old PC')
    expect(mocks.connectProvider).not.toHaveBeenCalled()
    expect(within(form).getByRole('button', { name: 'Connect' })).toBeDisabled()

    await user.click(within(warning).getByRole('checkbox'))
    await user.click(within(form).getByRole('button', { name: 'Connect' }))

    await waitFor(() =>
      expect(mocks.connectProvider).toHaveBeenCalledWith({
        provider: 'writable-single',
        connection: {
          kind: 'basic',
          serverUrl: 'https://dav.example.com',
          username: 'me',
          password: 'secret',
          acknowledgeOutdatedDevices: true
        }
      })
    )
  })
})
