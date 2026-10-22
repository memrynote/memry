import { sqliteTable, text, integer, primaryKey } from 'drizzle-orm/sqlite-core'
import { noteCache } from './notes-cache.ts'

/**
 * Which image bytes produced a row in `vec_images` (a vec0 table Drizzle does
 * not manage). One row per image, keyed like `extracted_text`: `source` is empty
 * for a filed image's own file, otherwise a file name in the note's attachments
 * folder. The vector's key is `note_id || '/' || source`. `signature` is the
 * file's size and mtime from `file_text_jobs`, `input_version` the
 * `IMAGE_EMBEDDING_INPUT_VERSION` that embedded it; a row that differs from
 * either is re-embedded in the background while the old vector keeps answering.
 * Index DB only, rebuilt with the vectors.
 */
export const imageEmbeddingState = sqliteTable(
  'image_embedding_state',
  {
    noteId: text('note_id')
      .notNull()
      .references(() => noteCache.id, { onDelete: 'cascade' }),
    source: text('source').notNull().default(''),
    signature: text('signature').notNull(),
    inputVersion: integer('input_version').notNull()
  },
  (table) => [primaryKey({ columns: [table.noteId, table.source] })]
)
