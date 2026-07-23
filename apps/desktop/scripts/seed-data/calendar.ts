import { generateId } from '../../src/main/lib/id'
import type { SeedCalendarEvent, SeedCalendarSource } from '../seed-vault/db-writer'
import { seedISOAt } from './date'

const isoDateAt = (days: number, hour: number, minute = 0): string => {
  return seedISOAt(days, hour, minute)
}

const allDayStart = (days: number): string => {
  return seedISOAt(days, 0)
}

const allDayEnd = (days: number): string => {
  return seedISOAt(days + 1, 0)
}

const TOKYO_OFFSET_MS = 9 * 60 * 60 * 1000
const tokyoLocalAt = (days: number, hour: number, minute = 0): string => {
  const d = new Date(seedISOAt(days, hour, minute))
  d.setTime(d.getTime() - TOKYO_OFFSET_MS)
  return d.toISOString()
}

const ISTANBUL_OFFSET_MS = 3 * 60 * 60 * 1000
const istanbulLocalAt = (days: number, hour: number, minute = 0): string => {
  const d = new Date(seedISOAt(days, hour, minute))
  d.setTime(d.getTime() - ISTANBUL_OFFSET_MS)
  return d.toISOString()
}

// ============================================================================
// Calendar Sources (one local, one stub Google)
// ============================================================================

export const CALENDAR_SOURCES: SeedCalendarSource[] = [
  {
    id: generateId(),
    provider: 'memry',
    kind: 'calendar',
    remoteId: 'local-default',
    title: 'memrynote Local',
    color: '#6366f1',
    isPrimary: true,
    isSelected: true,
    isMemryManaged: true,
    syncStatus: 'idle'
  },
  {
    id: generateId(),
    provider: 'google',
    kind: 'account',
    remoteId: 'kaan@example.com',
    title: 'kaan@example.com',
    color: '#4285f4',
    isPrimary: false,
    isSelected: true,
    syncStatus: 'ok',
    lastSyncedAt: isoDateAt(0, 9, 45)
  }
]

// ============================================================================
// Events
// ============================================================================

export const CALENDAR_EVENTS: SeedCalendarEvent[] = [
  // ========================================================================
  // Recurring weekday standup
  // ========================================================================
  {
    id: generateId(),
    title: 'Daily standup',
    description: 'Quick sync, what shipped, what is blocked.',
    startAt: isoDateAt(-29, 9),
    endAt: isoDateAt(-29, 9, 15),
    timezone: 'America/Los_Angeles',
    recurrenceRule: {
      freq: 'WEEKLY',
      interval: 1,
      byDay: ['MO', 'TU', 'WE', 'TH', 'FR']
    },
    location: 'Hangout — meet.google.com/abc-defg-hij',
    colorId: '6366f1',
    reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 5 }] },
    conferenceData: {
      conferenceSolution: { name: 'Google Meet' },
      entryPoints: [
        {
          entryPointType: 'video',
          uri: 'https://meet.google.com/abc-defg-hij',
          label: 'meet.google.com/abc-defg-hij'
        }
      ]
    }
  },

  // ========================================================================
  // Bi-weekly sprint planning
  // ========================================================================
  {
    id: generateId(),
    title: 'Sprint planning',
    description: 'Plan next two weeks. Decisions, not status.',
    startAt: isoDateAt(-26, 10),
    endAt: isoDateAt(-26, 11, 30),
    timezone: 'America/Los_Angeles',
    recurrenceRule: {
      freq: 'WEEKLY',
      interval: 2,
      byDay: ['MO']
    },
    colorId: '6366f1'
  },

  // ========================================================================
  // Weekly 1:1
  // ========================================================================
  {
    id: generateId(),
    title: '1:1 with K.',
    description: 'Career, blockers, anything.',
    startAt: isoDateAt(-28, 14),
    endAt: isoDateAt(-28, 14, 30),
    timezone: 'America/Los_Angeles',
    recurrenceRule: { freq: 'WEEKLY', interval: 1, byDay: ['WE'] },
    colorId: '8b5cf6',
    attendees: [
      { email: 'self@example.com', responseStatus: 'accepted', self: true, organizer: true },
      { email: 'k@example.com', displayName: 'K.', responseStatus: 'accepted' }
    ]
  },

  // ========================================================================
  // Monthly review
  // ========================================================================
  {
    id: generateId(),
    title: 'Monthly review',
    description: "Pull up [[Year in Review 2025]] template. What worked, what didn't.",
    startAt: isoDateAt(-3, 16),
    endAt: isoDateAt(-3, 17),
    timezone: 'America/Los_Angeles',
    recurrenceRule: { freq: 'MONTHLY', interval: 1, byMonthDay: -1 },
    colorId: '10b981'
  },

  // ========================================================================
  // All-day birthday
  // ========================================================================
  {
    id: generateId(),
    title: "M.'s birthday",
    isAllDay: true,
    startAt: allDayStart(11),
    endAt: allDayEnd(11),
    timezone: 'UTC',
    recurrenceRule: { freq: 'YEARLY', interval: 1 },
    colorId: 'f59e0b'
  },

  // ========================================================================
  // Multi-day conference (all-day, 3 days)
  // ========================================================================
  {
    id: generateId(),
    title: 'LocalFirst Conf',
    description: 'Speaking on day 2 — see [[Conference Talk]].',
    location: 'Berlin, Germany',
    isAllDay: true,
    startAt: allDayStart(130),
    endAt: allDayEnd(132),
    timezone: 'Europe/Berlin',
    colorId: 'ec4899'
  },

  // ========================================================================
  // Doctor appointment with reminder
  // ========================================================================
  {
    id: generateId(),
    title: 'Annual physical',
    description: 'Bring blood-work request.',
    location: 'Mission Bay Medical Center, Suite 240',
    startAt: isoDateAt(8, 15),
    endAt: isoDateAt(8, 16),
    timezone: 'America/Los_Angeles',
    colorId: '10b981',
    reminders: {
      useDefault: false,
      overrides: [
        { method: 'popup', minutes: 30 },
        { method: 'email', minutes: 1440 }
      ]
    }
  },

  // ========================================================================
  // Travel block — 5 days, all-day, private
  // ========================================================================
  {
    id: generateId(),
    title: 'Iceland — Ring Road',
    description: 'See [[Iceland Ring Road]].',
    isAllDay: true,
    startAt: allDayStart(96),
    endAt: allDayEnd(105),
    timezone: 'Atlantic/Reykjavik',
    visibility: 'private',
    colorId: 'ec4899'
  },

  // ========================================================================
  // Friend dinner with attendees
  // ========================================================================
  {
    id: generateId(),
    title: 'Dinner — Kura',
    description: 'Try the omakase. Reservations under M.',
    location: '1518 Sutter St, San Francisco',
    startAt: isoDateAt(2, 19),
    endAt: isoDateAt(2, 21, 30),
    timezone: 'America/Los_Angeles',
    colorId: 'f59e0b',
    attendees: [
      { email: 'self@example.com', responseStatus: 'accepted', self: true, organizer: true },
      { email: 'm@example.com', displayName: 'M.', responseStatus: 'accepted' },
      { email: 'd@example.com', displayName: 'D.', responseStatus: 'tentative' },
      { email: 'r@example.com', displayName: 'R.', responseStatus: 'declined' }
    ]
  },

  // ========================================================================
  // Online course with conference data
  // ========================================================================
  {
    id: generateId(),
    title: 'CMU 15-445: Query Optimization (replay)',
    description: 'See [[CMU Database Course]].',
    startAt: isoDateAt(4, 18),
    endAt: isoDateAt(4, 19, 30),
    timezone: 'America/Los_Angeles',
    colorId: '0ea5e9',
    conferenceData: {
      conferenceSolution: { name: 'YouTube' },
      entryPoints: [
        {
          entryPointType: 'video',
          uri: 'https://youtube.com/playlist?list=PLSE8ODhjZXjbohkNBWQs_otTrBTrjyohi',
          label: 'youtube.com — CMU 15-445'
        }
      ]
    }
  },

  // ========================================================================
  // Tokyo time-zone event (a Tokyo dinner from past trip retained for screenshot)
  // ========================================================================
  {
    id: generateId(),
    title: 'Dinner — Tonkatsu Maisen',
    description: 'See [[Tokyo Trip]].',
    location: 'Aoyama, Tokyo',
    startAt: tokyoLocalAt(-25, 19, 30),
    endAt: tokyoLocalAt(-25, 21),
    timezone: 'Asia/Tokyo',
    colorId: 'ec4899'
  },

  // ========================================================================
  // Cancelled event
  // ========================================================================
  {
    id: generateId(),
    title: 'Coffee with R. (cancelled)',
    description: 'Rescheduled — moved to next month.',
    location: 'Sightglass, SoMa',
    startAt: isoDateAt(1, 9, 30),
    endAt: isoDateAt(1, 10, 30),
    timezone: 'America/Los_Angeles',
    colorId: '6b7280',
    visibility: 'default'
  },

  // ========================================================================
  // Deep work blocks (a few, scattered)
  // ========================================================================
  {
    id: generateId(),
    title: '🧠 Deep work — memrynote',
    description: 'No notifications. See [[memrynote Launch]].',
    startAt: isoDateAt(0, 6),
    endAt: isoDateAt(0, 9),
    timezone: 'America/Los_Angeles',
    colorId: '6366f1'
  },
  {
    id: generateId(),
    title: '🧠 Deep work — writing',
    startAt: isoDateAt(1, 6),
    endAt: isoDateAt(1, 8),
    timezone: 'America/Los_Angeles',
    colorId: '6366f1'
  },
  {
    id: generateId(),
    title: '🧠 Deep work — memrynote',
    startAt: isoDateAt(2, 6),
    endAt: isoDateAt(2, 9),
    timezone: 'America/Los_Angeles',
    colorId: '6366f1'
  },
  {
    id: generateId(),
    title: '🧠 Deep work — writing',
    startAt: isoDateAt(3, 6),
    endAt: isoDateAt(3, 8),
    timezone: 'America/Los_Angeles',
    colorId: '6366f1'
  },

  // ========================================================================
  // Workouts
  // ========================================================================
  {
    id: generateId(),
    title: '🏋️ Lift — Lower',
    description: 'See [[Training Split]].',
    location: 'Home gym',
    startAt: isoDateAt(0, 17),
    endAt: isoDateAt(0, 18, 30),
    timezone: 'America/Los_Angeles',
    colorId: '10b981'
  },
  {
    id: generateId(),
    title: '🏋️ Lift — Upper',
    location: 'Home gym',
    startAt: isoDateAt(2, 17),
    endAt: isoDateAt(2, 18, 30),
    timezone: 'America/Los_Angeles',
    colorId: '10b981'
  },
  {
    id: generateId(),
    title: '🏃 Cardio — Zone 2',
    location: 'Park',
    startAt: isoDateAt(1, 17),
    endAt: isoDateAt(1, 17, 30),
    timezone: 'America/Los_Angeles',
    colorId: '10b981'
  },
  {
    id: generateId(),
    title: '🏃 Cardio — Intervals',
    startAt: isoDateAt(4, 8),
    endAt: isoDateAt(4, 8, 30),
    timezone: 'America/Los_Angeles',
    colorId: '10b981'
  },

  // ========================================================================
  // Random life
  // ========================================================================
  {
    id: generateId(),
    title: 'Dentist cleaning',
    location: '1822 Lombard St',
    startAt: isoDateAt(7, 14),
    endAt: isoDateAt(7, 14, 45),
    timezone: 'America/Los_Angeles',
    colorId: 'f59e0b',
    reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 60 }] }
  },
  {
    id: generateId(),
    title: 'Coffee with M.',
    location: 'Sightglass, SoMa',
    startAt: isoDateAt(3, 9, 30),
    endAt: isoDateAt(3, 10, 30),
    timezone: 'America/Los_Angeles',
    colorId: 'f59e0b',
    attendees: [
      { email: 'self@example.com', responseStatus: 'accepted', self: true, organizer: true },
      { email: 'm@example.com', displayName: 'M.', responseStatus: 'accepted' }
    ]
  },
  {
    id: generateId(),
    title: 'Movie — Dune Part Two',
    description: 'See [[Watchlist 2026]].',
    location: 'Alamo Drafthouse',
    startAt: isoDateAt(6, 19, 15),
    endAt: isoDateAt(6, 22),
    timezone: 'America/Los_Angeles',
    colorId: 'ec4899'
  },
  {
    id: generateId(),
    title: 'Friend wedding',
    isAllDay: true,
    startAt: allDayStart(45),
    endAt: allDayEnd(45),
    timezone: 'America/Los_Angeles',
    colorId: 'ec4899'
  },
  {
    id: generateId(),
    title: 'Quarterly tax estimate',
    description: 'Q2 estimate. See [[Finances]].',
    startAt: isoDateAt(40, 10),
    endAt: isoDateAt(40, 11),
    timezone: 'America/Los_Angeles',
    colorId: '6b7280'
  },
  {
    id: generateId(),
    title: 'Annual checkup — eye doctor',
    location: 'Berkeley Eye Center',
    startAt: isoDateAt(28, 11),
    endAt: isoDateAt(28, 12),
    timezone: 'America/Los_Angeles',
    colorId: '10b981'
  },

  // ========================================================================
  // Past — completed events (for the calendar history view)
  // ========================================================================
  {
    id: generateId(),
    title: 'Tokyo flight',
    description: 'See [[Tokyo Trip]].',
    isAllDay: false,
    startAt: isoDateAt(-26, 16),
    endAt: isoDateAt(-26, 23, 30),
    timezone: 'America/Los_Angeles',
    colorId: 'ec4899'
  },
  {
    id: generateId(),
    title: 'Tokyo — Ghibli Museum',
    location: 'Mitaka, Tokyo',
    startAt: tokyoLocalAt(-22, 11),
    endAt: tokyoLocalAt(-22, 13),
    timezone: 'Asia/Tokyo',
    colorId: 'ec4899'
  },
  {
    id: generateId(),
    title: 'Squat PR session',
    description: 'See [[Cutting Log]].',
    location: 'Home gym',
    startAt: isoDateAt(-27, 17),
    endAt: isoDateAt(-27, 18, 30),
    timezone: 'America/Los_Angeles',
    colorId: '10b981'
  },
  {
    id: generateId(),
    title: 'Inbox snooze ship review',
    description: 'PR landed. See [[memrynote Launch]].',
    startAt: isoDateAt(-12, 11),
    endAt: isoDateAt(-12, 12),
    timezone: 'America/Los_Angeles',
    colorId: '6366f1'
  },
  {
    id: generateId(),
    title: 'Lunch — D.',
    location: 'Mensho',
    startAt: isoDateAt(-14, 12, 30),
    endAt: isoDateAt(-14, 13, 30),
    timezone: 'America/Los_Angeles',
    colorId: 'f59e0b'
  },

  // ========================================================================
  // Istanbul weekend — the two blocks the trip project links to
  // ========================================================================
  {
    id: generateId(),
    title: 'Bosphorus ferry — evening route',
    description: 'See [[Istanbul]].',
    location: 'Eminönü pier',
    startAt: istanbulLocalAt(3, 17, 30),
    endAt: istanbulLocalAt(3, 19),
    timezone: 'Europe/Istanbul',
    colorId: '0ea5e9'
  },
  {
    id: generateId(),
    title: 'Dinner — Kadıköy',
    description: 'See [[Istanbul]].',
    location: 'Kadıköy, Istanbul',
    startAt: istanbulLocalAt(3, 20),
    endAt: istanbulLocalAt(3, 22),
    timezone: 'Europe/Istanbul',
    colorId: '0ea5e9'
  }
]
