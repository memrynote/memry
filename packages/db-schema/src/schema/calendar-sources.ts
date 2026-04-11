import { sql } from 'drizzle-orm'
import { integer, sqliteTable, text, index, uniqueIndex } from 'drizzle-orm/sqlite-core'
import type { VectorClock } from '@memry/contracts/sync-api'

export type CalendarSourceKind = 'account' | 'calendar'
export type CalendarSourceSyncStatus = 'idle' | 'ok' | 'error' | 'pending'

export const calendarSources = sqliteTable(
  'calendar_sources',
  {
    id: text('id').primaryKey(),
    provider: text('provider').notNull(),
    kind: text('kind').$type<CalendarSourceKind>().notNull(),
    accountId: text('account_id'),
    remoteId: text('remote_id').notNull(),
    title: text('title').notNull(),
    timezone: text('timezone'),
    color: text('color'),
    isPrimary: integer('is_primary', { mode: 'boolean' }).notNull().default(false),
    isSelected: integer('is_selected', { mode: 'boolean' }).notNull().default(false),
    isMemryManaged: integer('is_memry_managed', { mode: 'boolean' }).notNull().default(false),
    syncCursor: text('sync_cursor'),
    syncStatus: text('sync_status').$type<CalendarSourceSyncStatus>().notNull().default('idle'),
    lastSyncedAt: text('last_synced_at'),
    metadata: text('metadata', { mode: 'json' }).$type<Record<string, unknown> | null>(),
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
    uniqueIndex('idx_calendar_sources_provider_remote').on(table.provider, table.kind, table.remoteId),
    index('idx_calendar_sources_account').on(table.accountId),
    index('idx_calendar_sources_selected').on(table.isSelected)
  ]
)

export type CalendarSource = typeof calendarSources.$inferSelect
export type NewCalendarSource = typeof calendarSources.$inferInsert
