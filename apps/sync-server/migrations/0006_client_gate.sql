-- Production-safety kit for the mobile shell (spec 001-mobile-app, Train Phase 1
-- deliverable; contracts/sync-protocol-additions.md §1-4). Two independent
-- pieces, one migration because neither is useful without the other:
--
--   1. `client_policies` -- a per-platform write floor and kill switch, so an
--      iOS build that corrupts vaults can be dropped to read-only with one
--      config change instead of an App Store review cycle.
--   2. write attribution -- which platform/version wrote a row, so an incident
--      can be traced and mobile-originated writes rolled back selectively.
--
-- Backward compatibility (mandatory -- real users on real data):
--   * `client_policies` is EMPTY after this migration. An empty table means
--     "no floor, writes enabled" for every platform, so behaviour is unchanged
--     until someone deliberately inserts a row. Nothing is seeded here on
--     purpose: a seeded `desktop` row would be a live kill switch pointed at
--     the only shell that exists today.
--   * The attribution columns are nullable with no default. NULL means "written
--     by a client that predates the `x-memry-client` header" -- which is every
--     desktop build shipped so far. No backfill: there is no honest value to
--     backfill WITH, and a single UPDATE over sync_items/crdt_updates would be
--     the most expensive statement this ledger has ever run.
--   * A Worker deployed before this migration (or rolled back after it) never
--     reads or writes these columns, so old server code is unaffected.

CREATE TABLE IF NOT EXISTS client_policies (
  platform TEXT PRIMARY KEY,                  -- 'ios' | 'android' | 'desktop'
  min_write_version TEXT,                     -- semver floor, NULL = no floor
  writes_enabled INTEGER NOT NULL DEFAULT 1,  -- 0 = per-platform kill switch
  updated_at INTEGER NOT NULL
);

-- Attribution. Three tables carry item writes, and all three are stamped:
-- `sync_items` is the record path (tasks, projects, settings, ...), while a
-- note's BODY lands in `crdt_updates` / `crdt_snapshots`. Stamping only
-- `sync_items` would leave exactly the payload most likely to need a targeted
-- rollback -- note text written from a phone -- unattributed.
ALTER TABLE sync_items ADD COLUMN client_platform TEXT;
ALTER TABLE sync_items ADD COLUMN client_version TEXT;

ALTER TABLE crdt_updates ADD COLUMN client_platform TEXT;
ALTER TABLE crdt_updates ADD COLUMN client_version TEXT;

ALTER TABLE crdt_snapshots ADD COLUMN client_platform TEXT;
ALTER TABLE crdt_snapshots ADD COLUMN client_version TEXT;

-- Incident-shaped query: "everything iOS wrote to this vault since <cursor>".
-- Partial index so the desktop-only present (every row NULL) costs nothing.
CREATE INDEX IF NOT EXISTS idx_sync_items_client_platform
  ON sync_items(user_id, vault_id, client_platform)
  WHERE client_platform IS NOT NULL;
