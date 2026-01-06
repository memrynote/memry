import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  modifiedAt: text('modified_at').notNull().default(sql`(datetime('now'))`)
})

export const savedFilters = sqliteTable('saved_filters', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  config: text('config', { mode: 'json' }).notNull(),
  position: integer('position').notNull().default(0),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`)
})

export type Setting = typeof settings.$inferSelect
export type NewSetting = typeof settings.$inferInsert
export type SavedFilter = typeof savedFilters.$inferSelect
export type NewSavedFilter = typeof savedFilters.$inferInsert
