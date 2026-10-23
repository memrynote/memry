import { sqliteTable, text, integer, primaryKey } from 'drizzle-orm/sqlite-core'

/**
 * Model output for one fold chunk (a heading and its paragraphs, or a slice of
 * a long section). Keyed by the chunk's content hash, the note language and the
 * model id, so an edit elsewhere in the note never invalidates it and a cache
 * hit costs no model call. `payload` is the validated JSON the model returned.
 * Derivable cache: index DB only, never synced, safe to drop.
 */
export const noteFoldChunks = sqliteTable(
  'note_fold_chunks',
  {
    chunkHash: text('chunk_hash').notNull(),
    language: text('language').notNull(),
    modelId: text('model_id').notNull(),
    payload: text('payload').notNull(),
    createdAt: integer('created_at').notNull()
  },
  (table) => [primaryKey({ columns: [table.chunkHash, table.language, table.modelId] })]
)
