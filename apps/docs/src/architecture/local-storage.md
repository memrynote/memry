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

## SQLite Memory Budget

The desktop main process opens both databases with bounded SQLite page caches:

- `data.db`: `PRAGMA cache_size = -16000` (about 16 MiB)
- `index.db`: `PRAGMA cache_size = -32000` (about 32 MiB)
- both databases use WAL, `synchronous = NORMAL`, and `temp_store = MEMORY`

The previous caps were about 64 MiB for `data.db` and 128 MiB for `index.db`. A controlled
main-process benchmark with 15,000 notes, 5,000 tasks, 2,000 inbox items, FTS, graph links, and
`sqlite-vec` showed the smaller caches kept focused query latency flat while reducing the maximum
SQLite page-cache budget by about 144 MiB. Observed warm RSS was effectively flat because SQLite
does not preallocate the full cache cap.

| Configuration                               |  Warm RSS | Search p50 / p95 |  Graph p50 / p95 | Tasks p50 / p95 | Inbox p50 / p95 | Vector p50 / p95 |
| ------------------------------------------- | --------: | ---------------: | ---------------: | --------------: | --------------: | ---------------: |
| 64 MiB data / 128 MiB index / `MEMORY` temp | 173.1 MiB |   8.86 / 9.56 ms | 35.56 / 40.95 ms |  0.83 / 1.12 ms |  0.19 / 0.24 ms |   0.34 / 0.46 ms |
| 16 MiB data / 32 MiB index / `MEMORY` temp  | 174.1 MiB |   8.75 / 9.33 ms | 34.45 / 37.65 ms |  0.74 / 0.92 ms |  0.18 / 0.19 ms |   0.30 / 0.58 ms |

`temp_store = MEMORY` stays in place because an isolation run with smaller caches and `FILE` temp
store did not reduce RSS in the smaller smoke benchmark and slightly worsened graph p50. Re-run the
benchmark when search, graph, inbox, or vector query shapes change:

```bash
pnpm --filter @memry/desktop db:benchmark -- --iterations 25
```

## Native Media Processing

Image, PDF, and video thumbnail generation stays local, but the native image stack is not part of
the always-on main process. The desktop app starts an image-processing utility process only when
thumbnail or inbox image metadata work is requested. That worker owns the lazy `sharp` / `libvips`
load, returns the generated metadata or thumbnail bytes over IPC, and shuts down after it has been
idle.

## better-sqlite3 ABI Quirk

The native module must match the JS runtime. If you see `ERR_DLOPEN_FAILED`, rebuild for the right target:

- **Node tests**: `pnpm rebuild better-sqlite3`
- **Electron app / E2E**: `bash apps/desktop/scripts/ensure-native.sh electron`

Using the Node fix for Electron leaves vault open silently failing — the app falls through to the welcome screen.
