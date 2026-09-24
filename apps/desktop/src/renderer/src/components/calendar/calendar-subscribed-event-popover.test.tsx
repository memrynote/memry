import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import type { i18n as I18nInstance } from 'i18next'
import { createRendererI18n } from '@memry/i18n/renderer'
import type {
  CalendarExternalEventDetails,
  CalendarProjectionItem
} from '@memry/contracts/calendar-api'
import { renderWithProviders, userEvent } from '@tests/utils/render'
import { CalendarSubscribedEventPopover } from './calendar-subscribed-event-popover'

const mocks = vi.hoisted(() => ({ getExternalEvent: vi.fn() }))

vi.mock('@/services/calendar-service', () => ({
  calendarService: { getExternalEvent: mocks.getExternalEvent }
}))

const ITEM: CalendarProjectionItem = {
  projectionId: 'external_event:evt-1',
  sourceType: 'external_event',
  sourceId: 'evt-1',
  title: 'M[onetization]-Up!',
  descriptionPreview: 'If you got a blocker…',
  startAt: '2026-10-13T09:30:00.000Z',
  endAt: '2026-10-13T09:45:00.000Z',
  isAllDay: false,
  timezone: 'Europe/Istanbul',
  visualType: 'external_event',
  editability: { canMove: false, canResize: false, canEditText: false, canDelete: false },
  source: {
    provider: 'apple-eventkit',
    calendarSourceId: 'apple-eventkit:work',
    title: 'kaan.karaca@adeven.com',
    color: '#4fc3f7',
    kind: 'calendar',
    isMemryManaged: false
  },
  binding: null,
  snoozeOffsetMinutes: null
}

const DETAILS: CalendarExternalEventDetails = {
  id: 'evt-1',
  title: 'M[onetization]-Up!',
  description: [
    'If you got a blocker or a funny story, tell everyone about it.',
    'Standup board: https://adjustcom.atlassian.net/secure/RapidBoard.jspa?rapidView=259',
    '',
    '-::~:~::~:~:~:~:~:~::~:~::-',
    'Join with Google Meet: https://meet.google.com/fmf-mjds-dpp',
    'Please do not edit this section.',
    '-::~:~::~:~:~:~:~:~::~:~::-'
  ].join('\n'),
  location: null,
  startAt: ITEM.startAt,
  endAt: ITEM.endAt,
  timezone: 'Europe/Istanbul',
  isAllDay: false,
  status: 'confirmed',
  recurrenceRule: { rrule: 'FREQ=WEEKLY;BYDAY=FR,TH,TU,WE' },
  attendees: [
    {
      email: 'lapets@adeven.com',
      displayName: null,
      responseStatus: 'accepted',
      organizer: true
    },
    { email: 'kaan.karaca@adeven.com', responseStatus: 'accepted', self: true },
    { email: '', displayName: 'Backend-Monetization', responseStatus: 'needsAction' }
  ],
  reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 10 }] },
  conferenceData: {
    conferenceSolution: { key: { type: 'hangoutsMeet' }, name: 'Google Meet' },
    entryPoints: [
      { entryPointType: 'video', uri: 'https://meet.google.com/fmf-mjds-dpp' },
      { entryPointType: 'phone', uri: 'tel:+1-204-01-684-3407;714957213#' }
    ]
  },
  source: {
    id: 'apple-eventkit:work',
    provider: 'apple-eventkit',
    title: 'Work',
    color: '#4fc3f7',
    accountTitle: 'kaan.karaca@adeven.com'
  }
}

let i18nEn: I18nInstance

function renderCard(item: CalendarProjectionItem = ITEM, onDismiss = vi.fn()): void {
  renderWithProviders(
    <I18nextProvider i18n={i18nEn}>
      <CalendarSubscribedEventPopover
        target={{ item, anchorRect: { x: 10, y: 10, width: 100, height: 20 } }}
        onDismiss={onDismiss}
      />
    </I18nextProvider>
  )
}

describe('read-only event card (#2374)', () => {
  beforeAll(async () => {
    i18nEn = await createRendererI18n({ locale: 'en' })
  })

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getExternalEvent.mockResolvedValue({ event: DETAILS })
  })

  it('shows what Calendar.app shows: series, alert, join link, attendees, calendar', async () => {
    renderCard()

    const card = await screen.findByTestId('calendar-subscribed-event-popover')
    expect(mocks.getExternalEvent).toHaveBeenCalledWith({ externalEventId: 'evt-1' })
    expect(card).toHaveTextContent('This Mac')
    expect(
      await within(card).findByText(
        'Repeats every week on Tuesday, Wednesday, Thursday, and Friday'
      )
    ).toBeInTheDocument()
    expect(within(card).getByText('Alert 10 minutes before')).toBeInTheDocument()

    const join = within(card).getByTestId('calendar-read-only-join')
    expect(join).toHaveTextContent('Google Meet')
    expect(within(join).getByRole('link', { name: 'Join meeting' })).toHaveAttribute(
      'href',
      'https://meet.google.com/fmf-mjds-dpp'
    )
    expect(join).toHaveTextContent('+1-204-01-684-3407 · PIN 714957213#')

    const attendees = within(card).getByRole('region', { name: 'Attendees' })
    expect(attendees).toHaveTextContent('Attendees (3)')
    expect(attendees).toHaveTextContent('lapets@adeven.comorganizer')
    expect(attendees).toHaveTextContent('kaan.karaca@adeven.comyou')
    expect(attendees).toHaveTextContent('Backend-Monetization')
    expect(within(attendees).getAllByRole('img', { name: 'Accepted' })).toHaveLength(2)

    expect(card).toHaveTextContent('Work')
    expect(card).not.toHaveTextContent('Read-only')
  })

  it('makes description links clickable and drops the Meet boilerplate', async () => {
    renderCard()

    const card = await screen.findByTestId('calendar-subscribed-event-popover')
    expect(
      await within(card).findByRole('link', {
        name: 'https://adjustcom.atlassian.net/secure/RapidBoard.jspa?rapidView=259'
      })
    ).toBeInTheDocument()
    expect(card).not.toHaveTextContent('Please do not edit this section.')
  })

  it('keeps the subscribed-feed wording and still opens when details fail to load', async () => {
    mocks.getExternalEvent.mockRejectedValue(new Error('boom'))
    renderCard({
      ...ITEM,
      source: { ...ITEM.source, provider: 'ics', title: 'Club fixtures' }
    })

    const card = await screen.findByTestId('calendar-subscribed-event-popover')
    expect(card).toHaveTextContent('Subscribed calendar · Club fixtures')
    expect(card).toHaveTextContent('If you got a blocker…')
    expect(await within(card).findByRole('alert')).toBeInTheDocument()
    expect(card).not.toHaveTextContent('Read-only')
  })

  it('closes from its close button', async () => {
    const onDismiss = vi.fn()
    const user = userEvent.setup()
    renderCard(ITEM, onDismiss)

    await user.click(await screen.findByRole('button', { name: 'Close' }))
    expect(onDismiss).toHaveBeenCalled()
  })
})
