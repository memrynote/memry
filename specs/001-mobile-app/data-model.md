# Data Model: Memry Mobile

**Feature**: 001-mobile-app | **Date**: 2026-08-22 | **Plan**: [plan.md](./plan.md)

Three storage domains. The first is new (mobile-local, no legacy rows — its
migration ledger starts at 0001). The other two are **live production surfaces**:
every change is additive, hand-written, and must tolerate data written by older
desktop versions (Constitution I; decision record non-negotiable).

## 1. Mobile-local SQLite (per vault)

One SQLite database file per vault, in the app sandbox with
`NSFileProtectionCompleteUntilFirstUserAuthentication` (DB must be readable when a
`BGAppRefreshTask` runs before first unlock after reboot — verified in R7).
Driver per research.md R2. Desktop's dual-DB split (data/index) collapses to a
single file on mobile: FTS tables are rebuildable and live alongside data;
dropping/rebuilding FTS never touches item rows.

**Store-of-record rules** (decision record §5, constitution Mobile Platform
Constraints):

- No files for notes. Bodies live in SQLite as **raw markdown including
  frontmatter, byte-identical to desktop**, so `@memry/app-core` parsing works
  unchanged.
- Attachment bytes are sandbox files under the vault directory, never blobs;
  rows hold metadata + relative path.
- Yjs update log and sync outbox are tables — never memory-only.
- No keys, plaintext or derived, ever appear in this DB.

### Entities

| Table | Purpose | Key fields (sketch) |
|---|---|---|
| `meta` | schema version, vault id, device id, server-advertised state cache (min-version verdict, read-only flag, entitlement snapshot) | `key TEXT PK, value TEXT` |
| `sync_items` | one row per synced item, all 12 types; mirrors desktop item metadata semantics | `id TEXT PK, type TEXT CHECK(type IN (…12…)), vault_id, updated_at, deleted_at NULL, vector_clock TEXT(JSON), remote_revision, payload_state TEXT('metadata-only'\|'full')` |
| `note_bodies` | SQLite-backed `NoteContentStore` — the interface desktop already defines | `item_id TEXT PK REFERENCES sync_items, markdown TEXT (raw incl. frontmatter), body_hash TEXT, fetched_at` |
| `folders` | folder hierarchy for notes browsing | `id, parent_id, name, position` |
| `yjs_updates` | CRDT persistence replacing `y-leveldb`; append-only + periodic compaction into `yjs_snapshots` | `doc_id TEXT, seq INTEGER, update BLOB, created_at; PK(doc_id, seq)` |
| `yjs_snapshots` | compacted state vectors/snapshots per doc | `doc_id TEXT PK, snapshot BLOB, last_seq, compacted_at` |
| `outbox` | durable write queue; survives force-quit/restart (FR-005) | `id INTEGER PK AUTOINCREMENT, item_type, item_id, op TEXT('upsert'\|'delete'\|'crdt-update'), payload BLOB NULL, payload_path TEXT NULL, enqueued_at, attempt_count, last_error, next_attempt_at` |
| `sync_cursors` | pull cursors per item type + body-window bookkeeping (30-day window, on-demand backfill) | `scope TEXT PK, cursor TEXT, window_start, updated_at` |
| `attachments` | lazy-download state; policy per item (FR-009) | `item_id TEXT PK, note_refs TEXT(JSON), remote_size, local_path TEXT NULL, downloaded_at NULL, wifi_only INTEGER DEFAULT 1, pinned INTEGER DEFAULT 0` |
| `fts_notes`, `fts_tasks`, `fts_inbox`, `fts_journal` | FTS5 virtual tables (contentless or external-content over the item tables); rebuildable | FTS5, `tokenize` matching desktop's index semantics |
| `reminders_local` | scheduled-notification bookkeeping so stale notifications can be reconciled (edge case: fired for an item completed elsewhere) | `reminder_id PK, item_id, fire_at, os_notification_id, scheduled_at` |

Typed projections for tasks/projects/events/inbox (columns for due dates,
priority, recurrence, project links…) follow desktop's field semantics
one-to-one; exact columns are fixed in tasks.md against
`packages/db-schema` at implementation time — **semantics may not diverge**
(Constitution IV). Field-level vector clocks for tasks/projects ride in
`sync_items.vector_clock` exactly as desktop encodes them.

**Unknown-field preservation** (spec edge case): payloads written by newer desktop
versions round-trip through `sync_items`/`outbox` untouched — mobile never
re-serializes fields it does not model. Item handlers operate on the shared
`@memry/sync-client` types, which already tolerate unknown members.

### State transitions

- `sync_items.payload_state`: `metadata-only → full` (on-demand body fetch;
  never backwards).
- `outbox` rows: `enqueued → attempting (attempt_count++) → gone (acked)` or
  `→ parked (next_attempt_at backoff)`. Rows are deleted only on server ack.
  Kill-switch/read-only mode **parks** the queue; it never drops it (FR-010).
- `attachments`: `remote-only → downloading → local`; eviction only of
  `downloaded` bytes (files), never of rows; `pinned` exempts from eviction.

## 2. Device secure store (expo-secure-store)

`WHEN_UNLOCKED_THIS_DEVICE_ONLY`, non-synchronizable. Never in DB, logs,
telemetry, or backups (FR-003).

| Key | Value | Notes |
|---|---|---|
| `memry.session.<accountId>` | auth session/refresh token | |
| `memry.vault.<vaultId>.key` | unwrapped vault key (after password/recovery unlock) | absence ⇒ locked state |
| `memry.device.<vaultId>.signing` | device Ed25519 keypair (registration/signature) | generated on device |
| `memry.device.id` | stable device identifier | |

No Face ID gate in v1 (decision record §8) — device unlock is the boundary.
Both password and recovery-phrase unlock paths produce the same stored vault key.

## 3. Sync-server (D1) — additive migrations only

Live production. Migrations continue the existing ledger (next: `0006_…`).
Hand-written SQL; every statement must be a no-op risk for existing rows; older
desktop clients (which send no new headers/fields) must keep working unchanged.

Numbers below are indicative — assign the next free ledger number at land time.
Ship order is **client gate first** (Train Phase 2, §3b–3c) and Apple IAP later
(Train Phase 5, §3a), matching tasks.md T027/T113.

### 3a. Entitlement: Apple source + transaction mapping

`sync_entitlements.source` is an existing TEXT column
(`'none'|'paddle'|'admin_override'|'dev_seed'`). The decision record's
"row gains `source: 'paddle' | 'apple'`" lands as:

- **TypeScript**: extend `SyncEntitlementSource` union with `'apple'` — zero DDL.
- **DDL (additive)** — Apple state + mapping table the record independently
  requires (`originalTransactionId → account`):

```sql
-- 0007_apple_iap.sql (sketch — hand-verified against production rows before apply)
CREATE TABLE IF NOT EXISTS apple_transactions (
  original_transaction_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN ('Sandbox','Production')),
  status TEXT NOT NULL,              -- ASSN V2-derived: active|expired|revoked|grace|billing_retry
  expires_at INTEGER,
  last_notification_type TEXT,
  last_notification_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_apple_transactions_user ON apple_transactions(user_id);
```

**Merge rule** (record §9, FR-040/041): effective entitlement =
active(paddle) ∪ active(apple); when both active, the **later expiry governs**
the effective `expires_at`/plan; the `sync_entitlements` row is recomputed on
every Paddle webhook, every ASSN V2 notification, and on entitlement read.
`source` records which platform currently governs. **Double-subscription
detection** = both sides active simultaneously ⇒ flag in the account/entitlement
API response so the app surfaces it (never silently absorbed). Existing
Paddle-only rows are untouched by the migration (no backfill needed —
`apple_transactions` is empty for them).

### 3b. Client version gate + kill switch (Train Phase 2 — production safety)

```sql
-- 0006_client_gate.sql (sketch)
CREATE TABLE IF NOT EXISTS client_policies (
  platform TEXT PRIMARY KEY,          -- 'ios' | 'android' | 'desktop'
  min_write_version TEXT,             -- semver floor; NULL = no floor
  writes_enabled INTEGER NOT NULL DEFAULT 1,  -- 0 = per-platform kill switch
  updated_at INTEGER NOT NULL
);
```

Requests without an `x-memry-client` header are legacy desktop and remain fully
allowed (backward compatibility is mandatory). Enforcement semantics in
[contracts/sync-protocol-additions.md](./contracts/sync-protocol-additions.md).

### 3c. Write attribution

Additive nullable columns on the item-write path — **`sync_items`,
`crdt_updates`, `crdt_snapshots`** (fixed against the current D1 schema in
migration `0006_client_gate.sql`): `client_platform TEXT NULL`,
`client_version TEXT NULL` stamped server-side from the header at write time.
No backfill, and a partial index on `sync_items(user_id, vault_id,
client_platform) WHERE client_platform IS NOT NULL` so the desktop-only present
(every row NULL) costs nothing.
NULL = written by a pre-header client. Enables incident tracing and targeted
rollback of mobile-originated writes (FR-011). No read path depends on them.

## 4. Cross-shell contracts reaffirmed

- **Vault bytes are the contract**: note markdown (incl. frontmatter), crypto
  vectors, sync payload shapes, settings shapes — byte-compatible across shells
  and versions (Constitution I). Mobile introduces **no new payload formats**.
- Canvas payloads: mobile reads, renders, and never writes (FR-033/034);
  byte-identity after viewing is a G4 check.
- Settings: mobile applies synced preferences where the concept exists; it
  round-trips groups it does not model without stripping them (settings-sync
  merge is not REPLACE — see desktop behaviour).
