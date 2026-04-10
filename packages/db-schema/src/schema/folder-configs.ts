import { sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'

export const folderConfigs = sqliteTable('folder_configs', {
  path: text('path').primaryKey(),
  icon: text('icon'),
  clock: text('clock', { mode: 'json' }),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  modifiedAt: text('modified_at')
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
})

export type FolderConfigRow = typeof folderConfigs.$inferSelect
export type NewFolderConfigRow = typeof folderConfigs.$inferInsert
