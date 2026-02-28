import { sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'

export const tagDefinitions = sqliteTable('tag_definitions', {
  name: text('name').primaryKey(),
  color: text('color').notNull(),
  clock: text('clock', { mode: 'json' }),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
})

export type TagDefinition = typeof tagDefinitions.$inferSelect
export type NewTagDefinition = typeof tagDefinitions.$inferInsert
