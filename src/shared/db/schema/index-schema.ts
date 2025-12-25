/**
 * Schema for index.db (rebuildable cache for notes and journal)
 *
 * This schema is used exclusively for the index database
 * which caches metadata extracted from markdown files.
 * This database can be safely deleted and rebuilt from files.
 *
 * @module db/schema/index-schema
 */

export * from './notes-cache'
export * from './journal-cache'
