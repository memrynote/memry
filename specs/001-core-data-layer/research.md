# Research: Core Data Layer

**Feature**: Core Data Layer
**Date**: 2025-12-18
**Status**: Complete

## Overview

This document captures research findings for the technology decisions in Memry's core data layer implementation.

---

## 1. Database Layer: Drizzle ORM + better-sqlite3

### Decision
Use **Drizzle ORM** v0.38.x with **better-sqlite3** driver for Electron, enabling future React Native support with shared schema/query code.

### Rationale
- **Platform Agnostic**: Same TypeScript schemas work with different SQLite drivers
- **Future-Proof**: React Native support via expo-sqlite or op-sqlite driver
- **Type Safety**: Full TypeScript inference from schema definitions
- **Zero Runtime Overhead**: Drizzle compiles to raw SQL at build time
- **Great DX**: Auto-complete, type-safe queries, migration generation

### Why Not better-sqlite3 Alone?

better-sqlite3 is a **Node.js native module** that cannot run in React Native. Using Drizzle ORM provides:

```
┌─────────────────────────────────────────────┐
│        Drizzle ORM (shared schemas)         │
│   src/shared/db/schema/* (platform-agnostic)│
└─────────────────┬───────────────────────────┘
                  │
        ┌─────────┴─────────┐
        ▼                   ▼
┌───────────────┐   ┌───────────────┐
│   Electron    │   │ React Native  │
│ better-sqlite3│   │  expo-sqlite  │
└───────────────┘   └───────────────┘
```

### Key Implementation Patterns

#### Schema Definition (Shared)
```typescript
// src/shared/db/schema/tasks.ts
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const tasks = sqliteTable('tasks', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull(),
  title: text('title').notNull(),
  description: text('description'),
  priority: integer('priority').notNull().default(0),
  position: integer('position').notNull().default(0),
  dueDate: text('due_date'),
  completedAt: text('completed_at'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  modifiedAt: text('modified_at').notNull().default(sql`(datetime('now'))`),
});

// TypeScript types inferred from schema
export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
```

#### Database Client (Electron-specific)
```typescript
// src/main/database/client.ts
import { drizzle } from 'drizzle-orm/better-sqlite3';
import Database from 'better-sqlite3';
import * as schema from '@shared/db/schema';

export function createDataDb(dbPath: string) {
  const sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');

  return drizzle(sqlite, { schema });
}
```

#### Type-Safe Queries (Shared)
```typescript
// src/shared/db/queries/tasks.ts
import { eq, and, isNull, desc } from 'drizzle-orm';
import { tasks } from '../schema';

export function getIncompleteTasks(db: DrizzleDb) {
  return db.select()
    .from(tasks)
    .where(isNull(tasks.completedAt))
    .orderBy(tasks.position);
}

export function getTasksByProject(db: DrizzleDb, projectId: string) {
  return db.select()
    .from(tasks)
    .where(eq(tasks.projectId, projectId))
    .orderBy(tasks.position);
}

export function createTask(db: DrizzleDb, task: NewTask) {
  return db.insert(tasks).values(task).returning();
}
```

#### Transactions
```typescript
import { sql } from 'drizzle-orm';

async function completeTaskWithSubtasks(db: DrizzleDb, taskId: string) {
  return db.transaction(async (tx) => {
    const now = new Date().toISOString();

    // Complete parent task
    await tx.update(tasks)
      .set({ completedAt: now })
      .where(eq(tasks.id, taskId));

    // Complete all subtasks
    await tx.update(tasks)
      .set({ completedAt: now })
      .where(eq(tasks.parentId, taskId));
  });
}
```

### Drizzle Kit Configuration

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

### Migration Commands

```bash
# Generate migration from schema changes
npx drizzle-kit generate

# Apply migrations (development)
npx drizzle-kit push

# View current schema
npx drizzle-kit studio
```

### Electron Integration

#### Native Binding Rebuild
```bash
# In package.json scripts
"postinstall": "electron-rebuild"

# Or via npx
npx @electron/rebuild -f -w better-sqlite3
```

#### electron-vite Configuration
```typescript
// electron.vite.config.ts
export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        external: ['better-sqlite3']
      }
    }
  }
});
```

### Alternatives Considered

| Library | Pros | Cons | Decision |
|---------|------|------|----------|
| **better-sqlite3 alone** | Simpler, faster | No React Native support; major refactor later | Rejected |
| **Prisma** | Great DX | Electron issues, no React Native, heavy runtime | Rejected |
| **sql.js (WASM)** | Cross-platform | 3-5x slower, larger bundle | Rejected |
| **TypeORM** | Full-featured ORM | Heavy, poor TypeScript inference | Rejected |
| **Kysely** | Type-safe SQL builder | Less mature ecosystem | Monitor |

---

## 2. File Watching: chokidar

### Decision
Use **chokidar** v4.x for cross-platform file system watching.

### Rationale
- **Cross-platform**: Consistent behavior on macOS, Windows, Linux
- **Efficient**: Uses native OS APIs (FSEvents, inotify, ReadDirectoryChangesW)
- **Battle-tested**: Used by webpack, VS Code extensions, and thousands of projects
- **v4 Improvements**: Better performance, simpler API, reduced memory usage

### Key Implementation Patterns

#### Watcher Setup
```typescript
import chokidar from 'chokidar';

const watcher = chokidar.watch(vaultPath, {
  persistent: true,

  // Ignore patterns - note v4 uses function-based ignored
  ignored: (path, stats) => {
    // Ignore hidden files and specific directories
    const basename = path.split('/').pop() || '';
    if (basename.startsWith('.')) return true;
    if (basename === 'node_modules') return true;
    // Only watch .md files
    return stats?.isFile() && !path.endsWith('.md');
  },

  // Wait for file writes to complete
  awaitWriteFinish: {
    stabilityThreshold: 100,
    pollInterval: 50
  },

  // Handle atomic writes (temp file → rename)
  atomic: true,

  // Don't emit events for initial scan
  ignoreInitial: false,

  // Recursively watch subdirectories
  depth: 99,

  // Don't follow symlinks (security)
  followSymlinks: false,

  // Use polling only on network drives
  usePolling: false
});
```

#### Event Handling
```typescript
// Debounce helper for batching rapid changes
const debounce = <T extends (...args: unknown[]) => void>(fn: T, ms: number) => {
  let timeoutId: NodeJS.Timeout;
  return (...args: Parameters<T>) => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn(...args), ms);
  };
};

const handleChange = debounce((path: string) => {
  // Process file change
  notifyRenderer('file:changed', { path });
}, 100);

watcher
  .on('add', (path) => handleFileAdd(path))
  .on('change', (path) => handleChange(path))
  .on('unlink', (path) => handleFileDelete(path))
  .on('addDir', (path) => handleDirAdd(path))
  .on('unlinkDir', (path) => handleDirDelete(path))
  .on('ready', () => console.log('Initial scan complete'))
  .on('error', (error) => console.error('Watcher error:', error));
```

#### Rename Detection Strategy
```typescript
// chokidar emits 'unlink' then 'add' for renames
// Use UUID matching within a time window to detect renames

interface PendingDelete {
  path: string;
  uuid: string;
  timestamp: number;
}

const pendingDeletes = new Map<string, PendingDelete>();
const RENAME_WINDOW_MS = 500;

function handleUnlink(path: string) {
  const uuid = getUuidFromCache(path);
  if (uuid) {
    pendingDeletes.set(uuid, { path, uuid, timestamp: Date.now() });

    // Clean up after window expires
    setTimeout(() => {
      if (pendingDeletes.has(uuid)) {
        pendingDeletes.delete(uuid);
        // This was a real delete, not a rename
        processDelete(path, uuid);
      }
    }, RENAME_WINDOW_MS);
  }
}

function handleAdd(path: string) {
  const uuid = parseUuidFromFile(path);
  if (uuid && pendingDeletes.has(uuid)) {
    const pending = pendingDeletes.get(uuid)!;
    pendingDeletes.delete(uuid);
    // This is a rename!
    processRename(pending.path, path, uuid);
  } else {
    processAdd(path);
  }
}
```

### Linux Configuration
```bash
# Increase inotify watch limit for large vaults
echo fs.inotify.max_user_watches=524288 | sudo tee -a /etc/sysctl.conf
sudo sysctl -p
```

### Alternatives Considered

| Library | Pros | Cons | Decision |
|---------|------|------|----------|
| **@parcel/watcher** | Faster for very large directories | Less mature, fewer features | Monitor for v2 |
| **node-watch** | Simpler API | Fewer features, less reliable | Rejected |
| **fs.watch (native)** | No dependency | Inconsistent across platforms | Rejected |

---

## 3. Frontmatter Parsing: gray-matter

### Decision
Use **gray-matter** v4.x for YAML frontmatter parsing and serialization.

### Rationale
- **Standard**: De facto standard for frontmatter parsing in JavaScript
- **Fast**: Optimized parser, handles large files efficiently
- **Flexible**: Supports YAML, JSON, TOML, and custom delimiters
- **Reliable**: Mature library with excellent edge case handling

### Key Implementation Patterns

#### Parsing Frontmatter
```typescript
import matter from 'gray-matter';

interface NoteFrontmatter {
  id: string;
  title: string;
  created: string;
  modified: string;
  tags?: string[];
}

function parseNote(content: string): { data: NoteFrontmatter; content: string } {
  const { data, content: body } = matter(content);

  return {
    data: data as NoteFrontmatter,
    content: body.trim()
  };
}
```

#### Serializing Frontmatter
```typescript
function serializeNote(frontmatter: NoteFrontmatter, content: string): string {
  return matter.stringify(content, frontmatter);
}

// Example output:
// ---
// id: abc123
// title: My Note
// created: 2025-12-18T10:00:00Z
// modified: 2025-12-18T10:00:00Z
// tags:
//   - work
//   - important
// ---
//
// Note content here...
```

#### Handling Missing Frontmatter
```typescript
function ensureFrontmatter(content: string, filePath: string): string {
  const parsed = matter(content);

  if (!parsed.data.id) {
    // Generate new UUID for files without one
    parsed.data.id = generateId();
    parsed.data.created = new Date().toISOString();
  }

  if (!parsed.data.title) {
    // Extract title from filename
    parsed.data.title = path.basename(filePath, '.md');
  }

  parsed.data.modified = new Date().toISOString();

  return matter.stringify(parsed.content, parsed.data);
}
```

#### Frontmatter Schema
```typescript
import { z } from 'zod';

const NoteFrontmatterSchema = z.object({
  id: z.string().min(1),
  title: z.string().optional(),
  created: z.string().datetime(),
  modified: z.string().datetime(),
  tags: z.array(z.string()).optional().default([]),
  aliases: z.array(z.string()).optional().default([]),
  // Custom properties preserved
}).passthrough();

function validateFrontmatter(data: unknown): NoteFrontmatter {
  return NoteFrontmatterSchema.parse(data);
}
```

### Alternatives Considered

| Library | Pros | Cons | Decision |
|---------|------|------|----------|
| **js-yaml** | More YAML features | Manual frontmatter extraction needed | Rejected |
| **remark-frontmatter** | Part of unified ecosystem | More complex setup | Rejected |
| **Custom regex** | No dependency | Error-prone, edge cases | Rejected |

---

## 4. Unique Identifiers: nanoid

### Decision
Use **nanoid** v5.x for generating unique identifiers.

### Rationale
- **Compact**: 21 characters by default (vs 36 for UUID)
- **URL-safe**: No special characters
- **Secure**: Cryptographically strong random
- **Fast**: Hardware random generator when available

### Implementation
```typescript
import { nanoid, customAlphabet } from 'nanoid';

// Default: 21 characters, URL-safe
const generateId = () => nanoid(); // e.g., "V1StGXR8_Z5jdHi6B-myT"

// Custom: Lowercase alphanumeric for readability in filenames
const noteId = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 12);
// e.g., "a3b7c9d2e1f4"
```

---

## 5. FTS5 Full-Text Search

### Decision
Use SQLite's built-in **FTS5** extension for full-text search.

### Rationale
- **Built-in**: No additional dependencies
- **Fast**: Optimized for text search with ranking
- **Powerful**: Supports phrase search, prefix search, boolean operators
- **Lightweight**: Minimal index overhead

### Implementation
```sql
-- Create FTS5 virtual table
CREATE VIRTUAL TABLE fts_notes USING fts5(
  id UNINDEXED,
  title,
  content,
  tags,
  tokenize='porter unicode61'
);

-- Search with ranking
SELECT id, title,
       bm25(fts_notes, 0, 10.0, 1.0, 5.0) as rank
FROM fts_notes
WHERE fts_notes MATCH ?
ORDER BY rank
LIMIT 50;
```

```typescript
// TypeScript wrapper
function searchNotes(query: string, limit = 50): SearchResult[] {
  const stmt = db.prepare(`
    SELECT id, title, snippet(fts_notes, 2, '<mark>', '</mark>', '...', 30) as snippet,
           bm25(fts_notes) as rank
    FROM fts_notes
    WHERE fts_notes MATCH ?
    ORDER BY rank
    LIMIT ?
  `);

  // Escape special FTS5 characters
  const escapedQuery = query.replace(/[*"]/g, '');

  return stmt.all(escapedQuery + '*', limit);
}
```

---

## 6. Atomic File Writes

### Decision
Use **write-to-temp-then-rename** pattern for all file writes.

### Rationale
- **Crash-safe**: Incomplete writes don't corrupt existing files
- **Cross-platform**: Works reliably on all OS
- **Simple**: No complex journaling needed

### Implementation
```typescript
import { writeFile, rename, unlink } from 'fs/promises';
import { randomBytes } from 'crypto';
import path from 'path';

async function atomicWrite(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath);
  const tempPath = path.join(dir, `.${randomBytes(6).toString('hex')}.tmp`);

  try {
    // Write to temporary file
    await writeFile(tempPath, content, 'utf-8');

    // Atomic rename (overwrites existing file)
    await rename(tempPath, filePath);
  } catch (error) {
    // Clean up temp file on error
    try {
      await unlink(tempPath);
    } catch {
      // Ignore cleanup errors
    }
    throw error;
  }
}
```

---

## 7. IPC Communication Pattern

### Decision
Use **typed IPC channels** with Zod validation at boundaries.

### Rationale
- **Type Safety**: Compile-time and runtime validation
- **Security**: Never trust renderer input
- **Maintainability**: Single source of truth for API types

### Implementation
```typescript
// shared/ipc-types.ts
import { z } from 'zod';

export const NoteCreateSchema = z.object({
  title: z.string().min(1).max(200),
  content: z.string(),
  tags: z.array(z.string()).optional()
});

export type NoteCreateInput = z.infer<typeof NoteCreateSchema>;

// main/ipc/notes-handlers.ts
ipcMain.handle('notes:create', async (_, input: unknown) => {
  const validated = NoteCreateSchema.parse(input);
  return notesService.create(validated);
});

// preload/index.ts
const api = {
  notes: {
    create: (input: NoteCreateInput) =>
      ipcRenderer.invoke('notes:create', input)
  }
};
```

---

## Research Questions Resolved

| Question | Resolution |
|----------|------------|
| Database layer for React Native? | Drizzle ORM with platform-specific drivers (better-sqlite3 for Electron, expo-sqlite for RN) |
| better-sqlite3 with electron-vite? | Works with @electron/rebuild and external rollup config |
| Drizzle ORM performance? | <1% overhead vs raw SQL; compiles to optimized queries |
| chokidar v4 breaking changes? | Glob patterns removed; use `ignored` function instead |
| Rename detection without inode? | Use UUID matching within 500ms window |
| FTS5 vs external search? | FTS5 sufficient for <50ms on 10k notes |
| Atomic writes cross-platform? | temp-file-then-rename works on all platforms |
| Schema sharing Electron ↔ RN? | Put schemas in `src/shared/db/`, import with path alias |

---

## Deferred Research

These topics are noted for future investigation:

1. **Vector embeddings**: SQLite vec extension vs dedicated vector DB
2. **CRDT sync**: Automerge vs Yjs for future conflict-free sync
3. **Encryption**: libsodium integration patterns for E2EE phase
4. **Voice transcription**: Whisper API vs local whisper.cpp
5. **React Native driver**: expo-sqlite vs op-sqlite performance comparison
