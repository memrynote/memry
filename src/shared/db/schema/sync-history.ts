import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core'

export const syncHistory = sqliteTable(
  'sync_history',
  {
    id: text('id').primaryKey(),
    type: text('type').notNull(),
    itemCount: integer('item_count').notNull(),
    direction: text('direction'),
    details: text('details'),
    durationMs: integer('duration_ms'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull()
  },
  (table) => [index('idx_sync_history_created').on(table.createdAt)]
)

export type SyncHistoryEntry = typeof syncHistory.$inferSelect
export type NewSyncHistoryEntry = typeof syncHistory.$inferInsert
