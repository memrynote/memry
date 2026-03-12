import { sqliteTable, text, uniqueIndex, index } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'

export const searchReasons = sqliteTable(
  'search_reasons',
  {
    id: text('id').primaryKey(),
    itemId: text('item_id').notNull(),
    itemType: text('item_type').notNull(),
    itemTitle: text('item_title').notNull(),
    itemIcon: text('item_icon'),
    searchQuery: text('search_query').notNull(),
    visitedAt: text('visited_at')
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
  },
  (table) => [
    uniqueIndex('idx_search_reasons_item').on(table.itemType, table.itemId),
    index('idx_search_reasons_visited').on(table.visitedAt)
  ]
)

export type SearchReasonRow = typeof searchReasons.$inferSelect
export type NewSearchReasonRow = typeof searchReasons.$inferInsert
