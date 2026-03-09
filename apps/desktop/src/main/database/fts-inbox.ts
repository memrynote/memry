import { sql } from 'drizzle-orm'
import type { DrizzleDb } from './client'

/**
 * FTS5 Full-Text Search for Inbox Items
 *
 * Mirrors fts.ts pattern for notes.
 * - fts_inbox virtual table stores id, title, content, transcription, source_title
 * - SQLite triggers auto-sync id/title on INSERT/DELETE/UPDATE of inbox_items
 * - Content fields updated explicitly via updateFtsInboxContent()
 *
 * @module database/fts-inbox
 */

export function createFtsInboxTable(db: DrizzleDb): void {
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

export function createFtsInboxTriggers(db: DrizzleDb): void {
  db.run(sql`
    CREATE TRIGGER IF NOT EXISTS inbox_ai AFTER INSERT ON inbox_items BEGIN
      INSERT INTO fts_inbox (id, title, content, transcription, source_title)
      VALUES (
        NEW.id,
        NEW.title,
        COALESCE(NEW.content, ''),
        COALESCE(NEW.transcription, ''),
        COALESCE(NEW.source_title, '')
      );
    END
  `)

  db.run(sql`
    CREATE TRIGGER IF NOT EXISTS inbox_ad AFTER DELETE ON inbox_items BEGIN
      DELETE FROM fts_inbox WHERE id = OLD.id;
    END
  `)

  db.run(sql`
    CREATE TRIGGER IF NOT EXISTS inbox_au AFTER UPDATE OF title, content, transcription, source_title ON inbox_items BEGIN
      UPDATE fts_inbox
      SET
        title = NEW.title,
        content = COALESCE(NEW.content, ''),
        transcription = COALESCE(NEW.transcription, ''),
        source_title = COALESCE(NEW.source_title, '')
      WHERE id = NEW.id;
    END
  `)
}

export function updateFtsInboxContent(
  db: DrizzleDb,
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
  db: DrizzleDb,
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

export function deleteFtsInboxItem(db: DrizzleDb, itemId: string): void {
  db.run(sql`DELETE FROM fts_inbox WHERE id = ${itemId}`)
}

export function clearFtsInboxTable(db: DrizzleDb): void {
  db.run(sql`DELETE FROM fts_inbox`)
}

export function getFtsInboxCount(db: DrizzleDb): number {
  const result = db.get<{ count: number }>(sql`SELECT COUNT(*) as count FROM fts_inbox`)
  return result?.count ?? 0
}

export function initializeFtsInbox(db: DrizzleDb): void {
  createFtsInboxTable(db)
  createFtsInboxTriggers(db)
}
