import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'
import { nocaseText } from './nocase.ts'

export const tagDefinitions = sqliteTable('tag_definitions', {
  name: nocaseText('name').primaryKey(),
  color: text('color').notNull(),
  icon: text('icon'),
  clock: text('clock', { mode: 'json' }),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  categoryId: text('category_id'),
  sortOrder: integer('sort_order').notNull().default(0),
  views: text('views')
})

export type TagDefinition = typeof tagDefinitions.$inferSelect
export type NewTagDefinition = typeof tagDefinitions.$inferInsert
