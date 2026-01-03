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
  parent_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0,
  due_date TEXT,
  due_time TEXT,
  start_date TEXT,
  is_repeating INTEGER NOT NULL DEFAULT 0,
  repeat_config TEXT,
  repeat_from TEXT,
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
  PRIMARY KEY (task_id, note_id)
);

-- Settings table
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Saved filters table
CREATE TABLE IF NOT EXISTS saved_filters (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  config TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  modified_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Inbox items table
CREATE TABLE IF NOT EXISTS inbox_items (
  id TEXT PRIMARY KEY NOT NULL,
  type TEXT NOT NULL,
  title TEXT,
  content TEXT,
  source_url TEXT,
  attachment_path TEXT,
  metadata TEXT,
  tags TEXT,
  filed_to TEXT,
  filed_action TEXT,
  snoozed_until TEXT,
  snooze_reason TEXT,
  archived_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  modified_at TEXT NOT NULL DEFAULT (datetime('now'))
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

-- Reminders table
CREATE TABLE IF NOT EXISTS reminders (
  id TEXT PRIMARY KEY NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  remind_at TEXT NOT NULL,
  title TEXT,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  snoozed_until TEXT,
  dismissed_at TEXT,
  highlight_text TEXT,
  highlight_start INTEGER,
  highlight_end INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  modified_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`

// ============================================================================
// Index Database Schema (index.db)
// ============================================================================

const INDEX_SCHEMA = `
-- Note cache table
CREATE TABLE IF NOT EXISTS note_cache (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  folder TEXT,
  content TEXT,
  word_count INTEGER DEFAULT 0,
  emoji TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  modified_at TEXT NOT NULL DEFAULT (datetime('now')),
  indexed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Note tags table
CREATE TABLE IF NOT EXISTS note_tags (
  note_id TEXT NOT NULL REFERENCES note_cache(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  PRIMARY KEY (note_id, tag)
);

-- Note links table
CREATE TABLE IF NOT EXISTS note_links (
  source_id TEXT NOT NULL REFERENCES note_cache(id) ON DELETE CASCADE,
  target_id TEXT REFERENCES note_cache(id) ON DELETE CASCADE,
  target_title TEXT NOT NULL,
  PRIMARY KEY (source_id, target_title)
);

-- Note properties table
CREATE TABLE IF NOT EXISTS note_properties (
  note_id TEXT NOT NULL REFERENCES note_cache(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  value TEXT,
  type TEXT NOT NULL DEFAULT 'text',
  PRIMARY KEY (note_id, name)
);

-- Property definitions table
CREATE TABLE IF NOT EXISTS property_definitions (
  name TEXT PRIMARY KEY NOT NULL,
  type TEXT NOT NULL DEFAULT 'text',
  options TEXT,
  default_value TEXT,
  color TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Tag pins table
CREATE TABLE IF NOT EXISTS tag_pins (
  note_id TEXT NOT NULL,
  tag TEXT NOT NULL,
  pinned_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (note_id, tag)
);

-- Tag colors table
CREATE TABLE IF NOT EXISTS tag_colors (
  tag TEXT PRIMARY KEY NOT NULL,
  color TEXT NOT NULL
);

-- Note snapshots table
CREATE TABLE IF NOT EXISTS note_snapshots (
  id TEXT PRIMARY KEY NOT NULL,
  note_id TEXT NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  word_count INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- FTS virtual table for full-text search
CREATE VIRTUAL TABLE IF NOT EXISTS note_fts USING fts5(
  id UNINDEXED,
  title,
  content,
  tags,
  content='note_cache',
  content_rowid='rowid'
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

// Re-export sql for convenience
export { sql }
