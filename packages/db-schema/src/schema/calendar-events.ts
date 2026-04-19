import { sql } from 'drizzle-orm'
import { integer, sqliteTable, text, index } from 'drizzle-orm/sqlite-core'
import type { VectorClock, FieldClocks } from '@memry/contracts/sync-api'

export type CalendarEventResponseStatus =
  | 'needsAction'
  | 'declined'
  | 'tentative'
  | 'accepted'

export interface CalendarAttendee {
  email: string
  displayName?: string | null
  responseStatus?: CalendarEventResponseStatus | null
  optional?: boolean | null
  organizer?: boolean | null
  self?: boolean | null
}

export interface CalendarReminderOverride {
  method: 'email' | 'popup'
  minutes: number
}

export interface CalendarReminders {
  useDefault: boolean
  overrides: CalendarReminderOverride[]
}

export interface CalendarConferenceEntryPoint {
  entryPointType: string
  uri?: string | null
  label?: string | null
  pin?: string | null
  meetingCode?: string | null
  passcode?: string | null
  regionCode?: string | null
}

export interface CalendarConferenceData {
  conferenceId?: string | null
  conferenceSolution?: {
    key?: { type?: string | null } | null
    name?: string | null
    iconUri?: string | null
  } | null
  entryPoints?: CalendarConferenceEntryPoint[]
  notes?: string | null
}

export type CalendarVisibility = 'default' | 'public' | 'private' | 'confidential'

export const calendarEvents = sqliteTable(
  'calendar_events',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    description: text('description'),
    location: text('location'),
    startAt: text('start_at').notNull(),
    endAt: text('end_at'),
    timezone: text('timezone').notNull().default('UTC'),
    isAllDay: integer('is_all_day', { mode: 'boolean' }).notNull().default(false),
    recurrenceRule: text('recurrence_rule', { mode: 'json' }).$type<Record<
      string,
      unknown
    > | null>(),
    recurrenceExceptions: text('recurrence_exceptions', { mode: 'json' }).$type<Array<
      Record<string, unknown>
    > | null>(),
    attendees: text('attendees', { mode: 'json' }).$type<CalendarAttendee[] | null>(),
    reminders: text('reminders', { mode: 'json' }).$type<CalendarReminders | null>(),
    visibility: text('visibility').$type<CalendarVisibility | null>(),
    colorId: text('color_id'),
    conferenceData: text('conference_data', { mode: 'json' }).$type<CalendarConferenceData | null>(),
    parentEventId: text('parent_event_id'),
    originalStartTime: text('original_start_time'),
    targetCalendarId: text('target_calendar_id'),
    archivedAt: text('archived_at'),
    clock: text('clock', { mode: 'json' }).$type<VectorClock>(),
    fieldClocks: text('field_clocks', { mode: 'json' }).$type<FieldClocks>(),
    syncedAt: text('synced_at'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
    modifiedAt: text('modified_at')
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
  },
  (table) => [
    index('idx_calendar_events_start_at').on(table.startAt),
    index('idx_calendar_events_archived_at').on(table.archivedAt)
  ]
)

export type CalendarEvent = typeof calendarEvents.$inferSelect
export type NewCalendarEvent = typeof calendarEvents.$inferInsert
