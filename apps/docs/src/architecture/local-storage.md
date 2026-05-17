# Local Storage (Dual SQLite)

memrynote stores all workspace data locally in two SQLite databases via better-sqlite3 and Drizzle ORM.

## Why Two Databases

- **Data DB** — primary, durable storage. Notes, journals, tasks, projects, inbox items, templates, settings, and metadata.
- **Index DB** — derived, rebuildable. Full-text search, link graph, tag indexes, and embedding vectors.

Splitting them buys three properties:

1. **Crash isolation.** Rebuilding the index database never threatens user data.
2. **Cheap reset.** The index can be dropped and rebuilt without re-uploading anything to sync.
3. **Performance.** Heavy read indexes and FTS triggers don't compete with the write path on the data DB.

## Where the Files Live

Inside the vault directory (chosen during [first run](/guide/first-run)):

```
<vault>/
├─ data.db           # primary database
├─ data.db-wal       # write-ahead log
├─ index.db          # derived database
├─ index.db-wal
├─ attachments/      # file payloads
└─ leveldb/          # y-leveldb store for Yjs CRDTs
```

## Schemas

Drizzle schemas live in `packages/db-schema`. Tables of note:

- `notes`, `journals`, `tasks`, `projects`, `inbox_items`, `templates`
- `vault_metadata` (stable vault UUID singleton)
- `agent_conversations`, `agent_messages` (encrypted agent chat history)
- `tags`, `tag_links`, `note_links` (graph)
- `properties`, `property_values`
- `sync_items`, `sync_pull_cursor`, `sync_outbox` (sync state)
- `field_clocks` JSON column on tasks and projects (per-field vector clocks)

## Migrations

```bash
pnpm db:generate    # propose SQL from schema diff
pnpm db:push        # apply pending migrations
pnpm db:studio      # open GUI
```

> Migrations are hand-written from `0020` onward — see [Common Gotchas](/contribute/gotchas).

## Concurrency

better-sqlite3 is synchronous and single-process. The main process is the only writer. The renderer never touches SQLite directly — all reads and writes go through IPC.

## better-sqlite3 ABI Quirk

The native module must match the JS runtime. If you see `ERR_DLOPEN_FAILED`, rebuild for the right target:

- **Node tests**: `pnpm rebuild better-sqlite3`
- **Electron app / E2E**: `bash apps/desktop/scripts/ensure-native.sh electron`

Using the Node fix for Electron leaves vault open silently failing — the app falls through to the welcome screen.
