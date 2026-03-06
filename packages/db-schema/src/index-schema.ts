/**
 * Schema for index.db (rebuildable cache for notes)
 *
 * This schema is used exclusively for the index database
 * which caches metadata extracted from markdown files.
 * This database can be safely deleted and rebuilt from files.
 *
 * Journal entries are stored in note_cache with the `date` column set.
 * Note embeddings are stored in a sqlite-vec virtual table (vec_notes)
 * which is managed outside of Drizzle.
 *
 * @module db/schema/index-schema
 */

export * from './schema/notes-cache'
