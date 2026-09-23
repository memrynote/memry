import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import type { i18n as I18nInstance } from 'i18next'
import { createRendererI18n } from '@memry/i18n/renderer'
import { renderWithProviders, userEvent } from '@tests/utils/render'
import type { CalendarSourceRecord } from '@/services/calendar-service'
import { IcsCalendarSubscriptions } from './ics-calendar-subscriptions'

const { mockListSources, mockSubscribe, mockRefresh, mockUnsubscribe } = vi.hoisted(() => ({
  mockListSources: vi.fn(),
  mockSubscribe: vi.fn(),
  mockRefresh: vi.fn(),
  mockUnsubscribe: vi.fn()
}))

vi.mock('@/services/calendar-service', () => ({
  onCalendarChanged: vi.fn(() => () => {}),
  calendarService: {
    listSources: mockListSources,
    subscribeIcsCalendar: mockSubscribe,
    refreshIcsCalendar: mockRefresh,
    unsubscribeIcsCalendar: mockUnsubscribe
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
})
