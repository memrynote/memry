# Quickstart: Core Data Layer

**Feature**: Core Data Layer
**Date**: 2025-12-18
**Estimated Setup Time**: 30 minutes

## Prerequisites

- Node.js 20+ installed
- pnpm 8+ installed
- Git repository cloned
- Existing Memry frontend working (`pnpm dev` runs successfully)

## Step 1: Install Dependencies

```bash
# Install core data layer dependencies
pnpm add drizzle-orm better-sqlite3 chokidar gray-matter nanoid electron-store zod

# Install dev dependencies
pnpm add -D drizzle-kit @electron/rebuild @types/better-sqlite3 vitest
```

## Step 2: Configure Native Module Rebuilding

Add to `package.json`:

```json
{
  "scripts": {
    "postinstall": "electron-rebuild",
    "rebuild": "electron-rebuild -f -w better-sqlite3",
    "db:generate": "drizzle-kit generate",
    "db:push": "drizzle-kit push",
    "db:studio": "drizzle-kit studio"
  }
}
```

Run the rebuild:

```bash
pnpm rebuild
```

## Step 3: Configure electron-vite

Update `electron.vite.config.ts` to externalize native modules:

```typescript
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        external: ['better-sqlite3']
      }
    },
    resolve: {
      alias: {
        '@shared': path.resolve(__dirname, 'src/shared')
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    resolve: {
      alias: {
        '@': path.resolve(__dirname, 'src/renderer/src'),
        '@shared': path.resolve(__dirname, 'src/shared')
      }
    },
    plugins: [react()]
  }
});
```

## Step 4: Create Drizzle Configuration

Create `drizzle.config.ts` in the project root:

```typescript
import type { Config } from 'drizzle-kit';

export default {
  schema: './src/shared/db/schema/index.ts',
  out: './src/main/database/drizzle',
  dialect: 'sqlite',
  dbCredentials: {
    url: './test.db', // For development/generation only
  },
} satisfies Config;
```

## Step 5: Create Directory Structure

```bash
# Create shared database directories
mkdir -p src/shared/db/schema
mkdir -p src/shared/db/queries

# Create main process directories
mkdir -p src/main/database/drizzle
mkdir -p src/main/vault
mkdir -p src/main/ipc
mkdir -p src/main/lib

# Create renderer service directories
mkdir -p src/renderer/src/services
mkdir -p src/renderer/src/hooks
```

## Step 6: Create Drizzle Schema Files

Create `src/shared/db/schema/projects.ts`:

```typescript
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
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

export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
```

Create `src/shared/db/schema/tasks.ts`:

```typescript
import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { projects } from './projects';

export const tasks = sqliteTable('tasks', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  parentId: text('parent_id'),
  title: text('title').notNull(),
  description: text('description'),
  priority: integer('priority').notNull().default(0),
  position: integer('position').notNull().default(0),
  dueDate: text('due_date'),
  completedAt: text('completed_at'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  modifiedAt: text('modified_at').notNull().default(sql`(datetime('now'))`),
}, (table) => [
  index('idx_tasks_project').on(table.projectId),
  index('idx_tasks_due_date').on(table.dueDate),
]);

export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
```

Create `src/shared/db/schema/index.ts`:

```typescript
export * from './projects';
export * from './tasks';
// Add more exports as you create schema files
```

## Step 7: Generate Initial Migration

```bash
# Generate SQL migration from schema
pnpm db:generate
```

This creates migration files in `src/main/database/drizzle/`.

## Step 8: Initialize Database Module

Create `src/main/database/client.ts`:

```typescript
import { drizzle, BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import Database from 'better-sqlite3';
import * as schema from '@shared/db/schema';

export type DrizzleDb = BetterSQLite3Database<typeof schema>;

let dataDb: DrizzleDb | null = null;
let sqliteDb: Database.Database | null = null;

export function initDatabase(dbPath: string): DrizzleDb {
  sqliteDb = new Database(dbPath);
  sqliteDb.pragma('journal_mode = WAL');
  sqliteDb.pragma('foreign_keys = ON');

  dataDb = drizzle(sqliteDb, { schema });
  return dataDb;
}

export function getDatabase(): DrizzleDb {
  if (!dataDb) throw new Error('Database not initialized');
  return dataDb;
}

export function closeDatabase(): void {
  sqliteDb?.close();
  sqliteDb = null;
  dataDb = null;
}
```

Create `src/main/database/migrate.ts`:

```typescript
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import Database from 'better-sqlite3';
import path from 'path';

export function runMigrations(dbPath: string): void {
  const sqlite = new Database(dbPath);
  const db = drizzle(sqlite);

  const migrationsFolder = path.join(__dirname, 'drizzle');
  migrate(db, { migrationsFolder });

  sqlite.close();
}
```

Create `src/main/database/index.ts`:

```typescript
export { initDatabase, getDatabase, closeDatabase, type DrizzleDb } from './client';
export { runMigrations } from './migrate';
```

## Step 9: Create Example Query Functions

Create `src/shared/db/queries/tasks.ts`:

```typescript
import { eq, isNull, desc } from 'drizzle-orm';
import { tasks, type Task, type NewTask } from '../schema';
import type { DrizzleDb } from '../../main/database';

export function getAllTasks(db: DrizzleDb): Task[] {
  return db.select().from(tasks).all();
}

export function getIncompleteTasks(db: DrizzleDb): Task[] {
  return db.select()
    .from(tasks)
    .where(isNull(tasks.completedAt))
    .orderBy(tasks.position)
    .all();
}

export function getTasksByProject(db: DrizzleDb, projectId: string): Task[] {
  return db.select()
    .from(tasks)
    .where(eq(tasks.projectId, projectId))
    .orderBy(tasks.position)
    .all();
}

export function createTask(db: DrizzleDb, task: NewTask): Task {
  return db.insert(tasks).values(task).returning().get();
}

export function completeTask(db: DrizzleDb, taskId: string): Task | undefined {
  return db.update(tasks)
    .set({ completedAt: new Date().toISOString() })
    .where(eq(tasks.id, taskId))
    .returning()
    .get();
}
```

## Step 10: Update Main Process

Update `src/main/index.ts`:

```typescript
import { app, BrowserWindow, ipcMain } from 'electron';
import { join } from 'path';
import { initDatabase, closeDatabase, runMigrations } from './database';
import { registerTasksHandlers } from './ipc/tasks-handlers';

let vaultPath = '/path/to/vault'; // Load from electron-store

async function initializeApp(): Promise<void> {
  const dbPath = join(vaultPath, '.memry', 'data.db');

  // Run migrations
  runMigrations(dbPath);

  // Initialize database connection
  initDatabase(dbPath);

  // Register IPC handlers
  registerTasksHandlers();
}

app.whenReady().then(async () => {
  await initializeApp();
  createWindow();
});

app.on('before-quit', () => {
  closeDatabase();
});
```

## Step 11: Create IPC Handlers

Create `src/main/ipc/tasks-handlers.ts`:

```typescript
import { ipcMain } from 'electron';
import { getDatabase } from '../database';
import * as taskQueries from '@shared/db/queries/tasks';
import { nanoid } from 'nanoid';

export function registerTasksHandlers(): void {
  ipcMain.handle('tasks:list', async () => {
    const db = getDatabase();
    return taskQueries.getAllTasks(db);
  });

  ipcMain.handle('tasks:create', async (_, input: { title: string; projectId: string }) => {
    const db = getDatabase();
    return taskQueries.createTask(db, {
      id: nanoid(),
      title: input.title,
      projectId: input.projectId,
    });
  });

  ipcMain.handle('tasks:complete', async (_, taskId: string) => {
    const db = getDatabase();
    return taskQueries.completeTask(db, taskId);
  });
}
```

## Step 12: Verify Setup

```bash
# Run type check
pnpm typecheck

# Generate migrations if schema changed
pnpm db:generate

# Run development server
pnpm dev

# Open Drizzle Studio to inspect database (optional)
pnpm db:studio
```

## Troubleshooting

### "Cannot find module 'better-sqlite3'"

Run the rebuild script:
```bash
pnpm rebuild
```

### "Cannot find module '@shared/db/schema'"

Ensure path aliases are configured in:
1. `electron.vite.config.ts` (build-time)
2. `tsconfig.json` (type-checking)

Add to `tsconfig.json`:
```json
{
  "compilerOptions": {
    "paths": {
      "@shared/*": ["./src/shared/*"]
    }
  }
}
```

### "EMFILE: too many open files" (Linux)

Increase inotify limit:
```bash
echo fs.inotify.max_user_watches=524288 | sudo tee -a /etc/sysctl.conf
sudo sysctl -p
```

### Drizzle Kit errors

Ensure the database file exists or use `push` for development:
```bash
# Create empty db and push schema directly (development)
pnpm db:push
```

## Next Steps

1. Complete all schema files (see `data-model.md`)
2. Implement vault selection UI
3. Add file watcher with chokidar
4. Connect existing TasksProvider to real database
5. Implement search with FTS5

## File Checklist

After completing setup, you should have:

```
src/
├── shared/
│   └── db/
│       ├── schema/
│       │   ├── index.ts           ✓ Schema exports
│       │   ├── projects.ts        ✓ Projects schema
│       │   └── tasks.ts           ✓ Tasks schema
│       └── queries/
│           └── tasks.ts           ✓ Task queries
├── main/
│   ├── index.ts                   ✓ Updated with init
│   ├── database/
│   │   ├── index.ts              ✓ Exports
│   │   ├── client.ts             ✓ Drizzle client
│   │   ├── migrate.ts            ✓ Migration runner
│   │   └── drizzle/              ✓ Generated migrations
│   └── ipc/
│       └── tasks-handlers.ts     ✓ Example handlers

drizzle.config.ts                  ✓ Drizzle Kit config
```

## React Native (Future)

When building the React Native app, you'll:

1. Use the **same** `src/shared/db/schema/` files
2. Use the **same** `src/shared/db/queries/` files
3. Create a different database client:

```typescript
// react-native/database/client.ts
import { drizzle } from 'drizzle-orm/expo-sqlite';
import { openDatabaseSync } from 'expo-sqlite';
import * as schema from '@shared/db/schema';

const sqlite = openDatabaseSync('data.db');
export const db = drizzle(sqlite, { schema });
```

The queries work identically across platforms!
