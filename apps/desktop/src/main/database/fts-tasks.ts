import { sql } from 'drizzle-orm'
import type { DrizzleDb } from './client'

/**
 * FTS5 Full-Text Search for Tasks
 *
 * Mirrors fts.ts pattern for notes.
 * - fts_tasks virtual table stores id, title, description, tags
 * - Projectors own all row maintenance for this table
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
  db.run(sql`DROP TRIGGER IF EXISTS tasks_ai`)
  db.run(sql`DROP TRIGGER IF EXISTS tasks_ad`)
  db.run(sql`DROP TRIGGER IF EXISTS tasks_au`)
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
