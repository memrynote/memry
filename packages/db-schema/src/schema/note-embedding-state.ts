import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'
import { noteCache } from './notes-cache.ts'

/**
 * Which `EMBEDDING_INPUT_VERSION` produced a note's row in `vec_notes` (a vec0
 * table Drizzle does not manage). A vector with no row here predates this table
 * and counts as stale. The embedding projector re-embeds stale notes in the
 * background while the old vectors keep answering, so an input-format change
 * never empties the table. `chunk_count` is how many rows the note owns in
 * `vec_note_chunks` (ids `{note_id}#1` to `{note_id}#{chunk_count}`; the head
 * window lives in `vec_notes`), so they can be deleted without scanning that
 * table. Index DB only, rebuilt with the vectors.
 */
export const noteEmbeddingState = sqliteTable('note_embedding_state', {
  noteId: text('note_id')
    .primaryKey()
    .references(() => noteCache.id, { onDelete: 'cascade' }),
  inputVersion: integer('input_version').notNull(),
  chunkCount: integer('chunk_count').notNull().default(0)
})
