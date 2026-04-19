import { sql } from 'drizzle-orm'
import { integer, sqliteTable, text, index, uniqueIndex } from 'drizzle-orm/sqlite-core'
import type { VectorClock } from '@memry/contracts/sync-api'
import { calendarSources } from './calendar-sources.ts'
import type {
  CalendarAttendee,
  CalendarReminders,
  CalendarConferenceData,
  CalendarVisibility
} from './calendar-events.ts'

export type CalendarExternalEventStatus = 'confirmed' | 'tentative' | 'cancelled'

export const calendarExternalEvents = sqliteTable(
  'calendar_external_events',
  {
    id: text('id').primaryKey(),
    sourceId: text('source_id')
      .notNull()
      .references(() => calendarSources.id, { onDelete: 'cascade' }),
    remoteEventId: text('remote_event_id').notNull(),
    remoteEtag: text('remote_etag'),
    remoteUpdatedAt: text('remote_updated_at'),
    title: text('title').notNull(),
    description: text('description'),
    location: text('location'),
    startAt: text('start_at').notNull(),
    endAt: text('end_at'),
    timezone: text('timezone'),
    isAllDay: integer('is_all_day', { mode: 'boolean' }).notNull().default(false),
    status: text('status').$type<CalendarExternalEventStatus>().notNull().default('confirmed'),
    recurrenceRule: text('recurrence_rule', { mode: 'json' }).$type<Record<string, unknown> | null>(),
    attendees: text('attendees', { mode: 'json' }).$type<CalendarAttendee[] | null>(),
    reminders: text('reminders', { mode: 'json' }).$type<CalendarReminders | null>(),
    visibility: text('visibility').$type<CalendarVisibility | null>(),
    colorId: text('color_id'),
    conferenceData: text('conference_data', { mode: 'json' }).$type<CalendarConferenceData | null>(),
    rawPayload: text('raw_payload', { mode: 'json' }).$type<Record<string, unknown> | null>(),
    archivedAt: text('archived_at'),
    clock: text('clock', { mode: 'json' }).$type<VectorClock>(),
    syncedAt: text('synced_at'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
    modifiedAt: text('modified_at')
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
  },
  (table) => [
    uniqueIndex('idx_calendar_external_events_source_remote').on(table.sourceId, table.remoteEventId),
    index('idx_calendar_external_events_start_at').on(table.startAt),
    index('idx_calendar_external_events_archived_at').on(table.archivedAt)
  ]
)

export type CalendarExternalEvent = typeof calendarExternalEvents.$inferSelect
export type NewCalendarExternalEvent = typeof calendarExternalEvents.$inferInsert
