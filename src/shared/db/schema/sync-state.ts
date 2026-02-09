import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'

export const syncState = sqliteTable('sync_state', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull()
})

export type SyncStateEntry = typeof syncState.$inferSelect
export type NewSyncStateEntry = typeof syncState.$inferInsert
