import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'

export const syncDevices = sqliteTable('sync_devices', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  platform: text('platform').notNull(),
  osVersion: text('os_version'),
  appVersion: text('app_version').notNull(),
  linkedAt: integer('linked_at').notNull(),
  lastSyncAt: integer('last_sync_at'),
  isCurrentDevice: integer('is_current_device').notNull().default(0)
})

export type SyncDevice = typeof syncDevices.$inferSelect
export type NewSyncDevice = typeof syncDevices.$inferInsert
