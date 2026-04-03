import { sql } from 'drizzle-orm'
import type { DrizzleDb } from './client'

/**
 * FTS5 Full-Text Search for Tasks
 *
 * Mirrors fts.ts pattern for notes.
 * - fts_tasks virtual table stores id, title, description, tags
 * - SQLite triggers auto-sync id/title on INSERT/DELETE/UPDATE of tasks
 * - Description and tags updated explicitly via updateFtsTaskContent()
 *
 * @module database/fts-tasks
 */

export function createFtsTasksTable(db: DrizzleDb): void {
  db.run(sql`
    CREATE VIRTUAL TABLE IF NOT EXISTS fts_tasks USING fts5(
      id UNINDEXED,
      title,
      description,
      tags,
      tokenize='porter unicode61'
    )
  `)
}

export function createFtsTasksTriggers(db: DrizzleDb): void {
  db.run(sql`
    CREATE TRIGGER IF NOT EXISTS tasks_ai AFTER INSERT ON tasks BEGIN
      INSERT INTO fts_tasks (id, title, description, tags)
      VALUES (NEW.id, NEW.title, COALESCE(NEW.description, ''), '');
    END
  `)

  db.run(sql`
    CREATE TRIGGER IF NOT EXISTS tasks_ad AFTER DELETE ON tasks BEGIN
      DELETE FROM fts_tasks WHERE id = OLD.id;
    END
  `)

  db.run(sql`
    CREATE TRIGGER IF NOT EXISTS tasks_au AFTER UPDATE OF title, description ON tasks BEGIN
      UPDATE fts_tasks
      SET title = NEW.title, description = COALESCE(NEW.description, '')
      WHERE id = NEW.id;
    END
  `)
}

export function updateFtsTaskContent(
  db: DrizzleDb,
  taskId: string,
  description: string,
  tags: string[]
): void {
  const tagsStr = tags.join(' ')
  db.run(sql`
    UPDATE fts_tasks
    SET description = ${description}, tags = ${tagsStr}
    WHERE id = ${taskId}
  `)
}

export function insertFtsTask(
  db: DrizzleDb,
  taskId: string,
  title: string,
  description: string,
  tags: string[]
): void {
  const tagsStr = tags.join(' ')
  db.run(sql`
    INSERT OR REPLACE INTO fts_tasks (id, title, description, tags)
    VALUES (${taskId}, ${title}, ${description}, ${tagsStr})
  `)
}

export function deleteFtsTask(db: DrizzleDb, taskId: string): void {
  db.run(sql`DELETE FROM fts_tasks WHERE id = ${taskId}`)
}

export function clearFtsTasksTable(db: DrizzleDb): void {
  db.run(sql`DELETE FROM fts_tasks`)
}

export function initializeFtsTasks(db: DrizzleDb): void {
  createFtsTasksTable(db)
  createFtsTasksTriggers(db)
}
