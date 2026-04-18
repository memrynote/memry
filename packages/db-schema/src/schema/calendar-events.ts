import { sql } from 'drizzle-orm'
import { integer, sqliteTable, text, index } from 'drizzle-orm/sqlite-core'
import type { VectorClock } from '@memry/contracts/sync-api'

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
    targetCalendarId: text('target_calendar_id'),
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
    index('idx_calendar_events_start_at').on(table.startAt),
    index('idx_calendar_events_archived_at').on(table.archivedAt)
  ]
)

export type CalendarEvent = typeof calendarEvents.$inferSelect
export type NewCalendarEvent = typeof calendarEvents.$inferInsert
