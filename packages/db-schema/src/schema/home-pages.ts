import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'

export const homePages = sqliteTable(
  'home_pages',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    icon: text('icon'),
    position: integer('position').notNull().default(0),
    // JSON-encoded WidgetInstance[]; parsed by the caller.
    widgets: text('widgets').notNull().default('[]'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
  },
  (table) => [index('idx_home_pages_position').on(table.position)]
)

export type HomePageRow = typeof homePages.$inferSelect
export type NewHomePageRow = typeof homePages.$inferInsert
