/**
 * Note Embeddings Schema
 *
 * Stores pre-computed embeddings for notes to enable AI-powered
 * filing suggestions. This table is in index.db (rebuildable cache).
 *
 * Embeddings are generated using OpenAI's text-embedding-3-small model
 * and stored as binary blobs for efficient storage and retrieval.
 *
 * @module db/schema/embeddings
 */

import { sqliteTable, text, blob, index } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'
import { noteCache } from './notes-cache'

// ============================================================================
// Note Embeddings Table
// ============================================================================

/**
 * Stores embeddings for notes in index.db.
 * This is a rebuildable cache - can be regenerated from note content.
 */
export const noteEmbeddings = sqliteTable(
  'note_embeddings',
  {
    /** Note ID (references note_cache.id) */
    noteId: text('note_id')
      .primaryKey()
      .references(() => noteCache.id, { onDelete: 'cascade' }),

    /** Embedding vector stored as binary (Float32Array buffer) */
    embedding: blob('embedding', { mode: 'buffer' }).notNull(),

    /** Model used to generate embedding (e.g., 'text-embedding-3-small') */
    model: text('model').notNull(),

    /** Hash of content when embedding was computed (for cache invalidation) */
    contentHash: text('content_hash').notNull(),

    /** When the embedding was computed */
    computedAt: text('computed_at')
      .notNull()
      .default(sql`(datetime('now'))`)
  },
  (table) => [index('idx_note_embeddings_model').on(table.model)]
)

// ============================================================================
// Type Exports
// ============================================================================

export type NoteEmbedding = typeof noteEmbeddings.$inferSelect
export type NewNoteEmbedding = typeof noteEmbeddings.$inferInsert

// ============================================================================
// Embedding Constants
// ============================================================================

export const EmbeddingModels = {
  TEXT_EMBEDDING_3_SMALL: 'text-embedding-3-small',
  TEXT_EMBEDDING_3_LARGE: 'text-embedding-3-large'
} as const

export type EmbeddingModel = (typeof EmbeddingModels)[keyof typeof EmbeddingModels]

/** Dimension of text-embedding-3-small vectors */
export const EMBEDDING_DIMENSION_SMALL = 1536

/** Dimension of text-embedding-3-large vectors */
export const EMBEDDING_DIMENSION_LARGE = 3072

/** Maximum input tokens for embedding API */
export const MAX_EMBEDDING_TOKENS = 8191

/** Approximate characters per token (for estimation) */
export const CHARS_PER_TOKEN = 4
