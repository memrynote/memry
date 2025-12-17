# Data Model: Core Data Layer

**Feature**: Core Data Layer
**Date**: 2025-12-18
**Status**: Complete

## Overview

This document defines the data models for Memry's core data layer, including both file-based storage (notes, journal entries) and SQLite database storage (tasks, projects, settings).

---

## Storage Architecture

```
vault/                          # User-selected vault folder
├── notes/                      # User notes (markdown files)
│   ├── my-note.md
│   └── subfolder/
│       └── another-note.md
├── journal/                    # Daily journal entries
│   ├── 2025-12-18.md
│   └── 2025-12-17.md
├── attachments/                # Binary attachments
│   ├── images/
│   └── files/
└── .memry/                     # App data (hidden folder)
    ├── data.db                 # Source of truth: tasks, projects, settings
    ├── index.db                # Rebuildable: note cache, FTS index
    └── config.json             # Vault-specific configuration
```

---

## File-Based Entities

### Note

Notes are stored as markdown files with YAML frontmatter. The file system is the source of truth.

**File Location**: `vault/notes/**/*.md`

**Frontmatter Schema**:
```yaml
---
id: "a3b7c9d2e1f4"        # Required: Unique identifier (nanoid)
title: "My Note Title"     # Optional: Display title (defaults to filename)
created: "2025-12-18T10:00:00Z"   # Required: ISO 8601 timestamp
modified: "2025-12-18T15:30:00Z"  # Required: ISO 8601 timestamp
tags:                      # Optional: Array of tag strings
  - work
  - important
aliases:                   # Optional: Alternative titles for linking
  - "Old Title"
---

# Note content in markdown...
```

**TypeScript Interface**:
```typescript
interface NoteFrontmatter {
  id: string;
  title?: string;
  created: string;
  modified: string;
  tags?: string[];
  aliases?: string[];
  [key: string]: unknown;  // Allow custom properties
}

interface Note {
  id: string;
  path: string;           // Relative path from vault root
  title: string;          // From frontmatter or filename
  content: string;        // Markdown content (without frontmatter)
  frontmatter: NoteFrontmatter;
  created: Date;
  modified: Date;
  tags: string[];
  aliases: string[];
}
```

**Validation Rules**:
- `id`: 8-21 alphanumeric characters, generated if missing
- `title`: 1-200 characters, extracted from filename if missing
- `created`: Valid ISO 8601 datetime, set to file creation time if missing
- `modified`: Valid ISO 8601 datetime, updated on every save
- `tags`: Array of 1-50 character strings, lowercase normalized

---

### Journal Entry

Daily journal entries are specialized notes with date-based naming.

**File Location**: `vault/journal/YYYY-MM-DD.md`

**Frontmatter Schema**:
```yaml
---
id: "j2025-12-18"          # Required: Prefixed with 'j' + date
date: "2025-12-18"         # Required: ISO 8601 date
created: "2025-12-18T08:00:00Z"
modified: "2025-12-18T20:00:00Z"
mood: "good"               # Optional: User-defined mood
weather: "sunny"           # Optional: Weather note
---

# December 18, 2025

Today's journal content...
```

**TypeScript Interface**:
```typescript
interface JournalFrontmatter extends NoteFrontmatter {
  date: string;           // ISO 8601 date (YYYY-MM-DD)
  mood?: string;
  weather?: string;
}

interface JournalEntry {
  id: string;
  date: Date;
  path: string;
  content: string;
  frontmatter: JournalFrontmatter;
  created: Date;
  modified: Date;
}
```

---

## Database Entities

### data.db Schema (Drizzle ORM)

The `data.db` database stores structured data using **Drizzle ORM** for type-safe schema definitions. These schemas are **shared** between Electron and future React Native apps.

**Location**: `src/shared/db/schema/`

#### Projects Schema
```typescript
// src/shared/db/schema/projects.ts
import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  color: text('color').notNull().default('#6366f1'),
  icon: text('icon'),
  position: integer('position').notNull().default(0),
  isInbox: integer('is_inbox', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  modifiedAt: text('modified_at').notNull().default(sql`(datetime('now'))`),
  archivedAt: text('archived_at'),
});

// Inferred types
export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
```

#### Statuses Schema
```typescript
// src/shared/db/schema/statuses.ts
import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { projects } from './projects';

export const statuses = sqliteTable('statuses', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  color: text('color').notNull().default('#6b7280'),
  position: integer('position').notNull().default(0),
  isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(false),
  isDone: integer('is_done', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
}, (table) => [
  index('idx_statuses_project').on(table.projectId),
]);

export type Status = typeof statuses.$inferSelect;
export type NewStatus = typeof statuses.$inferInsert;
```

#### Tasks Schema
```typescript
// src/shared/db/schema/tasks.ts
import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { projects } from './projects';
import { statuses } from './statuses';

export const tasks = sqliteTable('tasks', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  statusId: text('status_id').references(() => statuses.id, { onDelete: 'set null' }),
  parentId: text('parent_id'), // Self-reference for subtasks

  title: text('title').notNull(),
  description: text('description'),
  priority: integer('priority').notNull().default(0), // 0=none, 1=low, 2=medium, 3=high
  position: integer('position').notNull().default(0),

  dueDate: text('due_date'),       // ISO 8601 date (YYYY-MM-DD)
  dueTime: text('due_time'),       // HH:mm format
  startDate: text('start_date'),   // ISO 8601 date

  repeatConfig: text('repeat_config', { mode: 'json' }), // JSON object
  repeatFrom: text('repeat_from'), // 'due' | 'completion'

  completedAt: text('completed_at'),
  archivedAt: text('archived_at'),

  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  modifiedAt: text('modified_at').notNull().default(sql`(datetime('now'))`),
}, (table) => [
  index('idx_tasks_project').on(table.projectId),
  index('idx_tasks_status').on(table.statusId),
  index('idx_tasks_parent').on(table.parentId),
  index('idx_tasks_due_date').on(table.dueDate),
  index('idx_tasks_completed').on(table.completedAt),
]);

export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
```

#### Task Relations Schema
```typescript
// src/shared/db/schema/task-relations.ts
import { sqliteTable, text, primaryKey, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { tasks } from './tasks';

// Task-Note links
export const taskNotes = sqliteTable('task_notes', {
  taskId: text('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  noteId: text('note_id').notNull(), // References note frontmatter id
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
}, (table) => [
  primaryKey({ columns: [table.taskId, table.noteId] }),
]);

// Task tags
export const taskTags = sqliteTable('task_tags', {
  taskId: text('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  tag: text('tag').notNull(),
}, (table) => [
  primaryKey({ columns: [table.taskId, table.tag] }),
  index('idx_task_tags_tag').on(table.tag),
]);
```

#### Inbox Schema
```typescript
// src/shared/db/schema/inbox.ts
import { sqliteTable, text, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const inboxItems = sqliteTable('inbox_items', {
  id: text('id').primaryKey(),
  type: text('type').notNull(), // 'text' | 'link' | 'voice' | 'image'
  content: text('content').notNull(),
  metadata: text('metadata', { mode: 'json' }), // JSON: { url, title, thumbnail }
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  filedAt: text('filed_at'),
}, (table) => [
  index('idx_inbox_type').on(table.type),
]);

export type InboxItem = typeof inboxItems.$inferSelect;
export type NewInboxItem = typeof inboxItems.$inferInsert;
```

#### Settings Schema
```typescript
// src/shared/db/schema/settings.ts
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(), // JSON-encoded value
  modifiedAt: text('modified_at').notNull().default(sql`(datetime('now'))`),
});

export const savedFilters = sqliteTable('saved_filters', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  config: text('config', { mode: 'json' }).notNull(),
  position: integer('position').notNull().default(0),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
});
```

#### Schema Index (Re-exports)
```typescript
// src/shared/db/schema/index.ts
export * from './projects';
export * from './statuses';
export * from './tasks';
export * from './task-relations';
export * from './inbox';
export * from './settings';
```

---

### index.db Schema (Drizzle ORM)

The `index.db` database is a **rebuildable cache** for note metadata and full-text search. These schemas are also shared but only used with SQLite (FTS5 is SQLite-specific).

**Location**: `src/shared/db/schema/notes-cache.ts`

#### Note Cache Schema
```typescript
// src/shared/db/schema/notes-cache.ts
import { sqliteTable, text, integer, index, primaryKey, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

// Note metadata cache (rebuildable from files)
export const noteCache = sqliteTable('note_cache', {
  id: text('id').primaryKey(),           // From frontmatter
  path: text('path').notNull().unique(), // Relative path from vault
  title: text('title').notNull(),
  contentHash: text('content_hash').notNull(), // For change detection
  wordCount: integer('word_count').notNull().default(0),
  createdAt: text('created_at').notNull(),
  modifiedAt: text('modified_at').notNull(),
  indexedAt: text('indexed_at').notNull().default(sql`(datetime('now'))`),
}, (table) => [
  index('idx_note_cache_path').on(table.path),
  index('idx_note_cache_modified').on(table.modifiedAt),
]);

// Tags extracted from notes
export const noteTags = sqliteTable('note_tags', {
  noteId: text('note_id').notNull().references(() => noteCache.id, { onDelete: 'cascade' }),
  tag: text('tag').notNull(),
}, (table) => [
  primaryKey({ columns: [table.noteId, table.tag] }),
  index('idx_note_tags_tag').on(table.tag),
]);

// Wiki links between notes
export const noteLinks = sqliteTable('note_links', {
  sourceId: text('source_id').notNull().references(() => noteCache.id, { onDelete: 'cascade' }),
  targetId: text('target_id'),           // NULL if target doesn't exist
  targetTitle: text('target_title').notNull(),
}, (table) => [
  primaryKey({ columns: [table.sourceId, table.targetTitle] }),
  index('idx_note_links_target').on(table.targetId),
]);

// Type exports
export type NoteCache = typeof noteCache.$inferSelect;
export type NewNoteCache = typeof noteCache.$inferInsert;
```

#### FTS5 Virtual Table (Raw SQL)

FTS5 virtual tables are not directly supported by Drizzle ORM schema definitions. They must be created via raw SQL during migration:

```typescript
// src/main/database/migrations/index/001_initial.ts
import { sql } from 'drizzle-orm';

export async function createFtsTable(db: DrizzleDb) {
  // FTS5 virtual table for full-text search
  await db.run(sql`
    CREATE VIRTUAL TABLE IF NOT EXISTS fts_notes USING fts5(
      id UNINDEXED,
      title,
      content,
      tags,
      tokenize='porter unicode61'
    )
  `);

  // Triggers to keep FTS in sync with note_cache
  await db.run(sql`
    CREATE TRIGGER IF NOT EXISTS note_cache_ai AFTER INSERT ON note_cache BEGIN
      INSERT INTO fts_notes (id, title, content, tags)
      VALUES (NEW.id, NEW.title, '', '');
    END
  `);

  await db.run(sql`
    CREATE TRIGGER IF NOT EXISTS note_cache_ad AFTER DELETE ON note_cache BEGIN
      DELETE FROM fts_notes WHERE id = OLD.id;
    END
  `);

  await db.run(sql`
    CREATE TRIGGER IF NOT EXISTS note_cache_au AFTER UPDATE ON note_cache BEGIN
      UPDATE fts_notes SET title = NEW.title WHERE id = NEW.id;
    END
  `);
}
```

#### FTS5 Query Helper
```typescript
// src/shared/db/queries/search.ts
import { sql } from 'drizzle-orm';

export function searchNotes(db: DrizzleDb, query: string, limit = 50) {
  // Escape special FTS5 characters
  const escapedQuery = query.replace(/[*"]/g, '') + '*';

  return db.all(sql`
    SELECT
      id,
      title,
      snippet(fts_notes, 2, '<mark>', '</mark>', '...', 30) as snippet,
      bm25(fts_notes) as rank
    FROM fts_notes
    WHERE fts_notes MATCH ${escapedQuery}
    ORDER BY rank
    LIMIT ${limit}
  `);
}
```

---

## TypeScript Interfaces

### Task Entity

```typescript
interface RepeatConfig {
  type: 'daily' | 'weekly' | 'monthly' | 'yearly' | 'custom';
  interval: number;
  days?: number[];           // For weekly: 0=Sun, 1=Mon, etc.
  dayOfMonth?: number;       // For monthly
  endDate?: string;          // ISO 8601 date
}

interface Task {
  id: string;
  projectId: string;
  statusId: string | null;
  parentId: string | null;

  title: string;
  description: string | null;
  priority: 0 | 1 | 2 | 3;
  position: number;

  dueDate: string | null;
  dueTime: string | null;
  startDate: string | null;

  repeatConfig: RepeatConfig | null;
  repeatFrom: 'due' | 'completion' | null;

  completedAt: Date | null;
  archivedAt: Date | null;

  createdAt: Date;
  modifiedAt: Date;

  // Relations (loaded separately)
  subtasks?: Task[];
  linkedNotes?: string[];    // Note IDs
  tags?: string[];
}
```

### Project Entity

```typescript
interface Project {
  id: string;
  name: string;
  description: string | null;
  color: string;
  icon: string | null;
  position: number;
  isInbox: boolean;
  createdAt: Date;
  modifiedAt: Date;
  archivedAt: Date | null;

  // Relations
  statuses?: Status[];
  taskCount?: number;
}

interface Status {
  id: string;
  projectId: string;
  name: string;
  color: string;
  position: number;
  isDefault: boolean;
  isDone: boolean;
  createdAt: Date;
}
```

### Inbox Item Entity

```typescript
interface LinkMetadata {
  url: string;
  title?: string;
  description?: string;
  thumbnail?: string;
  siteName?: string;
}

interface InboxItem {
  id: string;
  type: 'text' | 'link' | 'voice' | 'image';
  content: string;
  metadata: LinkMetadata | null;
  createdAt: Date;
  filedAt: Date | null;
}
```

### Settings Entity

```typescript
interface AppSettings {
  // Appearance
  theme: 'light' | 'dark' | 'system';
  fontSize: number;

  // Editor
  spellCheck: boolean;
  autoSave: boolean;
  autoSaveInterval: number;

  // Tasks
  defaultProject: string;
  showCompletedTasks: boolean;
  archiveCompletedAfterDays: number;

  // Search
  searchIncludeArchived: boolean;

  // Vault
  excludePatterns: string[];
}

// Stored as key-value pairs in settings table
type SettingKey = keyof AppSettings;
```

---

## Relationships

```
┌─────────────────────────────────────────────────────────────────────┐
│                           VAULT (File System)                        │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌──────────┐    links to    ┌──────────┐                          │
│  │   Note   │ ──────────────▶│   Note   │                          │
│  │   (.md)  │◀────────────── │   (.md)  │   (wiki links)           │
│  └────┬─────┘                └──────────┘                          │
│       │                                                             │
│       │ has tags                                                    │
│       ▼                                                             │
│  ┌──────────┐                                                       │
│  │   Tags   │                                                       │
│  └──────────┘                                                       │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                          data.db (SQLite)                            │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌──────────┐   contains    ┌──────────┐   has child   ┌─────────┐ │
│  │ Project  │ ─────────────▶│   Task   │ ────────────▶ │  Task   │ │
│  └────┬─────┘               └────┬─────┘               │(subtask)│ │
│       │                          │                      └─────────┘ │
│       │ has statuses             │ links to                         │
│       ▼                          ▼                                  │
│  ┌──────────┐              ┌──────────┐                             │
│  │  Status  │              │   Note   │  (via note_id)              │
│  └──────────┘              └──────────┘                             │
│                                                                      │
│  ┌──────────┐                                                       │
│  │  Inbox   │ ─────▶ can become Task or Note                        │
│  │   Item   │                                                       │
│  └──────────┘                                                       │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                         index.db (SQLite)                            │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌─────────────┐   indexed in   ┌─────────────┐                    │
│  │ note_cache  │ ──────────────▶│  fts_notes  │                    │
│  └──────┬──────┘                └─────────────┘                    │
│         │                                                           │
│         │ extracted from files                                      │
│         ▼                                                           │
│  ┌─────────────┐              ┌─────────────┐                      │
│  │ note_tags   │              │ note_links  │                      │
│  └─────────────┘              └─────────────┘                      │
│                                                                      │
│  (All data rebuildable from vault files)                            │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Migration Strategy

### Drizzle Kit Migration Workflow

Drizzle Kit generates and manages migrations automatically from schema changes.

#### Configuration
```typescript
// drizzle.config.ts
import type { Config } from 'drizzle-kit';

export default {
  schema: './src/shared/db/schema/index.ts',
  out: './src/main/database/drizzle',
  dialect: 'sqlite',
  dbCredentials: {
    url: './vault/.memry/data.db',
  },
} satisfies Config;
```

#### Migration Commands
```bash
# Generate migrations from schema changes
npx drizzle-kit generate

# Apply migrations (development - pushes directly)
npx drizzle-kit push

# View database in Drizzle Studio
npx drizzle-kit studio
```

#### Generated Migration Example
```sql
-- src/main/database/drizzle/0000_init.sql
CREATE TABLE `projects` (
  `id` text PRIMARY KEY NOT NULL,
  `name` text NOT NULL,
  `description` text,
  `color` text DEFAULT '#6366f1' NOT NULL,
  `icon` text,
  `position` integer DEFAULT 0 NOT NULL,
  `is_inbox` integer DEFAULT false NOT NULL,
  `created_at` text DEFAULT (datetime('now')) NOT NULL,
  `modified_at` text DEFAULT (datetime('now')) NOT NULL,
  `archived_at` text
);
-- ... more tables
```

### Programmatic Migration Runner

For Electron, migrations run at app startup:

```typescript
// src/main/database/migrate.ts
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import Database from 'better-sqlite3';
import path from 'path';

export function runMigrations(dbPath: string, migrationsPath: string) {
  const sqlite = new Database(dbPath);
  const db = drizzle(sqlite);

  // Run all pending migrations
  migrate(db, { migrationsFolder: migrationsPath });

  sqlite.close();
}

// Usage at app startup
runMigrations(
  path.join(vaultPath, '.memry', 'data.db'),
  path.join(__dirname, 'drizzle')
);
```

### Seed Data

Create default inbox project after initial migration:

```typescript
// src/main/database/seed.ts
import { eq } from 'drizzle-orm';
import { projects } from '@shared/db/schema';

export async function seedDefaults(db: DrizzleDb) {
  // Check if inbox exists
  const inbox = await db.select()
    .from(projects)
    .where(eq(projects.id, 'inbox'))
    .get();

  if (!inbox) {
    await db.insert(projects).values({
      id: 'inbox',
      name: 'Inbox',
      isInbox: true,
      position: 0,
    });
  }
}
```

---

## Validation

All entity validation uses Zod schemas at system boundaries:

```typescript
import { z } from 'zod';

export const TaskCreateSchema = z.object({
  projectId: z.string(),
  title: z.string().min(1).max(500),
  description: z.string().max(10000).optional(),
  priority: z.number().int().min(0).max(3).default(0),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dueTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  tags: z.array(z.string().max(50)).max(20).optional(),
  parentId: z.string().optional()
});

export const NoteCreateSchema = z.object({
  title: z.string().min(1).max(200),
  content: z.string(),
  tags: z.array(z.string().max(50)).max(50).optional(),
  folder: z.string().optional()  // Subfolder path
});

export type TaskCreateInput = z.infer<typeof TaskCreateSchema>;
export type NoteCreateInput = z.infer<typeof NoteCreateSchema>;
```
