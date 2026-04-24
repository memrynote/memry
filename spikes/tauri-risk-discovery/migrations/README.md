# S3 Bench — Memry Migrations (ported)

Shared SQL migrations for **S3 Test #7 — Migration run elapsed cold**.

## Source

Copied from `apps/desktop/src/main/database/drizzle-data/` at spike start
(2026-04-24). 29 files, 0000–0028, ~763 lines total.

- 0000–0019: Drizzle-generated (uses `--> statement-breakpoint` comment markers).
- 0020+: hand-written (per MEMORY.md `project_migrations_hand_written.md`).

Both formats are valid SQLite — `--> statement-breakpoint` is just a comment
ignored by SQLite's parser.

## Usage in benchmark

The bench runner (`tests/bench/db-7-migration.spec.ts`) reads all 29 files via
`fs.readFileSync` and passes them as a `string[]` to each prototype's
`*_run_migrations_bench` Tauri command (Option A / C: rusqlite
`execute_batch`; Option B: plugin-sql `db.execute` per statement).

Each command opens a **fresh scratch DB** (`/tmp/s3-bench-migrations-<pid>.db`),
applies all migrations, returns elapsed milliseconds, then cleans up.

## Why ported (not synthetic)

Synthetic schemas would test SQLite parsing speed, not realistic migration
load. Memry's migrations include FK cascades, FTS5 virtual tables, JSON
defaults, partial indexes, etc. — load representative of what Subproject 2
will face in production.

## Reproduce

```bash
# Re-port from main memry tree
cp apps/desktop/src/main/database/drizzle-data/*.sql \
   spikes/tauri-risk-discovery/migrations/
```

## Maintenance

These are a **frozen snapshot** for the spike. They will not be kept in sync
with memry's evolving schema. After Spike 0 cleanup, this directory + the
spikes/ tree is deleted. Findings + benchmarks survive in
`docs/spikes/tauri-risk-discovery/`.
