import { sql } from 'drizzle-orm'
import type { DataDb } from './client'

/**
 * FTS5 Full-Text Search for Inbox Items
 *
 * Mirrors fts.ts pattern for notes.
 * - fts_inbox virtual table stores id, title, content, transcription, source_title
 * - Projectors own all row maintenance for this table
 *
 * @module database/fts-inbox
 */

export function createFtsInboxTable(db: DataDb): void {
  db.run(sql`
    CREATE VIRTUAL TABLE IF NOT EXISTS fts_inbox USING fts5(
      id UNINDEXED,
      title,
      content,
      transcription,
      source_title,
      tokenize='porter unicode61'
    )
  `)
}

export function createFtsInboxTriggers(db: DataDb): void {
  db.run(sql`DROP TRIGGER IF EXISTS inbox_ai`)
  db.run(sql`DROP TRIGGER IF EXISTS inbox_ad`)
  db.run(sql`DROP TRIGGER IF EXISTS inbox_au`)
}

export function updateFtsInboxContent(
  db: DataDb,
  itemId: string,
  content: string,
  transcription: string,
  sourceTitle: string
): void {
  db.run(sql`
    UPDATE fts_inbox
    SET content = ${content}, transcription = ${transcription}, source_title = ${sourceTitle}
    WHERE id = ${itemId}
  `)
}

export function insertFtsInboxItem(
  db: DataDb,
  itemId: string,
  title: string,
  content: string,
  transcription: string,
  sourceTitle: string
): void {
  db.run(sql`
    INSERT OR REPLACE INTO fts_inbox (id, title, content, transcription, source_title)
    VALUES (${itemId}, ${title}, ${content}, ${transcription}, ${sourceTitle})
  `)
}

export function deleteFtsInboxItem(db: DataDb, itemId: string): void {
  db.run(sql`DELETE FROM fts_inbox WHERE id = ${itemId}`)
}

export function clearFtsInboxTable(db: DataDb): void {
  db.run(sql`DELETE FROM fts_inbox`)
}

export function getFtsInboxCount(db: DataDb): number {
  const result = db.get<{ count: number }>(sql`SELECT COUNT(*) as count FROM fts_inbox`)
  return result?.count ?? 0
}

export function initializeFtsInbox(db: DataDb): void {
  createFtsInboxTable(db)
  createFtsInboxTriggers(db)
}
