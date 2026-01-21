# Database

Drizzle ORM with better-sqlite3.

## Two Databases

| Database | Purpose | Schema File |
|----------|---------|-------------|
| `data.db` | Source of truth (tasks, projects, settings) | `data-schema.ts` |
| `index.db` | Rebuildable cache (note search, FTS) | `index-schema.ts` |

Schema files: `src/shared/db/schema/`

## Commands

```bash
pnpm db:generate       # Generate migrations (both DBs)
pnpm db:generate:data  # Generate migrations for data.db only
pnpm db:generate:index # Generate migrations for index.db only
pnpm db:push           # Push schema to DBs (dev only)
pnpm db:push:data      # Push schema to data.db only
pnpm db:push:index     # Push schema to index.db only
pnpm db:studio:data    # Open Drizzle Studio for data.db
pnpm db:studio:index   # Open Drizzle Studio for index.db
pnpm rebuild           # Rebuild native modules (better-sqlite3)
```

## Tables

**data.db**: projects, statuses, tasks, task_notes, task_tags, inbox_items, settings, saved_filters

**index.db**: note_cache, note_tags, note_links, note_properties, property_definitions

## Client

Database client with SQLite pragmas: `src/main/database/client.ts`

Both databases use WAL mode for better concurrency.
