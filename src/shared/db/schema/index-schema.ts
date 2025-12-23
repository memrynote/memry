/**
 * Schema for index.db (rebuildable cache for notes)
 *
 * This schema is used exclusively for the notes index database
 * which caches note metadata extracted from markdown files.
 * This database can be safely deleted and rebuilt from files.
 *
 * @module db/schema/index-schema
 */

export * from './notes-cache'
