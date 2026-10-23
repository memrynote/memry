import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/**
 * Device-local index of the Readwise highlights this device has seen (#3476,
 * D17): which book each belongs to, its dates, and whether it is deleted. The
 * journal day sections are rendered from it, and a full export rebuilds it, so
 * a device that takes over renders the bytes the old device wrote.
 *
 * Deliberately has no `clock` or `synced_at` and no sync handler. The dates are
 * ISO instants (`toISOString`), so they compare as text.
 */
export const readwiseHighlights = sqliteTable(
  'readwise_highlights',
  {
    highlightId: integer('highlight_id').primaryKey(),
    bookId: integer('book_id').notNull(),
    highlightedAt: text('highlighted_at'),
    createdAt: text('created_at'),
    deleted: integer('deleted', { mode: 'boolean' }).notNull().default(false)
  },
  (table) => [index('idx_readwise_highlights_book_id').on(table.bookId)]
)

export type ReadwiseHighlightRow = typeof readwiseHighlights.$inferSelect
export type NewReadwiseHighlightRow = typeof readwiseHighlights.$inferInsert
