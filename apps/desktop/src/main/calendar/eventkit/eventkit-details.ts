import type {
  CalendarAttendee,
  CalendarConferenceData,
  CalendarConferenceEntryPoint,
  CalendarReminders
} from '@memry/db-schema/schema/calendar-events'
import type { EventKitEvent, EventKitParticipant } from './eventkit-types'

/**
 * EventKit's event details in the shapes the mirror already stores for Google
 * (`attendees`, `reminders`, `recurrenceRule`, `conferenceData`), so the
 * read-only event card shows them the same way (#2374).
 */

function responseStatus(status: string): CalendarAttendee['responseStatus'] {
  if (status === 'accepted' || status === 'declined' || status === 'tentative') return status
  return 'needsAction'
}

function sameParticipant(left: EventKitParticipant, right: EventKitParticipant): boolean {
  if (left.email && right.email) return left.email.toLowerCase() === right.email.toLowerCase()
  return !left.email && !right.email && left.name === right.name
}

function toAttendee(participant: EventKitParticipant, organizer: boolean): CalendarAttendee {
  return {
    email: participant.email ?? '',
    displayName: participant.name,
    responseStatus: responseStatus(participant.status),
    optional: participant.role === 'optional',
    organizer,
    self: participant.isCurrentUser
  }
}

/** Attendees with the organizer first. Null when EventKit lists nobody. */
export function eventKitAttendees(event: EventKitEvent): CalendarAttendee[] | null {
  const { organizer } = event
  const isOrganizer = (participant: EventKitParticipant): boolean =>
    participant.role === 'chair' || (organizer !== null && sameParticipant(participant, organizer))
  const attendees = event.attendees
    .filter((participant) => participant.email || participant.name)
    .map((participant) => toAttendee(participant, isOrganizer(participant)))
  if (
    organizer &&
    !event.attendees.some((participant) => sameParticipant(participant, organizer))
  ) {
    // A meeting's organizer is not always in its attendee list.
    if (attendees.length > 0 && (organizer.email || organizer.name)) {
      attendees.unshift(toAttendee(organizer, true))
    }
  }
  attendees.sort((left, right) => Number(right.organizer) - Number(left.organizer))
  return attendees.length > 0 ? attendees : null
}

/** Alerts before the start, soonest last, as popup reminders. */
export function eventKitReminders(event: EventKitEvent): CalendarReminders | null {
  const minutes = [...new Set(event.alarmMinutes.filter((value) => value >= 0))].sort(
    (left, right) => right - left
  )
  if (minutes.length === 0) return null
  return {
    useDefault: false,
    overrides: minutes.map((value) => ({ method: 'popup' as const, minutes: value }))
  }
}

/** The rule in the shape Memry stores for its own events: `{ rrule: 'FREQ=...' }`. */
export function eventKitRecurrence(event: EventKitEvent): Record<string, unknown> | null {
  return event.recurrenceRule ? { rrule: event.recurrenceRule } : null
}

interface ConferenceService {
  name: string
  key: string
  pattern: RegExp
}

const CONFERENCE_SERVICES: ConferenceService[] = [
  {
    name: 'Google Meet',
    key: 'hangoutsMeet',
    pattern: /https:\/\/meet\.google\.com\/[a-z0-9-]+(?:\?[^\s<>"')\]]*)?/i
  },
  {
    name: 'Zoom',
    key: 'zoom',
    pattern: /https:\/\/(?:[\w-]+\.)?zoom\.us\/(?:j|my|w)\/[^\s<>"')\]]+/i
  },
  {
    name: 'Microsoft Teams',
    key: 'teams',
    pattern: /https:\/\/teams\.microsoft\.com\/l\/meetup-join\/[^\s<>"')\]]+/i
  },
  {
    name: 'Webex',
    key: 'webex',
    pattern: /https:\/\/[\w-]+\.webex\.com\/[^\s<>"')\]]+/i
  }
]

const PHONE_PATTERN = /tel:\+?[0-9][0-9;,#*+-]*/i

/**
 * Google, Zoom, Teams and Webex put the join link in the event's URL,
 * location or notes; EventKit has no conference field. This finds it the way
 * Calendar.app does, so the card can offer a Join button.
 */
export function eventKitConference(event: EventKitEvent): CalendarConferenceData | null {
  const haystacks = [event.url, event.location, event.notes].filter(
    (value): value is string => typeof value === 'string' && value.length > 0
  )
  for (const service of CONFERENCE_SERVICES) {
    for (const text of haystacks) {
      const match = service.pattern.exec(text)
      if (!match) continue
      const entryPoints: CalendarConferenceEntryPoint[] = [
        { entryPointType: 'video', uri: match[0], label: match[0].replace(/^https:\/\//, '') }
      ]
      const phone = event.notes ? PHONE_PATTERN.exec(event.notes) : null
      if (phone) entryPoints.push({ entryPointType: 'phone', uri: phone[0] })
      return {
        conferenceSolution: { key: { type: service.key }, name: service.name },
        entryPoints
      }
    }
  }
  return null
}
