# Local Storage (Dual SQLite)

Memry stores all workspace data locally in two SQLite databases via better-sqlite3 + Drizzle ORM.

## Data Database

The primary, user-visible store. Holds notes, journals, tasks, projects, inbox items, templates, settings, and metadata.

## Index Database

A derived store optimized for fast lookups: full-text search, tag indexes, link graph, and (when enabled) embedding vectors.

## Why Split?

- **Crash isolation**: rebuilding the index never threatens user data.
- **Reset cost**: the index can be dropped and rebuilt without sync churn.
- **Performance**: heavy read indexes don't compete with write paths in the data DB.

## Schemas

Drizzle schemas live in `packages/db-schema`. Migrations are hand-written from `0020` onward — see [Common Gotchas](/contribute/gotchas).

## Migrations

```bash
pnpm db:generate  # propose migration SQL from schema diff
pnpm db:push      # apply pending migrations
pnpm db:studio    # open Drizzle Studio
```
