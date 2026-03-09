import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'

export const recentSearches = sqliteTable('recent_searches', {
  id: text('id').primaryKey(),
  query: text('query').notNull(),
  resultCount: integer('result_count').notNull().default(0),
  searchedAt: text('searched_at')
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
})

export type RecentSearchRow = typeof recentSearches.$inferSelect
export type NewRecentSearchRow = typeof recentSearches.$inferInsert
