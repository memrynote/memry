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

-- Inbox items table
CREATE TABLE IF NOT EXISTS inbox_items (
  id TEXT PRIMARY KEY NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  modified_at TEXT NOT NULL DEFAULT (datetime('now')),
  filed_at TEXT,
  filed_to TEXT,
  filed_action TEXT,
  snoozed_until TEXT,
  snooze_reason TEXT,
  viewed_at TEXT,
  processing_status TEXT DEFAULT 'complete',
  processing_error TEXT,
  metadata TEXT,
  attachment_path TEXT,
  thumbnail_path TEXT,
  transcription TEXT,
  transcription_status TEXT,
  source_url TEXT,
  source_title TEXT,
  archived_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_inbox_items_type ON inbox_items(type);
CREATE INDEX IF NOT EXISTS idx_inbox_items_created ON inbox_items(created_at);
CREATE INDEX IF NOT EXISTS idx_inbox_items_filed ON inbox_items(filed_at);
CREATE INDEX IF NOT EXISTS idx_inbox_items_snoozed ON inbox_items(snoozed_until);
CREATE INDEX IF NOT EXISTS idx_inbox_items_processing ON inbox_items(processing_status);
CREATE INDEX IF NOT EXISTS idx_inbox_items_archived ON inbox_items(archived_at);

-- Inbox item tags table
CREATE TABLE IF NOT EXISTS inbox_item_tags (
  id TEXT PRIMARY KEY NOT NULL,
  item_id TEXT NOT NULL REFERENCES inbox_items(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_inbox_tags_item ON inbox_item_tags(item_id);
CREATE INDEX IF NOT EXISTS idx_inbox_tags_tag ON inbox_item_tags(tag);

-- Filing history table
CREATE TABLE IF NOT EXISTS filing_history (
  id TEXT PRIMARY KEY NOT NULL,
  item_type TEXT NOT NULL,
  item_content TEXT,
  filed_to TEXT NOT NULL,
  filed_action TEXT NOT NULL,
  tags TEXT,
  filed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_filing_history_type ON filing_history(item_type);
CREATE INDEX IF NOT EXISTS idx_filing_history_filed_at ON filing_history(filed_at);

-- Inbox stats table
CREATE TABLE IF NOT EXISTS inbox_stats (
  id TEXT PRIMARY KEY NOT NULL,
  date TEXT NOT NULL UNIQUE,
  capture_count_link INTEGER DEFAULT 0,
  capture_count_note INTEGER DEFAULT 0,
  capture_count_image INTEGER DEFAULT 0,
  capture_count_voice INTEGER DEFAULT 0,
  capture_count_clip INTEGER DEFAULT 0,
  capture_count_pdf INTEGER DEFAULT 0,
  capture_count_social INTEGER DEFAULT 0,
  capture_count_reminder INTEGER DEFAULT 0,
  processed_count INTEGER DEFAULT 0,
  archived_count INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_inbox_stats_date ON inbox_stats(date);

-- Suggestion feedback table
CREATE TABLE IF NOT EXISTS suggestion_feedback (
  id TEXT PRIMARY KEY NOT NULL,
  item_id TEXT NOT NULL,
  item_type TEXT NOT NULL,
  suggested_to TEXT NOT NULL,
  actual_to TEXT NOT NULL,
  accepted INTEGER NOT NULL,
  confidence INTEGER NOT NULL,
  suggested_tags TEXT,
  actual_tags TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_suggestion_feedback_item_type ON suggestion_feedback(item_type);
CREATE INDEX IF NOT EXISTS idx_suggestion_feedback_accepted ON suggestion_feedback(accepted);
CREATE INDEX IF NOT EXISTS idx_suggestion_feedback_created ON suggestion_feedback(created_at);
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
