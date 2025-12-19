import { sql } from 'drizzle-orm'
import type { DrizzleDb } from './client'

/**
 * FTS5 Full-Text Search for Notes
 *
 * Architecture:
 * - fts_notes virtual table stores id, title, content, tags for full-text search
 * - SQLite triggers automatically sync id/title on INSERT/DELETE/UPDATE of note_cache
 * - Content and tags must be explicitly updated via updateFtsContent() since
 *   note_cache doesn't store content (files are source of truth)
 *
 * @module database/fts
 */

/**
 * Creates FTS5 virtual table for full-text search on notes.
 * Must be called after migrations on index.db.
 */
export function createFtsTable(db: DrizzleDb): void {
  // FTS5 virtual table for full-text search
  // - id: UNINDEXED because it's only used for joining, not searching
  // - title: searchable note title
  // - content: searchable note body (markdown)
  // - tags: space-separated tags for searching
  // - tokenize: porter stemmer + unicode support for international text
  db.run(sql`
    CREATE VIRTUAL TABLE IF NOT EXISTS fts_notes USING fts5(
      id UNINDEXED,
      title,
      content,
      tags,
      tokenize='porter unicode61'
    )
  `)
}

/**
 * Creates triggers to keep FTS index in sync with note_cache table.
 * Must be called after createFtsTable.
 */
export function createFtsTriggers(db: DrizzleDb): void {
  // Trigger: Insert into FTS when note is added to cache
  db.run(sql`
    CREATE TRIGGER IF NOT EXISTS note_cache_ai AFTER INSERT ON note_cache BEGIN
      INSERT INTO fts_notes (id, title, content, tags)
      VALUES (NEW.id, NEW.title, '', '');
    END
  `)

  // Trigger: Delete from FTS when note is removed from cache
  db.run(sql`
    CREATE TRIGGER IF NOT EXISTS note_cache_ad AFTER DELETE ON note_cache BEGIN
      DELETE FROM fts_notes WHERE id = OLD.id;
    END
  `)

  // Trigger: Update FTS when note title changes
  db.run(sql`
    CREATE TRIGGER IF NOT EXISTS note_cache_au AFTER UPDATE ON note_cache BEGIN
      UPDATE fts_notes SET title = NEW.title WHERE id = NEW.id;
    END
  `)
}

/**
 * Updates FTS content for a specific note.
 * Called when note content or tags change.
 *
 * @param db - Drizzle database instance
 * @param noteId - The note's unique ID
 * @param content - The full markdown content to index
 * @param tags - Array of tags to index (will be space-separated)
 */
export function updateFtsContent(
  db: DrizzleDb,
  noteId: string,
  content: string,
  tags: string[]
): void {
  const tagsStr = tags.join(' ')
  db.run(sql`
    UPDATE fts_notes
    SET content = ${content}, tags = ${tagsStr}
    WHERE id = ${noteId}
  `)
}

/**
 * Inserts a complete FTS entry for a note.
 * Use this instead of relying on the trigger when you have content available.
 *
 * @param db - Drizzle database instance
 * @param noteId - The note's unique ID
 * @param title - The note title
 * @param content - The full markdown content to index
 * @param tags - Array of tags to index
 */
export function insertFtsNote(
  db: DrizzleDb,
  noteId: string,
  title: string,
  content: string,
  tags: string[]
): void {
  const tagsStr = tags.join(' ')
  // Use INSERT OR REPLACE to handle cases where trigger already created empty entry
  db.run(sql`
    INSERT OR REPLACE INTO fts_notes (id, title, content, tags)
    VALUES (${noteId}, ${title}, ${content}, ${tagsStr})
  `)
}

/**
 * Deletes a note from the FTS index.
 * Called when a note is deleted.
 *
 * @param db - Drizzle database instance
 * @param noteId - The note's unique ID to delete
 */
export function deleteFtsNote(db: DrizzleDb, noteId: string): void {
  db.run(sql`
    DELETE FROM fts_notes WHERE id = ${noteId}
  `)
}

/**
 * Clears all entries from the FTS index.
 * Used during index rebuild.
 *
 * @param db - Drizzle database instance
 */
export function clearFtsTable(db: DrizzleDb): void {
  db.run(sql`DELETE FROM fts_notes`)
}

/**
 * Gets the count of entries in the FTS index.
 *
 * @param db - Drizzle database instance
 * @returns Number of indexed notes
 */
export function getFtsCount(db: DrizzleDb): number {
  const result = db.get<{ count: number }>(sql`SELECT COUNT(*) as count FROM fts_notes`)
  return result?.count ?? 0
}

/**
 * Checks if a note exists in the FTS index.
 *
 * @param db - Drizzle database instance
 * @param noteId - The note's unique ID
 * @returns True if the note is indexed
 */
export function ftsNoteExists(db: DrizzleDb, noteId: string): boolean {
  const result = db.get<{ id: string }>(sql`SELECT id FROM fts_notes WHERE id = ${noteId}`)
  return result !== undefined
}

/**
 * Initializes FTS5 for the index database.
 * Call this after running migrations on index.db.
 */
export function initializeFts(db: DrizzleDb): void {
  createFtsTable(db)
  createFtsTriggers(db)
}
