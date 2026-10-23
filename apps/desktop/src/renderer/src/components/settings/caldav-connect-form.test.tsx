import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import type { i18n as I18nInstance } from 'i18next'
import { createRendererI18n } from '@memry/i18n/renderer'
import type {
  CalendarProviderAccountStatus,
  CalendarProviderDescriptor,
  CalendarProviderStatus
} from '@memry/contracts/calendar-api'
import { renderWithProviders, userEvent } from '@tests/utils/render'
import { CaldavConnectForm } from './caldav-connect-form'
import { CaldavProviderPanel } from './caldav-provider-panel'

const mocks = vi.hoisted(() => ({
  discoverProviderCalendars: vi.fn(),
  connectProvider: vi.fn(),
  checkProviderWriterCompat: vi.fn(),
  getProviderStatus: vi.fn(),
  listSources: vi.fn(),
  disconnectProvider: vi.fn(),
  refreshProvider: vi.fn(),
  updateSourceSelection: vi.fn(),
  retrySourceSync: vi.fn()
}))

vi.mock('@/services/calendar-service', () => ({
  onCalendarChanged: vi.fn(() => () => {}),
  calendarService: mocks
}))

const CALDAV: CalendarProviderDescriptor = {
  id: 'caldav',
  capabilities: {
    supportsWrite: false,
    supportsCreateCalendar: false,
    supportsPush: false,
    supportsMultiAccount: true,
    requiresMemryAccount: false,
    mirrorScope: 'synced',
    sourceScope: 'synced',
    incrementalMode: 'sync-collection',
    authFlow: 'basic',
    pollIntervalMs: 900000
  }
}

let i18nEn: I18nInstance

function renderForm(props: Partial<React.ComponentProps<typeof CaldavConnectForm>> = {}) {
  const onConnected = vi.fn()
  renderWithProviders(
    <I18nextProvider i18n={i18nEn}>
      <CaldavConnectForm provider={CALDAV} onConnected={onConnected} {...props} />
    </I18nextProvider>
  )
  return { onConnected }
}

describe('CalDAV connect form (#1401)', () => {
  beforeAll(async () => {
    i18nEn = await createRendererI18n({ locale: 'en' })
  })

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.discoverProviderCalendars.mockResolvedValue({
      success: true,
      calendars: [
        { id: 'https://p42-caldav.icloud.com/1/calendars/home/', title: 'Home', color: null },
        { id: 'https://p42-caldav.icloud.com/1/calendars/work/', title: 'Work', color: null }
      ]
    })
    mocks.connectProvider.mockResolvedValue({ success: true })
  })

  it('tests the iCloud preset, lists the calendars found, and connects only the chosen ones', async () => {
    const user = userEvent.setup()
    const { onConnected } = renderForm()

    await user.type(screen.getByLabelText('Username'), 'me@icloud.com')
    await user.type(screen.getByLabelText('App password'), 'abcd-efgh-ijkl-mnop')
    await user.click(screen.getByRole('button', { name: 'Test connection' }))

    expect(mocks.discoverProviderCalendars).toHaveBeenCalledWith({
      provider: 'caldav',
      connection: {
        kind: 'basic',
        serverUrl: 'https://caldav.icloud.com/',
        username: 'me@icloud.com',
        password: 'abcd-efgh-ijkl-mnop',
        preset: 'icloud'
      }
    })
    expect(mocks.connectProvider).not.toHaveBeenCalled()

    const list = await screen.findByTestId('caldav-discovered-calendars')
    await user.click(within(list).getByRole('checkbox', { name: 'Work' }))
    await user.click(screen.getByRole('button', { name: 'Connect' }))

    await waitFor(() =>
      expect(mocks.connectProvider).toHaveBeenCalledWith({
        provider: 'caldav',
        connection: expect.objectContaining({
          serverUrl: 'https://caldav.icloud.com/',
          selectedCalendarIds: ['https://p42-caldav.icloud.com/1/calendars/home/']
        })
      })
    )
    expect(onConnected).toHaveBeenCalled()
  })

  it('names the real failure when iCloud rejects the password', async () => {
    mocks.discoverProviderCalendars.mockResolvedValue({
      success: false,
      calendars: [],
      errorCode: 'unauthorized'
    })
    const user = userEvent.setup()
    renderForm()

    await user.type(screen.getByLabelText('Username'), 'me@icloud.com')
    await user.type(screen.getByLabelText('App password'), 'my-apple-id-password')
    await user.click(screen.getByRole('button', { name: 'Test connection' }))

    expect(await screen.findByTestId('caldav-connect-error')).toHaveTextContent(
      'iCloud needs an app-specific password here, not your Apple ID password'
    )
  })

  it('builds the Nextcloud address from the server name', async () => {
    const user = userEvent.setup()
    renderForm()

    await user.selectOptions(screen.getByLabelText('Service'), 'nextcloud')
    await user.type(screen.getByLabelText('Server name'), 'cloud.example.com')
    await user.type(screen.getByLabelText('Username'), 'me')
    await user.type(screen.getByLabelText('App password'), 'secret')
    await user.click(screen.getByRole('button', { name: 'Test connection' }))

    expect(mocks.discoverProviderCalendars).toHaveBeenCalledWith(
      expect.objectContaining({
        connection: expect.objectContaining({
          serverUrl: 'https://cloud.example.com/remote.php/dav/',
          preset: 'nextcloud'
        })
      })
    )
  })

  it('reconnects with the stored server and username and keeps the calendar choices', async () => {
    const user = userEvent.setup()
    renderForm({
      reconnect: {
        serverUrl: 'https://caldav.icloud.com/',
        username: 'me@icloud.com',
        preset: 'icloud'
      }
    })

    expect(screen.queryByLabelText('Service')).toBeNull()
    expect(screen.getByTestId('caldav-reconnect-account')).toHaveTextContent('me@icloud.com')
    await user.type(screen.getByLabelText('App password'), 'new-app-password')
    await user.click(screen.getByRole('button', { name: 'Test connection' }))
    await user.click(await screen.findByRole('button', { name: 'Connect' }))

    await waitFor(() => expect(mocks.connectProvider).toHaveBeenCalled())
    const connection = mocks.connectProvider.mock.calls[0][0].connection
    expect(connection).toMatchObject({
      serverUrl: 'https://caldav.icloud.com/',
      username: 'me@icloud.com',
      password: 'new-app-password'
    })
    expect(connection).not.toHaveProperty('selectedCalendarIds')
  })
})

describe('CalDAV reconnect_required copy (#1401)', () => {
  beforeAll(async () => {
    i18nEn = await createRendererI18n({ locale: 'en' })
  })

  function account(
    overrides: Partial<CalendarProviderAccountStatus>
  ): CalendarProviderAccountStatus {
    return {
      accountId: 'caldav-1',
      email: 'me@icloud.com',
      status: 'reconnect_required',
      lastSyncedAt: null,
      lastError: null,
      serverUrl: 'https://caldav.icloud.com/',
      username: 'me@icloud.com',
      preset: 'icloud',
      ...overrides
    }
  }

  function renderPanel(accountStatus: CalendarProviderAccountStatus): void {
    const status: CalendarProviderStatus = {
      provider: 'caldav',
      connected: true,
      hasLocalAuth: false,
      account: { id: 'caldav-account:caldav-1', title: 'me@icloud.com' },
      accounts: [accountStatus],
      calendars: { total: 1, selected: 1, memryManaged: 0 },
      lastSyncedAt: null
    }
    mocks.getProviderStatus.mockResolvedValue(status)
    mocks.listSources.mockResolvedValue({ sources: [] })
    window.api = {
      ...window.api,
      settings: {
        ...window.api.settings,
        getCalendarProviderSettings: vi.fn(async () => ({ agentReadEventsConsent: null })),
        setCalendarProviderSettings: vi.fn(async () => ({ success: true }))
      }
    }
    renderWithProviders(
      <I18nextProvider i18n={i18nEn}>
        <CaldavProviderPanel provider={CALDAV} />
      </I18nextProvider>
    )
  }

  it('tells an iCloud user a revoked app password is why sync stopped, and offers a reconnect', async () => {
    renderPanel(account({ reconnectReason: 'rejected' }))
    const notice = await screen.findByTestId('calendar-provider-reconnect-caldav-1')
    expect(notice).toHaveTextContent(
      'Resetting your Apple ID password revokes every app-specific password'
    )

    await userEvent.setup().click(within(notice).getByRole('button', { name: 'Reconnect' }))
    expect(await screen.findByTestId('caldav-connect-form-reconnect')).toBeInTheDocument()
  })

  it('tells a second device it only lacks the password, not that sync failed', async () => {
    renderPanel(account({ reconnectReason: 'missing' }))
    expect(await screen.findByTestId('calendar-provider-reconnect-caldav-1')).toHaveTextContent(
      'Its events still arrive from your other devices'
    )
  })
})
