/**
 * In-memory SQLite database factory for testing.
 * Creates isolated database instances for each test.
 */

import Database from 'better-sqlite3'
import { drizzle, BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { sql } from 'drizzle-orm'
import path from 'path'
import * as schema from '@memry/db-schema/schema'
import type { DrizzleDb } from '../../src/main/database/client'
import type { DrizzleDb as SyncDrizzleDb } from '../../src/main/sync/item-handlers/types'

// Migration paths
const DATA_MIGRATIONS = path.resolve(__dirname, '../../src/main/database/drizzle-data')
const INDEX_MIGRATIONS = path.resolve(__dirname, '../../src/main/database/drizzle-index')

export type TestDb = BetterSQLite3Database<typeof schema>

export interface TestDatabaseResult {
  db: TestDb
  sqlite: Database.Database
  close: () => void
}

/**
 * Cast test db to the database client's DrizzleDb type.
 * Both are BetterSQLite3Database parameterized over the same full schema,
 * but TypeScript can't unify them across module boundaries.
 */
export function asClientDb(db: TestDb): DrizzleDb {
  return db as unknown as DrizzleDb
}

/**
 * Cast test db to the sync layer's DrizzleDb type.
 * The sync layer uses data-schema (subset), but the full-schema test db
 * is a structural superset — safe to narrow at runtime.
 */
export function asSyncDb(db: TestDb): SyncDrizzleDb {
  return db as unknown as SyncDrizzleDb
}

// ============================================================================
// Database Factory Functions
// ============================================================================

/**
 * Create an in-memory data database (data.db equivalent).
 */
export function createTestDataDb(): TestDatabaseResult {
  const sqlite = new Database(':memory:')

  // Apply pragmas
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  sqlite.pragma('synchronous = NORMAL')

  const db = drizzle(sqlite, { schema })

  // Run migrations from actual migration files
  migrate(db, { migrationsFolder: DATA_MIGRATIONS })

  return {
    db,
    sqlite,
    close: () => sqlite.close()
  }
}

/**
 * Create a default in-memory database for tests (data.db equivalent).
 */
export function createTestDatabase(): TestDatabaseResult {
  return createTestDataDb()
}

/**
 * Create an in-memory index database (index.db equivalent).
 */
export function createTestIndexDb(): TestDatabaseResult {
  const sqlite = new Database(':memory:')

  // Apply pragmas (no foreign keys for index db)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('synchronous = NORMAL')

  const db = drizzle(sqlite, { schema })

  // Run migrations from actual migration files
  migrate(db, { migrationsFolder: INDEX_MIGRATIONS })

  return {
    db,
    sqlite,
    close: () => sqlite.close()
  }
}

/**
 * Create both databases for integration tests.
 */
export function createTestDatabases(): {
  data: TestDatabaseResult
  index: TestDatabaseResult
  closeAll: () => void
} {
  const data = createTestDataDb()
  const index = createTestIndexDb()

  return {
    data,
    index,
    closeAll: () => {
      data.close()
      index.close()
    }
  }
}

// ============================================================================
// Seed Functions
// ============================================================================

/**
 * Seed a default inbox project (required for tasks).
 */
export function seedInboxProject(db: TestDb): string {
  const id = 'inbox-project'
  db.run(sql`
    INSERT INTO projects (id, name, is_inbox, position)
    VALUES (${id}, 'Inbox', 1, 0)
  `)
  return id
}

/**
 * Seed sample projects.
 */
export function seedProjects(db: TestDb, count = 3): string[] {
  const ids: string[] = []
  for (let i = 0; i < count; i++) {
    const id = `project-${i}`
    db.run(sql`
      INSERT INTO projects (id, name, color, position)
      VALUES (${id}, ${'Project ' + i}, '#6366f1', ${i + 1})
    `)
    ids.push(id)
  }
  return ids
}

/**
 * Seed a minimal set of data for integration tests.
 */
export function seedTestData(db: TestDb): {
  projectId: string
  statusIds: { todo: string; inProgress: string; done: string }
  taskIds: string[]
} {
  const projectId = 'project-1'
  db.run(sql`
    INSERT INTO projects (id, name, color, position)
    VALUES (${projectId}, 'Project 1', '#6366f1', 0)
  `)

  const statusIds = {
    todo: 'status-todo',
    inProgress: 'status-in-progress',
    done: 'status-done'
  }

  db.run(sql`
    INSERT INTO statuses (id, project_id, name, color, position, is_default, is_done)
    VALUES (${statusIds.todo}, ${projectId}, 'To Do', '#6b7280', 0, 1, 0)
  `)
  db.run(sql`
    INSERT INTO statuses (id, project_id, name, color, position, is_default, is_done)
    VALUES (${statusIds.inProgress}, ${projectId}, 'In Progress', '#F59E0B', 1, 0, 0)
  `)
  db.run(sql`
    INSERT INTO statuses (id, project_id, name, color, position, is_default, is_done)
    VALUES (${statusIds.done}, ${projectId}, 'Done', '#22c55e', 2, 0, 1)
  `)

  const taskIds = ['task-1', 'task-2']
  db.run(sql`
    INSERT INTO tasks (id, project_id, status_id, title, position)
    VALUES (${taskIds[0]}, ${projectId}, ${statusIds.todo}, 'Seed Task 1', 0)
  `)
  db.run(sql`
    INSERT INTO tasks (id, project_id, status_id, title, position)
    VALUES (${taskIds[1]}, ${projectId}, ${statusIds.inProgress}, 'Seed Task 2', 1)
  `)

  return { projectId, statusIds, taskIds }
}

/**
 * Cleanup a test database created by this helper.
 */
export function cleanupTestDatabase(result: TestDatabaseResult): void {
  result.close()
}

// ============================================================================
// Inbox Seed Functions
// ============================================================================

export interface SeedInboxItemOptions {
  id?: string
  type?: string
  title?: string
  content?: string
  createdAt?: string
  filedAt?: string
  filedTo?: string
  filedAction?: string
  snoozedUntil?: string
  snoozeReason?: string
  archivedAt?: string
  sourceUrl?: string
  metadata?: Record<string, unknown>
}

/**
 * Seed inbox items for testing.
 */
export function seedInboxItems(db: TestDb, items: SeedInboxItemOptions[]): string[] {
  const ids: string[] = []
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    const id = item.id || `inbox-item-${i}`
    const type = item.type || 'note'
    const title = item.title || `Test Item ${i}`
    const content = item.content || null
    const createdAt = item.createdAt || new Date().toISOString()
    const metadata = item.metadata ? JSON.stringify(item.metadata) : null

    db.run(sql`
      INSERT INTO inbox_items (id, type, title, content, created_at, modified_at, filed_at, filed_to, filed_action, snoozed_until, snooze_reason, archived_at, source_url, metadata)
      VALUES (${id}, ${type}, ${title}, ${content}, ${createdAt}, ${createdAt}, ${item.filedAt || null}, ${item.filedTo || null}, ${item.filedAction || null}, ${item.snoozedUntil || null}, ${item.snoozeReason || null}, ${item.archivedAt || null}, ${item.sourceUrl || null}, ${metadata})
    `)
    ids.push(id)
  }
  return ids
}

/**
 * Seed a single inbox item.
 */
export function seedInboxItem(db: TestDb, options: SeedInboxItemOptions = {}): string {
  return seedInboxItems(db, [options])[0]
}

/**
 * Seed inbox item tags.
 */
export function seedInboxItemTags(db: TestDb, itemId: string, tags: string[]): void {
  for (const tag of tags) {
    const id = `tag-${itemId}-${tag}`
    db.run(sql`
      INSERT INTO inbox_item_tags (id, item_id, tag)
      VALUES (${id}, ${itemId}, ${tag})
    `)
  }
}

/**
 * Seed inbox stats for a specific date.
 */
export function seedInboxStats(
  db: TestDb,
  date: string,
  stats: {
    captureCountLink?: number
    captureCountNote?: number
    captureCountImage?: number
    captureCountVoice?: number
    captureCountClip?: number
    captureCountPdf?: number
    captureCountSocial?: number
    processedCount?: number
    archivedCount?: number
  } = {}
): string {
  const id = `stats-${date}`
  db.run(sql`
    INSERT INTO inbox_stats (id, date, capture_count_link, capture_count_note, capture_count_image, capture_count_voice, capture_count_clip, capture_count_pdf, capture_count_social, processed_count, archived_count)
    VALUES (${id}, ${date}, ${stats.captureCountLink || 0}, ${stats.captureCountNote || 0}, ${stats.captureCountImage || 0}, ${stats.captureCountVoice || 0}, ${stats.captureCountClip || 0}, ${stats.captureCountPdf || 0}, ${stats.captureCountSocial || 0}, ${stats.processedCount || 0}, ${stats.archivedCount || 0})
  `)
  return id
}

// Re-export sql for convenience
export { sql }
