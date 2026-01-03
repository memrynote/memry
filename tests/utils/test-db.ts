/**
 * In-memory SQLite database factory for testing.
 * Creates isolated database instances for each test.
 */

import Database from 'better-sqlite3'
import { drizzle, BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { sql } from 'drizzle-orm'
import * as schema from '@shared/db/schema'

export type TestDb = BetterSQLite3Database<typeof schema>

export interface TestDatabaseResult {
  db: TestDb
  sqlite: Database.Database
  close: () => void
}

// ============================================================================
// Data Database Schema (data.db)
// ============================================================================

const DATA_SCHEMA = `
-- Projects table
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  color TEXT NOT NULL DEFAULT '#6366f1',
  icon TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  is_inbox INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  modified_at TEXT NOT NULL DEFAULT (datetime('now')),
  archived_at TEXT
);

-- Statuses table
CREATE TABLE IF NOT EXISTS statuses (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#6b7280',
  position INTEGER NOT NULL DEFAULT 0,
  is_default INTEGER NOT NULL DEFAULT 0,
  is_done INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Tasks table
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  status_id TEXT REFERENCES statuses(id) ON DELETE SET NULL,
  parent_id TEXT,
  title TEXT NOT NULL,
  description TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0,
  due_date TEXT,
  due_time TEXT,
  start_date TEXT,
  repeat_config TEXT,
  repeat_from TEXT,
  source_note_id TEXT,
  completed_at TEXT,
  archived_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  modified_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Task tags junction table
CREATE TABLE IF NOT EXISTS task_tags (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  PRIMARY KEY (task_id, tag)
);

-- Task notes junction table
CREATE TABLE IF NOT EXISTS task_notes (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  note_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (task_id, note_id)
);

-- Settings table
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL,
  modified_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Saved filters table
CREATE TABLE IF NOT EXISTS saved_filters (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  config TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Bookmarks table
CREATE TABLE IF NOT EXISTS bookmarks (
  id TEXT PRIMARY KEY NOT NULL,
  item_type TEXT NOT NULL,
  item_id TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(item_type, item_id)
);
`

// ============================================================================
// Index Database Schema (index.db)
// ============================================================================

const INDEX_SCHEMA = `
-- Note cache table
CREATE TABLE IF NOT EXISTS note_cache (
  id TEXT PRIMARY KEY NOT NULL,
  path TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  emoji TEXT,
  content_hash TEXT NOT NULL,
  word_count INTEGER NOT NULL DEFAULT 0,
  character_count INTEGER NOT NULL DEFAULT 0,
  date TEXT,
  snippet TEXT,
  created_at TEXT NOT NULL,
  modified_at TEXT NOT NULL,
  indexed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Note tags table
CREATE TABLE IF NOT EXISTS note_tags (
  note_id TEXT NOT NULL REFERENCES note_cache(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  pinned_at TEXT,
  PRIMARY KEY (note_id, tag)
);

-- Tag definitions table
CREATE TABLE IF NOT EXISTS tag_definitions (
  name TEXT PRIMARY KEY NOT NULL,
  color TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Note links table
CREATE TABLE IF NOT EXISTS note_links (
  source_id TEXT NOT NULL REFERENCES note_cache(id) ON DELETE CASCADE,
  target_id TEXT,
  target_title TEXT NOT NULL,
  PRIMARY KEY (source_id, target_title)
);

-- Note properties table
CREATE TABLE IF NOT EXISTS note_properties (
  note_id TEXT NOT NULL REFERENCES note_cache(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  value TEXT,
  type TEXT NOT NULL,
  PRIMARY KEY (note_id, name)
);

-- Property definitions table
CREATE TABLE IF NOT EXISTS property_definitions (
  name TEXT PRIMARY KEY NOT NULL,
  type TEXT NOT NULL,
  options TEXT,
  default_value TEXT,
  color TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Note snapshots table
CREATE TABLE IF NOT EXISTS note_snapshots (
  id TEXT PRIMARY KEY NOT NULL,
  note_id TEXT NOT NULL REFERENCES note_cache(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  title TEXT NOT NULL,
  word_count INTEGER NOT NULL DEFAULT 0,
  content_hash TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`

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

  // Create schema
  sqlite.exec(DATA_SCHEMA)

  const db = drizzle(sqlite, { schema })

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

  // Create schema
  sqlite.exec(INDEX_SCHEMA)

  const db = drizzle(sqlite, { schema })

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
    VALUES (${statusIds.inProgress}, ${projectId}, 'In Progress', '#3b82f6', 1, 0, 0)
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

// Re-export sql for convenience
export { sql }
