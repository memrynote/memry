import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import type { i18n as I18nInstance } from 'i18next'
import { createRendererI18n } from '@memry/i18n/renderer'
import { renderWithProviders, userEvent } from '@tests/utils/render'
import type { CalendarSourceRecord } from '@/services/calendar-service'
import { IcsCalendarSubscriptions } from './ics-calendar-subscriptions'

const { mockListSources, mockSubscribe, mockRefresh, mockUnsubscribe, mockUpdate, toastMock } =
  vi.hoisted(() => ({
    mockListSources: vi.fn(),
    mockSubscribe: vi.fn(),
    mockRefresh: vi.fn(),
    mockUnsubscribe: vi.fn(),
    mockUpdate: vi.fn(),
    toastMock: { success: vi.fn() }
  }))

vi.mock('sonner', () => ({ toast: toastMock }))

vi.mock('@/services/calendar-service', () => ({
  onCalendarChanged: vi.fn(() => () => {}),
  calendarService: {
    listSources: mockListSources,
    subscribeIcsCalendar: mockSubscribe,
    refreshIcsCalendar: mockRefresh,
    unsubscribeIcsCalendar: mockUnsubscribe,
    updateIcsCalendar: mockUpdate
  }
}))

const FAILING_SOURCE: CalendarSourceRecord = {
  id: 'ics-calendar:abc',
  provider: 'ics',
  kind: 'calendar',
  accountId: null,
  remoteId: 'https://calendar.proton.me/api/calendar/v1/url/secret/calendar.ics',
  title: 'Proton Personal',
  timezone: null,
  color: null,
  isPrimary: false,
  isSelected: true,
  isMemryManaged: false,
  syncCursor: null,
  syncStatus: 'error',
  lastSyncedAt: '2026-05-01T12:00:00.000Z',
  lastError: 'unauthorized',
  metadata: null,
  archivedAt: null,
  syncedAt: null,
  createdAt: '2026-05-01T12:00:00.000Z',
  modifiedAt: '2026-05-01T12:00:00.000Z'
}

let i18nEn: I18nInstance

/** With no subscriptions the row starts collapsed; open it to reach the link field. */
async function expandSubscriptions(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Subscribed calendars' }))
}

function renderSubscriptions() {
  return renderWithProviders(
    <I18nextProvider i18n={i18nEn}>
      <IcsCalendarSubscriptions />
    </I18nextProvider>
  )
}

describe('Subscribed calendars (Settings → Calendar)', () => {
  beforeAll(async () => {
    i18nEn = await createRendererI18n({ locale: 'en' })
  })

  beforeEach(() => {
    mockListSources.mockReset()
    mockSubscribe.mockReset()
    mockRefresh.mockReset()
    mockUnsubscribe.mockReset()
    mockUpdate.mockReset()
    toastMock.success.mockReset()
    mockListSources.mockResolvedValue({ sources: [] })
  })

  it('subscribes with the pasted link and explains why a link was rejected', async () => {
    mockSubscribe.mockResolvedValue({
      success: false,
      source: null,
      errorCode: 'not_a_calendar',
      error: 'not_a_calendar'
    })
    const user = userEvent.setup()
    renderSubscriptions()
    await expandSubscriptions(user)

    await user.type(screen.getByTestId('ics-subscribe-url'), '  webcal://example.com/feed.ics ')
    await user.click(screen.getByTestId('ics-subscribe-submit'))

    expect(mockSubscribe).toHaveBeenCalledWith({ url: 'webcal://example.com/feed.ics' })
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "This link does not return a calendar. Copy the ICS or webcal link from your calendar app's sharing settings."
    )
    expect(screen.getByTestId('ics-subscribe-url')).toHaveValue('  webcal://example.com/feed.ics ')
  })

  it('lists a subscription by host only, with its failure and a working refresh', async () => {
    mockListSources.mockResolvedValue({ sources: [FAILING_SOURCE] })
    mockRefresh.mockResolvedValue({ success: true, source: FAILING_SOURCE })
    const user = userEvent.setup()
    renderSubscriptions()

    const row = await screen.findByTestId(`ics-source-row-${FAILING_SOURCE.id}`)
    expect(row).toHaveTextContent('Proton Personal')
    expect(row).toHaveTextContent('calendar.proton.me · Read-only')
    expect(row).not.toHaveTextContent('secret')
    expect(row).toHaveTextContent(
      'The calendar refused access. Copy a fresh sharing link from your calendar app. Events already on your calendar stay until the next successful update.'
    )

    await user.click(screen.getByTestId(`ics-source-refresh-${FAILING_SOURCE.id}`))
    await waitFor(() => expect(mockRefresh).toHaveBeenCalledWith({ sourceId: FAILING_SOURCE.id }))
  })

  it('warns before subscribing to a plain http link, and marks an http subscription', async () => {
    const HTTP_SOURCE: CalendarSourceRecord = {
      ...FAILING_SOURCE,
      id: 'ics-calendar:lan',
      remoteId: 'http://nas.local/cal.ics',
      title: 'Home NAS',
      syncStatus: 'ok',
      lastError: null
    }
    mockListSources.mockResolvedValue({ sources: [HTTP_SOURCE] })
    const user = userEvent.setup()
    renderSubscriptions()
    const row = await screen.findByTestId(`ics-source-row-${HTTP_SOURCE.id}`)

    const input = screen.getByTestId('ics-subscribe-url')
    await user.type(input, 'https://example.com/feed.ics')
    expect(screen.queryByTestId('ics-subscribe-http-warning')).toBeNull()

    await user.clear(input)
    await user.type(input, 'HTTP://example.com/feed.ics')
    const warning = screen.getByTestId('ics-subscribe-http-warning')
    expect(warning).toHaveTextContent('travel unencrypted')
    expect(input).toHaveAttribute('aria-describedby', warning.id)

    expect(row).toHaveTextContent('nas.local · Read-only · Not encrypted')
  })

  it('renames a subscription in place; Escape cancels without saving', async () => {
    mockListSources.mockResolvedValue({ sources: [FAILING_SOURCE] })
    mockUpdate.mockResolvedValue({
      success: true,
      source: { ...FAILING_SOURCE, title: 'Family' }
    })
    const user = userEvent.setup()
    renderSubscriptions()

    await user.click(await screen.findByTestId(`ics-source-rename-${FAILING_SOURCE.id}`))
    const field = screen.getByTestId(`ics-source-title-input-${FAILING_SOURCE.id}`)
    expect(field).toHaveValue('Proton Personal')
    await user.keyboard('{Escape}')
    expect(screen.queryByTestId(`ics-source-title-input-${FAILING_SOURCE.id}`)).toBeNull()
    expect(mockUpdate).not.toHaveBeenCalled()

    await user.click(screen.getByTestId(`ics-source-rename-${FAILING_SOURCE.id}`))
    const reopened = screen.getByTestId(`ics-source-title-input-${FAILING_SOURCE.id}`)
    await user.clear(reopened)
    expect(screen.getByTestId(`ics-source-title-save-${FAILING_SOURCE.id}`)).toBeDisabled()
    await user.type(reopened, '  Family {Enter}')

    await waitFor(() =>
      expect(mockUpdate).toHaveBeenCalledWith({ sourceId: FAILING_SOURCE.id, title: 'Family' })
    )
    await waitFor(() =>
      expect(screen.queryByTestId(`ics-source-title-input-${FAILING_SOURCE.id}`)).toBeNull()
    )
  })

  it('recolours a subscription from the event colours', async () => {
    mockListSources.mockResolvedValue({
      sources: [{ ...FAILING_SOURCE, color: '#33b679' }]
    })
    mockUpdate.mockResolvedValue({ success: true, source: FAILING_SOURCE })
    const user = userEvent.setup()
    renderSubscriptions()

    await user.click(await screen.findByTestId(`ics-source-color-${FAILING_SOURCE.id}`))
    expect(screen.getByTestId('ics-source-color-option-sage')).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    await user.click(screen.getByRole('button', { name: 'Color: Grape' }))

    await waitFor(() =>
      expect(mockUpdate).toHaveBeenCalledWith({ sourceId: FAILING_SOURCE.id, color: 'grape' })
    )
  })

  it('confirms a new subscription with what it found', async () => {
    mockSubscribe.mockResolvedValue({
      success: true,
      source: { ...FAILING_SOURCE, syncStatus: 'ok', lastError: null },
      summary: {
        eventCount: 12,
        firstStartAt: '2026-05-10T09:00:00.000Z',
        lastStartAt: '2026-11-20T09:00:00.000Z'
      }
    })
    const user = userEvent.setup()
    renderSubscriptions()
    await expandSubscriptions(user)

    await user.type(screen.getByTestId('ics-subscribe-url'), 'webcal://example.com/feed.ics')
    await user.click(screen.getByTestId('ics-subscribe-submit'))

    await waitFor(() =>
      expect(toastMock.success).toHaveBeenCalledWith(
        'Added Proton Personal: 12 events, May 10, 2026 to Nov 20, 2026.'
      )
    )
    expect(screen.getByTestId('ics-subscribe-url')).toHaveValue('')
  })

  it('explains where to find a link, and that Proton stays read-only by design', async () => {
    const user = userEvent.setup()
    renderSubscriptions()
    await expandSubscriptions(user)

    expect(screen.queryByTestId('ics-link-help-proton')).toBeNull()
    await user.click(screen.getByTestId('ics-link-help-toggle'))

    const proton = screen.getByTestId('ics-link-help-proton')
    expect(proton).toHaveTextContent('Share with anyone')
    expect(proton).toHaveTextContent('read-only in memrynote by design')
    expect(proton).toHaveTextContent('no CalDAV')
    expect(screen.getByTestId('ics-link-help-outlook')).toHaveTextContent('Publish a calendar')
  })
})
