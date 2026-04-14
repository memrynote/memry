import { sql } from 'drizzle-orm'
import { sqliteTable, text, index, uniqueIndex } from 'drizzle-orm/sqlite-core'
import type { VectorClock } from '@memry/contracts/sync-api'

export type CalendarBindingSourceType = 'event' | 'task' | 'reminder' | 'inbox_snooze'
export type CalendarBindingOwnershipMode = 'memry_managed' | 'provider_managed'
export type CalendarBindingWritebackMode = 'schedule_only' | 'time_and_text' | 'broad'

export const calendarBindings = sqliteTable(
  'calendar_bindings',
  {
    id: text('id').primaryKey(),
    sourceType: text('source_type').$type<CalendarBindingSourceType>().notNull(),
    sourceId: text('source_id').notNull(),
    provider: text('provider').notNull(),
    remoteCalendarId: text('remote_calendar_id').notNull(),
    remoteEventId: text('remote_event_id').notNull(),
    ownershipMode: text('ownership_mode').$type<CalendarBindingOwnershipMode>().notNull(),
    writebackMode: text('writeback_mode').$type<CalendarBindingWritebackMode>().notNull(),
    remoteVersion: text('remote_version'),
    lastLocalSnapshot: text('last_local_snapshot', { mode: 'json' }).$type<
      Record<string, unknown> | null
    >(),
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
    uniqueIndex('idx_calendar_bindings_source').on(table.sourceType, table.sourceId, table.provider),
    uniqueIndex('idx_calendar_bindings_remote').on(
      table.provider,
      table.remoteCalendarId,
      table.remoteEventId
    ),
    index('idx_calendar_bindings_source_type').on(table.sourceType),
    index('idx_calendar_bindings_archived_at').on(table.archivedAt)
  ]
)

export type CalendarBinding = typeof calendarBindings.$inferSelect
export type NewCalendarBinding = typeof calendarBindings.$inferInsert
