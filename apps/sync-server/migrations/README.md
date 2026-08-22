# sync-server D1 migrations

Canonical schema for the sync-server D1 database. `wrangler d1 migrations apply`
runs any `NNNN_*.sql` file not yet recorded in the database's `d1_migrations`
table, in order. Both deploy workflows apply migrations **before**
`wrangler deploy`, so code never ships ahead of its schema (expand-before-deploy).

## Rules

- **Never edit an applied migration.** Add a new `NNNN_description.sql` file.
- **Additive by default.** New nullable columns / new tables / new indexes apply
  cleanly with zero downtime. For a removal, use expand-then-contract across two
  releases: first ship code that stops using the column, then a later migration
  drops it.
- Number files sequentially, zero-padded (`0002_`, `0003_`, ...).
- **No semicolon inside a trailing `-- comment`.** `tests/sync-harness`'s
  migration runner drops full-line comments and then splits on `;`, so a
  semicolon in a trailing comment tears the statement in two and every
  harness-backed desktop integration test dies with
  `D1_ERROR: incomplete input`. Wrangler itself parses correctly; the harness
  does not.
- `wrangler d1 migrations create <db> <name>` scaffolds a new file.

## Local dev

```bash
pnpm --filter @memry/sync-server run sync:init-db   # applies migrations to the local D1
```

## Baseline (one-time, completed 2026-07-08)

`0001_baseline.sql` is the full schema at the point migrations were adopted. It
is idempotent (`IF NOT EXISTS`), so it no-ops on the already-provisioned staging
and production databases and fully provisions a fresh one.

Because `CREATE TABLE IF NOT EXISTS` cannot add columns to a table that already
exists with an older shape, production had drifted from the schema (its Worker
code queried columns the DB never got, returning 500s on `/sync/vaults` and
device linking). Production was reconciled to the baseline out-of-band once:

```sql
-- memry-sync-production only (staging already had these columns)
ALTER TABLE sync_vaults      ADD COLUMN encrypted_name TEXT;
ALTER TABLE sync_vaults      ADD COLUMN name_nonce TEXT;
ALTER TABLE linking_sessions ADD COLUMN encrypted_vault_transfer TEXT;
ALTER TABLE linking_sessions ADD COLUMN encrypted_vault_transfer_nonce TEXT;
ALTER TABLE linking_sessions ADD COLUMN vault_transfer_confirm TEXT;
ALTER TABLE linking_sessions ADD COLUMN vault_transfer_version INTEGER;
```

Then both databases were baselined by recording `0001` as applied:

```bash
wrangler d1 migrations apply DB --remote --env staging
wrangler d1 migrations apply DB --remote --env production
```

From here, every schema change is a tracked migration applied by CI.
