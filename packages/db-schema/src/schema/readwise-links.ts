import { sql } from 'drizzle-orm'
import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core'

export type ReadwiseLinkState = 'linked' | 'note-deleted' | 'source-deleted'

/**
 * Device-local cache of which Readwise item maps to which note (#1411, D4/D8).
 *
 * Deliberately has no `clock` or `synced_at` and no sync handler: it never
 * leaves the pulling device. `readwise_url` on the note is the identity that
 * travels, and `rebuildLinks()` refills this table from it.
 *
 * `readwise_book_id` is nullable so a Reader document with no v2 book (Phase 3,
 * D11) can be linked without a table rebuild later. SQLite lets a UNIQUE column
 * hold many NULLs.
 */
export const readwiseLinks = sqliteTable(
  'readwise_links',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    readwiseBookId: integer('readwise_book_id'),
    readerDocumentId: text('reader_document_id'),
    noteId: text('note_id').notNull(),
    state: text('state').$type<ReadwiseLinkState>().notNull().default('linked'),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
  },
  (table) => [
    uniqueIndex('idx_readwise_links_book_id').on(table.readwiseBookId),
    uniqueIndex('idx_readwise_links_reader_document_id').on(table.readerDocumentId),
    index('idx_readwise_links_note_id').on(table.noteId),
    index('idx_readwise_links_state').on(table.state)
  ]
)

export type ReadwiseLink = typeof readwiseLinks.$inferSelect
export type NewReadwiseLink = typeof readwiseLinks.$inferInsert
