import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'

export const tagCategories = sqliteTable(
  'tag_categories',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    clock: text('clock', { mode: 'json' }),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
    deletedAt: text('deleted_at')
  },
  (table) => [index('idx_tag_categories_sort').on(table.sortOrder)]
)

export type TagCategory = typeof tagCategories.$inferSelect
export type NewTagCategory = typeof tagCategories.$inferInsert
