/**
 * Schema for index.db (rebuildable cache for notes)
 *
 * This schema is used exclusively for the index database
 * which caches metadata extracted from markdown files.
 * This database can be safely deleted and rebuilt from files.
 *
 * Journal entries are stored in note_cache with the `date` column set.
 *
 * @module db/schema/index-schema
 */

export * from './notes-cache'
