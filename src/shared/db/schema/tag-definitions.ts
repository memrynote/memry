import { sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'

// Tag definitions are source-of-truth metadata (name + color).
export const tagDefinitions = sqliteTable('tag_definitions', {
  name: text('name').primaryKey(),
  color: text('color').notNull(),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(datetime('now'))`)
})

export type TagDefinition = typeof tagDefinitions.$inferSelect
export type NewTagDefinition = typeof tagDefinitions.$inferInsert
