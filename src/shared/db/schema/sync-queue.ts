import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'

export const syncQueue = sqliteTable('sync_queue', {
  id: text('id').primaryKey(),
  type: text('type').notNull(),
  itemId: text('item_id').notNull(),
  operation: text('operation').notNull(),
  payload: text('payload').notNull(),
  priority: integer('priority').notNull().default(0),
  attempts: integer('attempts').notNull().default(0),
  lastAttempt: integer('last_attempt'),
  errorMessage: text('error_message'),
  createdAt: integer('created_at').notNull(),
})

export type SyncQueueItem = typeof syncQueue.$inferSelect
export type NewSyncQueueItem = typeof syncQueue.$inferInsert
