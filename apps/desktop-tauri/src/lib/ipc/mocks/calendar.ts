import type { MockRouteMap } from './types'
import { mockId, mockTimestamp } from './types'

interface MockCalendarEvent {
  id: string
  title: string
  description: string
  location: string | null
  startAt: number
  endAt: number
  allDay: boolean
  sourceId: string | null
  createdAt: number
  updatedAt: number
}

interface MockCalendarSource {
  id: string
  name: string
  provider: 'local' | 'google' | 'icloud'
  color: string
  enabled: boolean
  selected: boolean
  lastSyncedAt: number | null
}

const eventTitles = [
  'Daily standup',
  'Product review',
  'Architecture sync',
  'Lunch with Özgür',
  '1:1 with manager',
  'Sprint planning',
  'Design critique',
  'Coffee chat',
  'Customer demo',
  'Tech debt review',
  'Fitness session',
  'Bookclub: Şeyh Galip',
  'Family dinner',
  'Engineering all-hands',
  'Focus block',
  'Release retrospective',
  'Hiring loop — frontend',
  'Weekly planning',
  'Open source OSS office hours',
  'Vendor intro call',
  'Doctor appointment',
  'Conference talk prep'
]

const events: MockCalendarEvent[] = eventTitles.map((title, i) => {
  const offsetDays = (i % 21) - 10
  const hour = 9 + (i % 8)
  const start = mockTimestamp(offsetDays) + hour * 3_600_000
  return {
    id: `event-${i + 1}`,
    title,
    description: `Mock event #${i + 1}`,
    location: i % 3 === 0 ? 'Room 101' : null,
    startAt: start,
    endAt: start + 3_600_000,
    allDay: i % 7 === 0,
    sourceId: i % 2 === 0 ? 'source-local' : 'source-google',
    createdAt: mockTimestamp(30),
    updatedAt: mockTimestamp(1)
  }
})

const sources: MockCalendarSource[] = [
  {
    id: 'source-local',
    name: 'Local',
    provider: 'local',
    color: '#60a5fa',
    enabled: true,
    selected: true,
    lastSyncedAt: null
  },
  {
    id: 'source-google',
    name: 'Google Calendar',
    provider: 'google',
    color: '#f97316',
    enabled: true,
    selected: true,
    lastSyncedAt: mockTimestamp(0)
  }
]

export const calendarRoutes: MockRouteMap = {
  calendar_list_events: async () => events,
  calendar_range: async (args) => {
    const { from, to } = args as { from: number; to: number }
    return events.filter((e) => e.startAt >= from && e.startAt <= to)
  },
  // Contract: CalendarRangeResponse = { items: CalendarProjectionItem[] }
  // Forwarder routes calendarService.getRange(arg) → calendar_get_range
  calendar_get_range: async () => ({ items: [] }),
  calendar_get: async (args) => {
    const { id } = args as { id: string }
    const event = events.find((e) => e.id === id)
    if (!event) throw new Error(`Calendar event ${id} not found`)
    return event
  },
  calendar_create: async (args) => {
    const input = args as Partial<MockCalendarEvent>
    const now = Date.now()
    const event: MockCalendarEvent = {
      id: mockId('event'),
      title: input.title ?? 'New event',
      description: input.description ?? '',
      location: input.location ?? null,
      startAt: input.startAt ?? now,
      endAt: input.endAt ?? now + 3_600_000,
      allDay: input.allDay ?? false,
      sourceId: input.sourceId ?? 'source-local',
      createdAt: now,
      updatedAt: now
    }
    events.unshift(event)
    return event
  },
  calendar_update: async (args) => {
    const { id, ...changes } = args as { id: string } & Partial<MockCalendarEvent>
    const event = events.find((e) => e.id === id)
    if (!event) throw new Error(`Calendar event ${id} not found`)
    Object.assign(event, changes, { updatedAt: Date.now() })
    return event
  },
  calendar_delete: async (args) => {
    const { id } = args as { id: string }
    const idx = events.findIndex((e) => e.id === id)
    if (idx >= 0) events.splice(idx, 1)
    return { ok: true }
  },
  calendar_list_sources: async () => sources,
  calendar_update_source_selection: async (args) => {
    const { id, selected } = args as { id: string; selected: boolean }
    const source = sources.find((s) => s.id === id)
    if (!source) throw new Error(`Calendar source ${id} not found`)
    source.selected = selected
    return source
  },
  calendar_retry_source_sync: async () => ({ ok: true, lastSyncedAt: Date.now() }),
  calendar_promote_external: async (args) => {
    const { title, startAt, endAt } = args as {
      title: string
      startAt: number
      endAt: number
    }
    const now = Date.now()
    const event: MockCalendarEvent = {
      id: mockId('event'),
      title,
      description: '',
      location: null,
      startAt,
      endAt,
      allDay: false,
      sourceId: 'source-local',
      createdAt: now,
      updatedAt: now
    }
    events.unshift(event)
    return event
  }
}
