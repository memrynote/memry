import { sql } from 'drizzle-orm'
import { sqliteTable, text, integer, uniqueIndex } from 'drizzle-orm/sqlite-core'

export const syncDevices = sqliteTable(
  'sync_devices',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    platform: text('platform').notNull(),
    osVersion: text('os_version'),
    appVersion: text('app_version').notNull(),
    linkedAt: integer('linked_at', { mode: 'timestamp' }).notNull(),
    lastSyncAt: integer('last_sync_at', { mode: 'timestamp' }),
    isCurrentDevice: integer('is_current_device', { mode: 'boolean' }).notNull().default(false),
    signingPublicKey: text('signing_public_key').notNull()
  },
  (table) => [
    uniqueIndex('idx_unique_current_device')
      .on(table.isCurrentDevice)
      .where(sql`is_current_device = 1`)
  ]
)

export type SyncDevice = typeof syncDevices.$inferSelect
export type NewSyncDevice = typeof syncDevices.$inferInsert
