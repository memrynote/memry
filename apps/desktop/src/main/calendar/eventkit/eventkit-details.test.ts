import { describe, expect, it } from 'vitest'
import {
  eventKitAttendees,
  eventKitConference,
  eventKitRecurrence,
  eventKitReminders
} from './eventkit-details'
import type { EventKitEvent, EventKitParticipant } from './eventkit-types'

function participant(overrides: Partial<EventKitParticipant>): EventKitParticipant {
  return {
    name: null,
    email: null,
    status: 'pending',
    role: 'required',
    type: 'person',
    isCurrentUser: false,
    ...overrides
  }
}

function event(overrides: Partial<EventKitEvent> = {}): EventKitEvent {
  return {
    calendarId: 'work',
    eventId: 'local-1',
    externalId: 'server-1',
    title: 'Monetization stand-up',
    location: null,
    notes: null,
    url: null,
    isAllDay: false,
    start: '2026-09-23T09:30:00.000Z',
    end: '2026-09-23T09:45:00.000Z',
    timeZone: 'Europe/Istanbul',
    startDate: null,
    lastDate: null,
    status: 'confirmed',
    availability: 'busy',
    isRecurring: true,
    lastModified: null,
    occurrenceStart: null,
    attendees: [],
    organizer: null,
    alarmMinutes: [],
    recurrenceRule: null,
    ...overrides
  }
}

// What Google Calendar writes into an event's notes, as Calendar.app hands it over.
const GOOGLE_NOTES = [
  'If you got a blocker or a funny story, tell everyone about it.',
  '',
  '-::~:~::~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~::~:~::-',
  'Join with Google Meet: https://meet.google.com/fmf-mjds-dpp',
  'Or dial: (US) +1 204-01-684-3407 PIN: 714957213#',
  'tel:+1-204-01-684-3407;714957213#',
  'Please do not edit this section.',
  '-::~:~::~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~::~:~::-'
].join('\n')

describe('EventKit event details (#2374)', () => {
  it('lists attendees with the organizer first, their answers, and who you are', () => {
    const organizer = participant({
      name: 'Lapets',
      email: 'lapets@adeven.com',
      status: 'accepted'
    })
    const attendees = eventKitAttendees(
      event({
        organizer,
        attendees: [
          participant({
            email: 'kaan.karaca@adeven.com',
            status: 'accepted',
            isCurrentUser: true
          }),
          participant({ email: 'viktoriia@adjust.com', status: 'declined', role: 'optional' }),
          { ...organizer },
          participant({ name: 'Backend-Monetization', type: 'group' })
        ]
      })
    )

    expect(attendees).toEqual([
      {
        email: 'lapets@adeven.com',
        displayName: 'Lapets',
        responseStatus: 'accepted',
        optional: false,
        organizer: true,
        self: false
      },
      {
        email: 'kaan.karaca@adeven.com',
        displayName: null,
        responseStatus: 'accepted',
        optional: false,
        organizer: false,
        self: true
      },
      {
        email: 'viktoriia@adjust.com',
        displayName: null,
        responseStatus: 'declined',
        optional: true,
        organizer: false,
        self: false
      },
      {
        email: '',
        displayName: 'Backend-Monetization',
        responseStatus: 'needsAction',
        optional: false,
        organizer: false,
        self: false
      }
    ])
  })

  it('adds an organizer who is missing from the attendee list, and skips a solo event', () => {
    const organizer = participant({ email: 'boss@example.com', status: 'accepted' })
    expect(
      eventKitAttendees(
        event({ organizer, attendees: [participant({ email: 'me@example.com' })] })
      )?.map((attendee) => [attendee.email, attendee.organizer])
    ).toEqual([
      ['boss@example.com', true],
      ['me@example.com', false]
    ])
    expect(eventKitAttendees(event({ organizer, attendees: [] }))).toBeNull()
  })

  it('turns alerts into popup reminders and drops ones after the start', () => {
    expect(eventKitReminders(event({ alarmMinutes: [10, 60, 10, -5] }))).toEqual({
      useDefault: false,
      overrides: [
        { method: 'popup', minutes: 60 },
        { method: 'popup', minutes: 10 }
      ]
    })
    expect(eventKitReminders(event())).toBeNull()
  })

  it('stores the series rule the way Memry stores its own', () => {
    expect(eventKitRecurrence(event({ recurrenceRule: 'FREQ=WEEKLY;BYDAY=TU,WE' }))).toEqual({
      rrule: 'FREQ=WEEKLY;BYDAY=TU,WE'
    })
    expect(eventKitRecurrence(event())).toBeNull()
  })

  it('finds the Google Meet link and dial-in in the notes', () => {
    expect(eventKitConference(event({ notes: GOOGLE_NOTES }))).toEqual({
      conferenceSolution: { key: { type: 'hangoutsMeet' }, name: 'Google Meet' },
      entryPoints: [
        {
          entryPointType: 'video',
          uri: 'https://meet.google.com/fmf-mjds-dpp',
          label: 'meet.google.com/fmf-mjds-dpp'
        },
        { entryPointType: 'phone', uri: 'tel:+1-204-01-684-3407;714957213#' }
      ]
    })
  })

  it('finds Zoom and Teams links in the location or URL, and nothing in plain text', () => {
    expect(
      eventKitConference(event({ location: 'https://acme.zoom.us/j/123456789?pwd=abc' }))
        ?.conferenceSolution?.name
    ).toBe('Zoom')
    expect(
      eventKitConference(
        event({ url: 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc/0' })
      )?.conferenceSolution?.name
    ).toBe('Microsoft Teams')
    expect(eventKitConference(event({ notes: 'Bring snacks. https://example.com' }))).toBeNull()
  })
})
