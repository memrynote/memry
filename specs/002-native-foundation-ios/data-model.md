# Data Model: `memry-core` v1

**Feature**: 002-native-foundation-ios | **Date**: 2026-09-12 | **Plan**: [plan.md](./plan.md)

The storage the shared core owns, the secrets it keeps outside that storage, the
state machines it exposes to a shell, and the invariants that hold across shells.

Three storage domains, in descending order of how much damage a mistake does:

1. **Secure store** (Keychain on iOS), reached through a seam. Key material only.
2. **Core-owned SQLite**, two databases per vault. Everything else.
3. **Sandbox files**, for downloaded image bytes. Never database blobs.

The sync server's D1 schema is not in scope: this feature adds nothing to it beyond
the additive Apple identity provider recorded in
[plan.md](./plan.md), Decision Record Fidelity.

Baseline and sources. The nine-table mobile schema at
`apps/mobile/src/db/migrations/0001_baseline.sql` is the starting point, extended for
this feature's scope. Field lists for the typed projections are taken from
`packages/db-schema/src/schema/*.ts` and the payload schemas in
`packages/contracts/src/sync-payloads.ts`, because a projection that diverges from
the payload cannot round-trip. `apps/mobile` is frozen and consulted as reference
only.

---

## A. Core-owned SQLite

### A.0 Layout, protection, and migrations

Two databases per vault, per [plan.md](./plan.md), Technical Context, Storage:

```text
Application Support/<bundle>/vault/<vaultId>/
  data.db        # source of record plus typed projections
  index.db       # rebuildable search and link index
  images/        # downloaded inline image bytes, one file per chunk-assembled image
```

| Property        | Value                                             | Reason                                                                                                                                  |
| --------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Journal mode    | WAL on both databases                             | concurrent read during a write pass                                                                                                     |
| File protection | `completeUntilFirstUserAuthentication`            | a background refresh task can run before the first unlock after reboot, and must still read the database                                |
| Backup          | excluded from off-device backup                   | FR-024, and the phone-restore edge case: the secure store does not survive a restore, so a restored database would be unreadable anyway |
| Foreign keys    | on                                                |                                                                                                                                         |
| Migrations      | `PRAGMA user_version`, hand written, forward only | matches the mobile baseline (`apps/mobile/src/db/index.ts:69-86`) and avoids a migrations table that itself needs migrating             |

The migration convention, restated normatively because it is easy to get subtly
wrong: read `user_version`; for each migration whose version exceeds it, run the
migration's statements inside one transaction, then set `user_version` to that
migration's number **outside** that transaction, immediately after it commits. The
two databases carry independent `user_version` counters. Migrations never run
backwards and never drop a column; a removed concept leaves its column in place
unread, because a rollback to an older build must still open the file.

**Every migration statement must be idempotent**, because setting the counter
outside the transaction opens a crash window the counter cannot describe: the
migration commits, the process dies, `user_version` still names the previous
version, and the migration runs a second time against a database that already has
its objects. Write `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS` and
`INSERT OR IGNORE`, so that re-running a committed migration is a clean no-op
rather than a `table already exists` failure. Without this the crash window is not
merely a retry, it is unrecoverable: the transaction is all-or-nothing, so on the
re-run either every object the migration creates exists or none does, and the
plain `CREATE TABLE` form can never make progress again. The counter stays outside
the transaction anyway, because DDL and the `user_version` pragma do not share
rollback semantics on every SQLite build; idempotency is what makes that ordering
safe rather than merely conventional.

`index.db` is deletable. If it is missing, corrupt, or at an unexpected
`user_version`, the core deletes it and rebuilds it from `data.db` rather than
migrating it. That is the whole reason for the split: a full-text index rebuild
never touches a row that holds unsynced user data.

**One vault, one key.** Everything in this section assumes a vault directory is
keyed by a vault key derived from the account master key, which is Q01.4 in
[contracts/protocol-spec-outline.md](./contracts/protocol-spec-outline.md) and must
be answered at G1. If an account can ever hold vaults under different master keys,
the per-vault directory layout survives but the secure store in section B does not,
because `MASTER_KEY` is a single per-account entry.

**Two databases, not one.** The mobile baseline used a single file
(`specs/001-mobile-app/data-model.md:16-18`). This feature follows desktop and
[plan.md](./plan.md), Technical Context, Storage instead, because a rebuildable index that shares a file
with the outbox cannot be dropped without risking the outbox, and because an FTS5
rebuild on a 10,000 item vault is a large write that should not contend with sync.

### A.1 Source of record versus rebuildable projection

This distinction is the backbone of FR-033 and it must be encoded in the schema, not
in a convention.

| Class                      | Tables                                                                                                               | Rule                                                                                                                                                                                                                                         |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Source of record**       | `meta`, `sync_items`, `yjs_updates`, `yjs_snapshots`, `outbox`, `sync_cursors`, `attachments`, `local_notifications` | Never derived. Losing a row loses user data or duplicates a write.                                                                                                                                                                           |
| **Rebuildable projection** | every typed domain table in `data.db` listed in A.4                                                                  | Derived from `sync_items.payload` by replaying every row through the per-type projector. Dropping and rebuilding them is a supported recovery.                                                                                               |
| **Rebuildable index**      | everything in `index.db`                                                                                             | Derived from `data.db`. Dropping the whole file is a supported recovery.                                                                                                                                                                     |
| **Materialised body**      | `note_bodies`                                                                                                        | `text` is derived from the Yjs log and is a pure projection. `seed_markdown` is **not** derived: until the WebView seeds the document it is the only copy of what the user asked for, so it is source of record for its short life. See A.3. |

`sync_items.payload` holds the decrypted payload **exactly as received**, as a text
column, and is never re-serialised. That single rule is the whole of FR-033: a field
a newer desktop wrote and this core does not model survives because the core parses a
copy for its projections and pushes the stored string back. The mobile baseline states
the same rule (`apps/mobile/src/db/migrations/0001_baseline.sql:10-12`,
`apps/mobile/src/db/pull-store.ts:24-26`) and the pull store contract makes it an
obligation on the implementer (`packages/sync-client/src/pull/store.ts:5-10`).

A corollary the projectors must obey: a projection column is a **cache of a parse**,
so an update that changes only an unmodelled field still rewrites `payload` and
leaves every projection column untouched. And a local edit writes the projection
**and** rewrites `payload` by merging the changed keys into the parsed copy, never by
serialising the projection row.

### A.2 `data.db`, source of record

**`meta`**. Key-value scalars. Source of record.

| Column  | Type             | Notes |
| ------- | ---------------- | ----- |
| `key`   | TEXT PRIMARY KEY |       |
| `value` | TEXT NOT NULL    |       |

Reserved keys: `schema.vault_id`, `schema.account_id`, `device.id`,
`first_sync.completed`, `first_sync.window_start`, `policy.writes_enabled`,
`policy.min_write_version`, `policy.checked_at`, `entitlement.active`,
`entitlement.checked_at`, `vault.crypto.verifier.v1` (the local vault key verifier
from `apps/desktop/src/main/crypto/vault-key-state.ts:14-26`).

**`sync_items`**. One row per synced item of every type, including types this
client does not model. Source of record.

| Column             | Type             | Notes                                                                                    |
| ------------------ | ---------------- | ---------------------------------------------------------------------------------------- |
| `item_type`        | TEXT NOT NULL    | no CHECK constraint, deliberately: 25 types exist today and a newer desktop may add more |
| `item_id`          | TEXT NOT NULL    |                                                                                          |
| `payload`          | TEXT             | the decrypted payload verbatim; NULL while `payload_state` is `metadata-only`            |
| `payload_state`    | TEXT NOT NULL    | `metadata-only` or `full`, one-way                                                       |
| `clock`            | TEXT             | JSON vector clock, extracted for indexing only; `payload` remains authoritative          |
| `field_clocks`     | TEXT             | JSON field clocks; NULL for types that do not carry them                                 |
| `server_cursor`    | INTEGER          | the cursor this row was last seen at                                                     |
| `signer_device_id` | TEXT             |                                                                                          |
| `updated_at`       | INTEGER NOT NULL | epoch milliseconds                                                                       |
| `deleted_at`       | INTEGER          | non-NULL means tombstone                                                                 |
| `corrupt_reason`   | TEXT             | set when decrypt, verify or parse failed; the row is skipped, not retried in a loop      |
| `corrupt_at`       | INTEGER          |                                                                                          |

Primary key is `(item_type, item_id)`, **not `item_id` alone**. Tag definition ids
are tag names and folder config ids are folder paths, so an id-only key makes a
project and a tag both named `inbox` share one row and corrupt each other's state.
That is a real incident, dated 2026-07-18
(`apps/desktop/src/main/sync/engine/sync-context.ts:118-124`).

Indexes on `(item_type, updated_at)`, on `deleted_at` where it is not NULL, and on
`payload_state` where it is `metadata-only`, which is the query the windowed first
sync drives.

**`yjs_updates`**. The two-namespace CRDT update log. Source of record for note and
journal bodies. That journal bodies belong here at all is **pending G1 ratification
of Q07.1**: if a journal body turns out to travel as a record rather than as a CRDT
document, journal rows leave this table and live in `sync_items.payload` instead.

| Column        | Type             | Notes                                                   |
| ------------- | ---------------- | ------------------------------------------------------- |
| `doc_id`      | TEXT NOT NULL    | see the namespace rule below                            |
| `seq`         | INTEGER NOT NULL |                                                         |
| `update_blob` | BLOB NOT NULL    | named for the blob, because `update` is a reserved word |
| `created_at`  | INTEGER NOT NULL |                                                         |

Primary key `(doc_id, seq)`.

**`yjs_snapshots`**. Compacted state per document. Source of record.

| Column            | Type             | Notes                                                                |
| ----------------- | ---------------- | -------------------------------------------------------------------- |
| `doc_id`          | TEXT PRIMARY KEY |                                                                      |
| `snapshot`        | BLOB NOT NULL    |                                                                      |
| `last_seq`        | INTEGER NOT NULL | the fold point; every update at or below it was folded in            |
| `server_revision` | TEXT             | the server's snapshot `revision` token, NULL for the local namespace |
| `compacted_at`    | INTEGER NOT NULL |                                                                      |

**The two-namespace rule.** A document has two independent sequence spaces in the
same two tables, distinguished by the `doc_id` prefix:

| Namespace | `doc_id`                                                          | Sequence source                                                                                                                   |
| --------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| server    | the bare document id, for example `abc123def456` or `j2026-04-16` | the server's `sequence_num`                                                                                                       |
| local     | `local.` followed by the same id                                  | a local counter, read inside the writing transaction as one past the greatest sequence this namespace has ever issued — see below |

They must not share a space. A local append taking a sequence a later server row
also claims would silently drop one of the two under an upsert
(`apps/mobile/src/editor/session.ts:27`, `:35-40`). A document is only fully loaded
when both halves have been replayed, in the order server snapshot, server updates,
local snapshot, local updates
(`apps/mobile/src/editor/doc-manager.ts:26-27`, `:341-350`). Reading "updates since
N" must also consult the snapshot row, because a fold deletes the update rows it
absorbed and an updates-only read returns empty for a document that did change
(`apps/mobile/src/editor/session.ts:62-79`).

Document ids are bare, with no type prefix: a note id is 12 lowercase alphanumerics
and a journal id is `j` followed by an ISO date
(`apps/desktop/src/main/lib/id.ts:13-20`). The `local.` prefix cannot collide with
either.

**`outbox`**. The durable write queue. Source of record, and the one table whose
loss loses a user's work.

| Column            | Type                              | Notes                                                    |
| ----------------- | --------------------------------- | -------------------------------------------------------- |
| `id`              | INTEGER PRIMARY KEY AUTOINCREMENT | the only rowid table; ordering is the ack key            |
| `item_type`       | TEXT NOT NULL                     |                                                          |
| `item_id`         | TEXT NOT NULL                     | for a CRDT row, the document id                          |
| `op`              | TEXT NOT NULL                     | `upsert`, `delete`, or `crdt-update`                     |
| `payload`         | BLOB                              | the encrypted-ready payload, or the raw Yjs update bytes |
| `enqueued_at`     | INTEGER NOT NULL                  |                                                          |
| `attempt_count`   | INTEGER NOT NULL DEFAULT 0        |                                                          |
| `last_error`      | TEXT                              | **truncated to 500 characters**                          |
| `next_attempt_at` | INTEGER                           | NULL means claimable now                                 |

Index on `next_attempt_at`.

`last_error` is capped at **500 characters** so a server error body cannot turn
a queue row into a log sink. The cap is stated because "truncated" without a
number is not reproducible: two clients would disagree about the stored value
of the same failure.

**"Acknowledged locally with a recorded reason" is one transaction, not an
archive.** A row the client retires without the server accepting it — a payload
the server will never take, say — has `last_error` written and is then deleted,
both in the same transaction, and the reason is reported to the caller in the
wave's result. There is no dead-letter table and this document defines none:
the row's purpose is to make a pending write durable, and once the client has
decided not to send it, keeping it would mean a queue that never drains.

Idempotency rules, which are the difference between a converging vault and a
silently diverging one:

- **A record enqueue supersedes.** Delete every existing row for
  `(item_type, item_id)` with `op != 'crdt-update'` before inserting. The payload is
  the whole item, so an older row says nothing new, and a row sitting in backoff is
  otherwise invisible to a per-id collapse and later re-pushes a stale payload
  (`apps/mobile/src/sync/outbox.ts:84`).
- **A CRDT enqueue never coalesces.** A merged update cannot be re-sent individually
  if the batch is rejected (`apps/mobile/src/sync/outbox.ts:98-109`).
- **Ack is delete, per id, and only for ids the server accepted.** The push response
  is per item id (`packages/contracts/src/sync-api.ts:392-402`), so before sending, a
  wave of **record** rows must collapse to one push item per id using the newest row:
  two rows sharing an id cannot be told apart in a mixed accept and reject response
  (`apps/mobile/src/sync/outbox.ts:582-597`). The collapse is scoped to
  `op != 'crdt-update'` and never applies to CRDT rows, which would lose updates. A
  CRDT row is acked against the sequence the server assigned to that specific update,
  one ack per row, which is what lets many rows for the same document ride one wave.
- **Ordering within a pass is CRDT rows first, grouped by document, then record
  rows**, so a body edit can never land after its own note's delete
  (`apps/mobile/src/sync/outbox.ts:399-430`).
- **Read-only mode parks; it never drains and never fails.** A `403
PLATFORM_WRITES_DISABLED` or `426 CLIENT_UPGRADE_REQUIRED` stops the pass without
  incrementing `attempt_count`, so no backoff accrues against a condition the user
  cannot fix (`apps/mobile/src/sync/outbox.ts:259`, `:706-733`).
- **Two rows retire forever rather than retrying**: a row whose payload cannot be
  parsed, and a row rejected as too large. Both are acked locally with a recorded
  reason (`apps/mobile/src/sync/outbox.ts:607-616`, `:640-646`).

**`sync_cursors`**. Pull position per scope. Source of record.

| Column       | Type             | Notes                                                                              |
| ------------ | ---------------- | ---------------------------------------------------------------------------------- |
| `scope`      | TEXT PRIMARY KEY | `record` for the global record cursor; `crdt:<docId>` for a per-document watermark |
| `cursor`     | TEXT             | decimal string of the server cursor, or the CRDT `sequence_num`                    |
| `revision`   | TEXT             | the server snapshot revision for a `crdt:` scope                                   |
| `updated_at` | INTEGER NOT NULL |                                                                                    |

The record cursor advances only after the page's items have been applied and
committed (`packages/sync-client/src/pull/engine.ts:24-27`). A CRDT watermark
advances per update, not per page, and stops at an update whose signer cannot be
resolved (`packages/sync-client/src/pull/crdt-pull.ts:225-250`).

**`attachments`**. Lazy download state for inline images. Source of record for the
policy, not for the bytes.

| Column           | Type                       | Notes                                        |
| ---------------- | -------------------------- | -------------------------------------------- |
| `attachment_id`  | TEXT PRIMARY KEY           |                                              |
| `manifest`       | TEXT                       | the decrypted manifest JSON verbatim         |
| `note_refs`      | TEXT                       | JSON array of note ids referencing it        |
| `remote_size`    | INTEGER                    | ciphertext size                              |
| `local_path`     | TEXT                       | relative to `images/`, NULL until downloaded |
| `downloaded_at`  | INTEGER                    |                                              |
| `unmetered_only` | INTEGER NOT NULL DEFAULT 1 | FR-045's default                             |
| `pinned`         | INTEGER NOT NULL DEFAULT 0 | exempt from eviction                         |
| `filename`       | TEXT                       |                                              |
| `mime_type`      | TEXT                       |                                              |

Bytes live in `images/` as sandbox files under the same file protection class, never
as blobs. Eviction removes files and clears `local_path`; it never removes rows, and
never touches a pinned row.

**`local_notifications`**. Reminder scheduling bookkeeping. Source of record,
device-local, never synced.

| Column          | Type             | Notes                                                    |
| --------------- | ---------------- | -------------------------------------------------------- |
| `reminder_id`   | TEXT PRIMARY KEY |                                                          |
| `target_type`   | TEXT NOT NULL    |                                                          |
| `target_id`     | TEXT NOT NULL    |                                                          |
| `fire_at`       | INTEGER NOT NULL |                                                          |
| `os_request_id` | TEXT             | the platform's identifier for the scheduled notification |
| `scheduled_at`  | INTEGER          | NULL means not currently inside the scheduling window    |

This table exists because the platform caps how many notifications may be pending at
once (FR-062), so the core schedules a nearest window and refills it. It also exists
so a notification for an item completed elsewhere can be reconciled instead of
firing as a ghost. `triggeredAt` is deliberately **not** a synced field: each device
shows its own notification, so a synced value would suppress it on a device that
never displayed it (`packages/contracts/src/sync-payloads.ts:146-153`). Dismiss and
snooze state does sync, and lives in the `reminders` projection.

**`note_bodies`**. Extracted plain text plus the create-time seed. See A.3.

| Column            | Type             | Notes                                                                                                                                                                                                                                                                                                        |
| ----------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `note_id`         | TEXT PRIMARY KEY | note id or journal id                                                                                                                                                                                                                                                                                        |
| `text`            | TEXT NOT NULL    | output of `extract_text(doc)`: a plain-text walk of the `prosemirror` `XmlFragment` that keeps headings and list markers and makes no markdown-fidelity claim. Feeds FTS `content` and previews. Fully rebuildable from the Yjs log                                                                          |
| `seed_markdown`   | TEXT             | the create-time `content` payload, from note creation or template application, held **verbatim** and **never interpreted by the core**, handed to the WebView by `seed-from-markdown` and cleared after the first document update lands; recorded as a Complexity Tracking exception in [plan.md](./plan.md) |
| `text_sha256`     | TEXT NOT NULL    | of the exact bytes in `text`, so a rebuild that changes the extraction is visible                                                                                                                                                                                                                            |
| `source_seq`      | INTEGER          | the combined log position this text was extracted from                                                                                                                                                                                                                                                       |
| `materialised_at` | INTEGER NOT NULL |                                                                                                                                                                                                                                                                                                              |

**The local counter is taken over the updates and the snapshot together**, as
`MAX` of `yjs_updates.seq` and `yjs_snapshots.last_seq` for the namespace, not
over `yjs_updates` alone. A fold deletes the rows it absorbed and records their
high-water mark on the snapshot row, so an updates-only maximum walks backwards
the moment a compaction lands and re-issues a sequence that was already used.
This is the same union the read rule already requires — "a read of updates since
N must also consult the snapshot row" — applied to the write side, where it was
previously left implicit.

### A.3 Why `note_bodies` is its own category

**The core never serialises or parses BlockNote markdown.** Both directions run
inside the WebView bundle, which already owns them: `export-markdown` for
document to markdown, and a new `seed-from-markdown` for markdown to document,
used on note creation and template application. The Rust core's only text-shaped
operation on a body is `extract_text(doc)`, a plain-text walk over the
`prosemirror` `XmlFragment` that keeps headings and list markers, drops everything
else, and claims no markdown fidelity at all. See the Decision Record Fidelity table
in [plan.md](./plan.md).

That is what makes this table small. The Yjs log stays authoritative for merging and
for bytes; `note_bodies.text` is a search and preview projection, nothing more, and
losing it costs a rebuild rather than a body.

FR-041's byte identity still holds, structurally: the phone never writes vault files,
so desktop remains the only writer of markdown on disk and the `markdownSource` Y.Map
root still carries the author's original bytes untouched when the canonical form has
not changed (`packages/shared/src/markdown-source.ts:68`, `:142`).

So the rules are:

- `text` is rebuildable at any time and a rebuild that changes `text_sha256` without a
  corresponding document change is a defect the core can detect by comparing before it
  writes. `source_seq` exists so a rebuild can be skipped when nothing moved.

  **`source_seq` is the sum of the two update-log namespaces' high-water sequence
  numbers** for that document — the remote `<id>` space and the local `local.<id>`
  space of chapter 07. The sum rather than a maximum, because the two spaces advance
  independently: a single maximum sits still while the lower half advances, and a
  rebuild skipped on a stalled watermark is a note whose search text silently stops
  tracking its content. Each half is non-decreasing, so the sum moves whenever either
  does.

- **The search index pass is what materialises `text`.** No other component writes it:
  the core has no markdown, so `extract_text(doc)` is the only producer, and the only
  place that walks every document is the incremental index maintenance of FR-053. It
  writes `text`, `text_sha256`, `source_seq` and `materialised_at` together and leaves
  `seed_markdown` alone. This is written down because "rebuildable" says when it may be
  thrown away and never said who builds it, and a projection with no owner is one that
  is simply never populated.
- `seed_markdown` is written once at creation, held verbatim, and is the only copy of
  the user's requested content until the WebView has seeded the document. It is
  cleared after the first update from that seeding commits. A phone that creates a
  note from a template and is killed before the WebView ever opens must still have the
  template's content on next launch, and this column is why.

### A.4 `data.db`, typed projections

All rebuildable from `sync_items.payload`. Columns are the payload's field names in
snake case, so a reader can move between this table and
`packages/contracts/src/sync-payloads.ts` without a mapping document.

Every projection table carries three columns not listed per table below:
`clock` TEXT (JSON), `synced_at` INTEGER, and `deleted_at` INTEGER. The tables that
merge field by field additionally carry `field_clocks` TEXT.

The rule covers the tables that project one sync item to one row. It does not
cover a **side table**, meaning a table that holds the repeated or per-path part
of an item whose own row already carries the three columns. `settings_field_clocks`
is the only side table in this section: it is keyed by dotted path, its `clock`
column is the per-path clock the table exists for rather than the item clock, and
a second `clock` column is not expressible. A side table carries exactly the
columns listed for it below and nothing implied by this paragraph; sync state for
the item it belongs to is read from that item's own projection row.

**No indexes are specified for the projection tables**, and the baseline
migrations create none. `sync_items` and `outbox` in §A.2 are the only tables whose
index coverage this document fixes, because their access pattern is the protocol's
rather than a query's. A projection index is additive, arrives in a later
migration, and is justified by a measured query — not guessed at the schema's
first write.

**`folders`**. From `folder_config`. Item id is the folder path.

`path` TEXT PRIMARY KEY, `parent_path` TEXT, `name` TEXT NOT NULL,
`icon` TEXT, `position` INTEGER, `created_at` INTEGER, `modified_at` INTEGER.

`parent_path` and `name` are derived from `path`, kept as columns so the tree query
does not string-split on every row.

**`notes`**. From `note`.

`id` TEXT PRIMARY KEY, `title` TEXT NOT NULL, `folder_path` TEXT,
`emoji` TEXT, `file_type` TEXT NOT NULL DEFAULT `'markdown'`, `mime_type` TEXT,
`attachment_id` TEXT, `attachment_references` TEXT (JSON array),
`aliases` TEXT (JSON array), `properties` TEXT (JSON object of values only),
`created_at` INTEGER, `modified_at` INTEGER.

`content` is deliberately absent: the body lives in `note_bodies` and the CRDT log,
and a record push for an update carries `content: null`
(`packages/sync-client/src/pull/crdt-pull.ts:9-11`).

**`journal_entries`**. From `journal`. One row per calendar day (FR-054). The shape
below assumes the journal body is a CRDT document and this row carries metadata only;
that assumption is **pending G1 ratification of Q07.1**.

`id` TEXT PRIMARY KEY (the `j<date>` id), `date` TEXT NOT NULL UNIQUE,
`properties` TEXT, `created_at` INTEGER, `modified_at` INTEGER.

The UNIQUE on `date` is what makes "never a duplicate for the same day" structural
rather than a check in the domain layer.

**`note_tags`**. From the `tags` array on `note` and `journal`.

`note_id` TEXT NOT NULL, `tag` TEXT NOT NULL COLLATE NOCASE, `position` INTEGER
NOT NULL DEFAULT 0, `pinned_at` INTEGER. Primary key `(note_id, tag)`.

`COLLATE NOCASE` is what FR-047's "letter-case behaviour identical to desktop" means
in practice; desktop uses the same collation
(`packages/db-schema/src/schema/notes-cache.ts:53`).

`pinned_at` has **no source instant in the payload**: `pinnedTags` carries
membership, not a time. The projector records the instant it applied the row,
and that is the column's whole meaning — a local ordering hint for the pinned
list, never a synced value and never compared across devices. Two devices will
hold different `pinned_at` values for the same pinned tag, and that is correct,
not drift.

**`tag_definitions`**. From `tag_definition`. Item id is the tag name.

`name` TEXT PRIMARY KEY COLLATE NOCASE, `color` TEXT NOT NULL,
`color_authored` INTEGER NOT NULL DEFAULT 0, `icon` TEXT, `category_id` TEXT,
`sort_order` INTEGER NOT NULL DEFAULT 0, `views` TEXT, `created_at` INTEGER.

`color_authored` holds two states where the payload has three. Chapter 13
§13.7.7 says an **absent** `colorAuthored` means "cannot tell, honour the
colour", which is behaviourally identical to `true` and behaviourally different
from `false`. The projection therefore maps **absent to 1**, collapsing absent
and true into the same column value on purpose: the column exists to answer
"may the palette overwrite this colour", and for both of those the answer is no.
The absent-versus-true distinction is not lost from the vault — it survives
verbatim in `sync_items.payload`, which is the source of record — only from the
projection, which is rebuildable and answers a narrower question.

`color_authored` is load bearing: `false` means the palette handed the colour out by
local tag count, so it disagrees across devices and must not repaint another
device's tag. Absent means "cannot tell" and the receiver honours the colour
(`packages/contracts/src/sync-payloads.ts:293-296`).

**`tag_categories`**. From `tag_category`.

`id` TEXT PRIMARY KEY, `name` TEXT NOT NULL, `sort_order` INTEGER NOT NULL DEFAULT 0,
`created_at` INTEGER, `updated_at` INTEGER.

**`property_definitions`**. From `property_definition`. Item id is the property
name.

`name` TEXT PRIMARY KEY, `type` TEXT NOT NULL, `options` TEXT,
`default_value` TEXT, `color` TEXT, `created_at` INTEGER.

`options` stays opaque JSON text, exactly as the payload carries it. Re-declaring the
option shape would parse away a newer client's per-option field on a round trip
(`packages/contracts/src/sync-payloads.ts:307-321`).

**`templates`**. From `template`.

`id` TEXT PRIMARY KEY, `name` TEXT NOT NULL, `description` TEXT, `icon` TEXT,
`tags` TEXT (JSON array), `properties` TEXT (JSON array), `content` TEXT NOT NULL
DEFAULT `''`, `created_at` INTEGER, `modified_at` INTEGER.

`properties` must remain an array. A non-array from a differently versioned peer is
stored verbatim in `payload` and would throw at note-creation time, so the projector
validates it and refuses to project rather than crashing later
(`packages/contracts/src/sync-payloads.ts:102-105`).

**`tasks`**. From `task`. Field-merged, so it carries `field_clocks`.

`id` TEXT PRIMARY KEY, `title` TEXT NOT NULL, `description` TEXT,
`project_id` TEXT NOT NULL, `status_id` TEXT, `parent_id` TEXT,
`priority` INTEGER NOT NULL DEFAULT 0, `position` INTEGER NOT NULL DEFAULT 0,
`due_date` TEXT, `due_time` TEXT, `start_date` TEXT, `repeat_config` TEXT,
`repeat_from` TEXT, `source_note_id` TEXT, `completed_at` TEXT, `archived_at` TEXT,
`tags` TEXT (JSON array), `linked_note_ids` TEXT (JSON array),
`created_at` INTEGER, `modified_at` INTEGER.

The date columns stay TEXT because they are date-only or wall-clock values on the
wire, not instants, and converting them to epoch integers would invent a timezone.
See A.6.

The 15 field names that participate in field merge, in order, are
`TASK_SYNCABLE_FIELDS` (`packages/sync-client/src/field-merge.ts:11-27`). A field
outside that list is not merged at all.

**`projects`**. From `project`. Read and assign only in this feature (FR-060), but
projected fully so the read surface is complete. Field-merged.

`id` TEXT PRIMARY KEY, `name` TEXT NOT NULL, `description` TEXT,
`color` TEXT NOT NULL, `icon` TEXT, `position` INTEGER NOT NULL DEFAULT 0,
`is_inbox` INTEGER NOT NULL DEFAULT 0, `archived_at` TEXT, `home_note_id` TEXT,
`created_at` INTEGER, `modified_at` INTEGER.

The 9 merged field names are `PROJECT_SYNCABLE_FIELDS`
(`packages/sync-client/src/field-merge.ts:29-39`).

**`project_statuses`**. From the nested `statuses` array on `project`.

`id` TEXT PRIMARY KEY, `project_id` TEXT NOT NULL, `name` TEXT NOT NULL,
`color` TEXT NOT NULL, `position` INTEGER NOT NULL, `is_default` INTEGER,
`is_done` INTEGER, `created_at` INTEGER.

**`project_links`**. From the nested `links` array on `project`.

`id` TEXT PRIMARY KEY, `project_id` TEXT, `item_type` TEXT NOT NULL,
`item_id` TEXT NOT NULL, `position` INTEGER NOT NULL, `pinned` INTEGER,
`created_at` INTEGER.

**`task_activity`**. From `task_activity`. Append only and immutable, so it has no
`field_clocks` and no `modified_at` (`packages/contracts/src/sync-payloads.ts:77-84`).

`id` TEXT PRIMARY KEY, `task_id` TEXT NOT NULL, `action` TEXT NOT NULL,
`field` TEXT, `old_value` TEXT, `new_value` TEXT, `actor` TEXT,
`device_id` TEXT, `created_at` INTEGER.

`old_value` and `new_value` are JSON-encoded scalars and are always NULL for the
`description` field, because the body is note-sized and is never duplicated here.

**`reminders`**. From `reminder`.

`id` TEXT PRIMARY KEY, `target_type` TEXT NOT NULL, `target_id` TEXT NOT NULL,
`remind_at` TEXT NOT NULL, `anchor_id` TEXT, `highlight_text` TEXT,
`highlight_start` INTEGER, `highlight_end` INTEGER, `title` TEXT, `note` TEXT,
`status` TEXT NOT NULL DEFAULT `'pending'`, `dismissed_at` TEXT,
`snoozed_until` TEXT, `created_at` INTEGER, `modified_at` INTEGER.

No `triggered_at`. See `local_notifications`.

**`settings`** and **`settings_field_clocks`**. From `settings`, which is one sync
item with the fixed id `synced_settings`
(`packages/sync-client/src/settings-sync.ts:195-196`).

`settings`: `group` TEXT NOT NULL, `key` TEXT NOT NULL, `value` TEXT,
primary key `(group, key)`.

`settings_field_clocks`: `path` TEXT PRIMARY KEY (a dotted path such as
`general.theme` or `journal.weekdayTemplates.3`), `clock` TEXT NOT NULL.

Both are projections. The verbatim settings payload in `sync_items.payload` is what
preserves a group this core does not model, which is how a preference with no phone
equivalent survives a round trip (FR-063, and the merge-not-replace rule in
`specs/001-mobile-app/data-model.md:164-167`).

**The core parses settings as raw JSON and merges changed dotted paths into the
parsed copy. It never passes settings through a closed schema.** A typed struct with
named fields is the one shape that cannot work here: deserialising into it and
re-serialising drops every group and key this build does not know about, which is
exactly the data FR-063 requires to survive. The projection above is a flattened
index for reading; the write path touches only the paths the user changed.

**A NOT NULL projection column does not mean a required payload field.** Several
columns here are NOT NULL for fields chapter 13 §13.7 marks optional —
`notes.title`, `tasks.project_id`, `projects.color`, `reminders.remind_at`,
`templates.name` among them. The projector substitutes the column's empty or
zero default when the key is absent and **never refuses the item**, because
§13.3's forward tolerance says an older client must keep applying what a newer
one writes. The NOT NULL is there so a query never has to handle a null, not to
assert the wire guarantees a value. The payload remains the source of record and
still distinguishes absent from empty; the projection does not, and does not
need to.

### A.4.1 Task-view membership, and which desktop it means

FR-057 asks for "the same membership semantics as desktop". **Desktop has more
than one answer**, so this section names the one every port reproduces. That the
answers differ is recorded as a defect against desktop rather than resolved
here; a port needs one rule, and needs it written down.

The rules below are desktop's **renderer view helpers**
(`apps/desktop/src/renderer/src/lib/task-utils/task-view-helpers.ts`) — the code
behind the sidebar's task views, which is the surface FR-057 is about. Desktop's
main-process SQL (`apps/desktop/src/main/database/queries/tasks.ts`) answers
differently and feeds IPC and agent consumers rather than the views.

**Normative for a port:**

- Every view starts from **live, non-archived** tasks. An `archived_at` and a
  tombstone are both out of every view, always.
- **Completion is the task's status, not `completedAt`.** A task is complete iff
  its `status_id` resolves, **within its own project**, to a `project_statuses`
  row with `is_done`. **An unresolvable status counts as incomplete** — a task
  whose project has not been pulled yet must still appear in the open views
  rather than vanish, which is the substitute-never-refuse rule of §A.4 applied
  to a view.
- **Subtasks ride along with their parent.** `today`, `upcoming` and `completed`
  match **top-level** tasks only, then re-admit every live subtask whose parent
  matched, regardless of the subtask's own status or dates. `by-project` is the
  exception: there a subtask is a first-class member.
- **`today`** is overdue-or-due-today plus started-and-not-finished, and
  **`upcoming`** is strictly tomorrow through today + 7. The window constant is
  7 days.
- **Order is `position`**, ties broken on `id` so two devices with equal
  positions still agree.

**The caller supplies today's date as `YYYY-MM-DD`; this tier does not derive
it.** A calendar day is a fact about the user's time zone and the core has no
access to one — deriving it from an instant files an evening task under tomorrow
for half the planet. Comparison is lexicographic over the first ten characters,
which is chronological because the wire carries date-only values (§A.6), and
truncating to ten is what makes a peer that wrote a full timestamp into `dueDate`
compare as the day it names rather than as strictly greater.

**A row that will not read is an error, not an omission.** FR-032 says a reader
must never report "none" for "could not tell"; a view is the same case with
worse consequences, because a task silently dropped from every view is a task the
user is told does not exist.

### A.5 `index.db`

Everything here is derived from `data.db` and the whole file may be deleted and
rebuilt.

**FTS5 virtual tables**, matching desktop's tokenizer exactly. The `content` column
is fed by `extract_text(doc)` (A.3), not by markdown, because the core has no
markdown:

| Table       | Columns                                        | Tokenizer          |
| ----------- | ---------------------------------------------- | ------------------ |
| `fts_notes` | `id UNINDEXED`, `title`, `content`, `tags`     | `porter unicode61` |
| `fts_tasks` | `id UNINDEXED`, `title`, `description`, `tags` | `porter unicode61` |

Sources: `apps/desktop/src/main/database/fts.ts:26-33` and
`apps/desktop/src/main/database/fts-tasks.ts:16-24`. Journals are indexed in
`fts_notes` alongside notes, distinguished by a `date` on the projection row, which
is what desktop does (`apps/desktop/src/main/database/queries/search.ts:184-192`).
`fts_inbox` is not created: inbox is out of scope for this feature.

**Ranking weights are part of the contract, not a tuning knob.** Desktop ranks with
`bm25(fts_notes, 0.0, 2.0, 1.0, 1.0)` and `bm25(fts_tasks, 0.0, 2.0, 1.0, 1.0)`
(`apps/desktop/src/main/database/queries/search.ts:124`, `:221`). A different weight
vector produces a different order for the same query and corpus and fails FR-053.

**What FR-053 parity actually claims.** Both shells run the same ranking function:
the same tokenizer and the same bm25 weight vector, over each client's own extracted
text. Desktop indexes markdown; the phone indexes `extract_text(doc)` output. Those
two strings are not the same bytes, so identical result ordering is a testable claim
only for a corpus where the extracted text matches on both sides. Where it does not,
the contract is the ranking function, not the ordering.

**Notes and tasks are ranked separately and MUST NOT be merged into one list.** A
bm25 score is relative to the table it was computed over — its IDF terms come from
that table's corpus statistics — so a note's score and a task's score are not
comparable numbers and interleaving them by score produces an order that means
nothing. A search returns two ranked lists, and any single list a UI shows is a
presentation decision made above this tier with its own stated rule, not a ranking
claim.

**A journal's `fts_notes.title`.** Journals are indexed in `fts_notes`, whose second
column is `title`, and the `journal_entries` projection in §A.4 has no `title` column
— so the indexer has nowhere obvious to read one. It reads the title from
`sync_items.payload`, which is where §13.7.2 says a journal's `title` lives, and
**falls back to the `date` when the key is absent**. Absent is the normal case:
§13.7.2 states a newly created day carries no `title` at all, so a fallback is the
common path rather than an error path, and a journal indexed with an empty title
would be unfindable by name for every day the user never titled.

**Link and graph projections:**

`note_links`: `source_id` TEXT NOT NULL, `target_id` TEXT, `target_title` TEXT NOT
NULL, primary key `(source_id, target_title)`. `target_id` is NULL for a wiki-link
whose target does not exist yet, which is how a forward reference survives.

`note_properties`: `note_id` TEXT NOT NULL, `name` TEXT NOT NULL, `value` TEXT,
`type` TEXT NOT NULL, primary key `(note_id, name)`. Denormalised from
`notes.properties` so a property query is an index seek.

`index_meta`: `key` TEXT PRIMARY KEY, `value` TEXT. Holds the `data.db`
`user_version` the index was built against and a per-table watermark, so an
incremental reindex is possible and a full rebuild is only needed when the watermark
is missing.

**`sync_items.updated_at` MUST NOT be the watermark column.** It carries the
_server's_ instant for a pulled record, so it is not monotone in this device's clock:
pulling a record the server stamped earlier than the last index pass lands it below
the watermark, where it is never indexed and the note is simply not findable. The
columns compared are the ones this device's own clock writes — the projection's
`synced_at`, `yjs_updates.created_at`, `yjs_snapshots.compacted_at`. The comparison is
`>=` rather than `>`, so a row written inside the watermark's own millisecond is
re-indexed rather than missed; re-indexing is idempotent and missing is not.

**One FTS5 operational note carried over from the mobile baseline**: on that stack,
closing a connection while an FTS5 virtual table is attached segfaults, and the code
defensively drops FTS tables before close
(`apps/mobile/src/db/index.ts:93-105`, `:22-25`). That is a bug in a particular
JavaScript SQLite binding, not in SQLite, and it should not constrain a `rusqlite`
implementation. It is recorded here so nobody copies the workaround without knowing
why it existed.

### A.6 Timestamp representation

The two existing implementations disagree. Desktop stores TEXT ISO-8601 via
`strftime('%Y-%m-%dT%H:%M:%fZ','now')`; the mobile baseline stores INTEGER epoch
milliseconds. The wire mostly carries ISO-8601 strings, and
`SyncTimestampSchema` accepts a number and normalises it to an ISO string
(`packages/contracts/src/sync-payloads.ts:21-23`).

The decision for this core:

| Kind                                                                                                                                | Storage                                    | Reason                                                                                                                               |
| ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| Instants the core orders by (`updated_at`, `created_at`, `modified_at`, `enqueued_at`, `fire_at`)                                   | INTEGER epoch milliseconds                 | integer comparison, no collation surprises, no parse per row                                                                         |
| Wire-shaped date and time values (`due_date`, `due_time`, `start_date`, `remind_at`, `completed_at`, `archived_at`, journal `date`) | TEXT, exactly as the payload carries them  | these are date-only or wall-clock values, not instants; converting them invents a timezone and breaks "today" across a date boundary |
| Everything, always                                                                                                                  | preserved verbatim in `sync_items.payload` | the projection's representation is never what gets pushed back                                                                       |

The last row is what makes the first two safe. A projection that normalises a
timestamp cannot corrupt the wire value, because the wire value is not read from the
projection.

---

## B. Secure store entries

Key material lives only in the platform secure store, reached through the
`SecureStore` seam, and crosses the FFI as bytes, never as a readable string
(constitution, Mobile Platform Constraints; FR-023).

Entry names are the five in `KEYCHAIN_ENTRIES`
(`packages/contracts/src/crypto.ts:70-76`), unchanged, so a future tool can read a
desktop and a phone with the same vocabulary:

| Entry                | Service          | Account              | Contents                    | Scope                   |
| -------------------- | ---------------- | -------------------- | --------------------------- | ----------------------- |
| `MASTER_KEY`         | `com.memry.sync` | `master-key`         | 32 raw bytes                | per account             |
| `DEVICE_SIGNING_KEY` | `com.memry.sync` | `device-signing-key` | 64 byte Ed25519 secret key  | per device              |
| `ACCESS_TOKEN`       | `com.memry.sync` | `access-token`       | JWT as UTF-8 bytes          | per session             |
| `REFRESH_TOKEN`      | `com.memry.sync` | `refresh-token`      | opaque token as UTF-8 bytes | per session             |
| `SETUP_TOKEN`        | `com.memry.sync` | `setup-token`        | JWT as UTF-8 bytes          | transient, five minutes |

`MASTER_KEY` is **one entry per account**, which is only correct if every vault on
that account derives its vault key from that one master key. That is Q01.4 and it
must be answered at G1. If the answer is no, this table grows a per-vault entry and
the unlock machine in C.2 grows a state.

Storage attributes, per [plan.md](./plan.md), Technical Context, Storage: the
data-protection keychain, accessibility `AfterFirstUnlockThisDeviceOnly`,
non-synchronizable, values stored as raw bytes rather than base64 strings.

`AfterFirstUnlockThisDeviceOnly` rather than `WhenUnlockedThisDeviceOnly` because a
background refresh task must be able to reach the signing key to complete a sync, and
`ThisDeviceOnly` because a key that rides an iCloud keychain backup to a second
device breaks the device-scoped signing model and would survive a device restore that
FR-023 says must not carry key material.

**Not in the secure store, deliberately:**

| Value                                       | Where it lives                                          | Why                                                                                                                                                                  |
| ------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the vault key                               | memory only, derived on unlock from the master key      | it is a pure function of the master key and a fixed context (`apps/desktop/src/main/crypto/keys.ts:123-137`), so persisting it would double the exposure for no gain |
| per-item file keys                          | memory only, zeroed after use                           |                                                                                                                                                                      |
| the linking encryption, MAC and SAS subkeys | memory only, for the life of one linking session        |                                                                                                                                                                      |
| the local vault key verifier                | `meta` under `vault.crypto.verifier.v1`                 | it is a verifier, not a key                                                                                                                                          |
| `kdfSalt` and the account key verifier      | `meta`, and re-fetchable from `GET /auth/recovery-info` | both are server-held already                                                                                                                                         |

**Sign-out** (FR-025) deletes all five entries, deletes both database files and the
`images/` directory, and zeroes every in-memory key. **Revocation detected on next
contact** (FR-026) does the same and additionally records why, so the locked screen
can explain itself.

**Secure store unavailable.** If the device passcode is removed, an entry stored
under a protection class that requires one becomes unretrievable. The core must treat
a retrieval failure as "locked", not as "absent", and must not silently re-derive or
re-create. That is the difference between asking the user to unlock again and
overwriting a working vault with a new key.

---

## C. Core state machines

Four machines. Each is exposed to the shell as a value the shell renders; the shell
computes none of them (FR-037).

### C.1 Authentication and session

```text
SignedOut
  -> AwaitingOtp            request a code
  -> AwaitingProviderToken  Google or Apple, shell holds the native sheet
AwaitingOtp / AwaitingProviderToken
  -> SetupPending           server returned a setup token; no device yet
  -> SignedOut              cancelled, expired, or rejected
SetupPending
  -> Registered             device registered, access and refresh tokens held
  -> SetupExpired           setup token aged out
SetupExpired
  -> SetupPending           renewed by proof of the committed device key
  -> SignedOut              not renewable, or renewal window spent
Registered
  -> Refreshing             proactive, at 50 to 70 percent of token life
  -> SessionExpired         refresh refused
  -> Revoked                server says this device is revoked
  -> SignedOut              user signed out
Refreshing
  -> Registered             new pair stored
  -> SessionExpired         401, after the backoff ladder is spent
SessionExpired
  -> Registered             a later refresh succeeded
  -> SignedOut              user re-authenticates
Revoked  (terminal until the user acts)
  -> SignedOut              local vault content removed, reason shown
```

Rules that belong to the machine rather than to a caller:

- `SetupExpired` is reachable and recoverable only when the client committed a
  `devicePublicKey` at OTP verify or OAuth callback time. Without it the token is a
  single non-renewable five minute grant
  (`packages/contracts/src/auth-api.ts:15`, `:63-72`).
- Refresh is single flighted. Concurrent callers share one in-flight attempt.
- Three consecutive 401s on refresh block refresh permanently for the session and
  emit `SessionExpired`; the first two back off 60 and 300 seconds
  (`apps/desktop/src/main/sync/token-manager.ts:34-35`, `:122-150`). This exists
  because a dead token otherwise cost 58 requests in 47 minutes from one install.
- `Revoked` removes local vault content before it is shown, not after.

### C.2 Vault lock

```text
Locked
  -> Unlocking      phrase entered, or a linking session completed
  -> VaultChoice    account holds more than one vault and none is chosen
Unlocking
  -> Unlocked       verifier matched, vault key in memory
  -> Locked         verifier mismatch; nothing written, nothing partially unlocked
Unlocked
  -> Locked         sign-out, revocation, or secure store became unreadable
  -> Migrating      a pending data migration must run before use
  -> VaultChoice    the user switched vaults
Migrating
  -> Unlocked       migration committed
  -> Locked         migration failed; the database is untouched
VaultChoice
  -> Unlocking      a vault was chosen and its key is already derivable
  -> Locked         a vault was chosen and the phrase is needed again
```

Rules:

- `Unlocking` verifies **before** it writes anything. On mismatch the transition back
  to `Locked` leaves no key in the secure store and no file on disk, which is FR-027.
- There are two verifiers and both are checked. The account key verifier proves the
  phrase matches the account; the local vault key verifier proves the derived vault
  key matches the database already on disk
  (`apps/desktop/src/main/crypto/vault-key-state.ts:133-160`). A mismatch on the
  second, with valid credentials for the first, is the "this database belongs to a
  different master key" case and must not silently rebind.
- Switching vaults while writes are queued for the previous vault preserves those
  rows. The outbox is per vault because the database is per vault, so this is
  structural rather than a rule anyone has to remember.
- `Unlocked` is not a claim that sync works. Entitlement and policy are separate,
  see C.3.

### C.3 Sync engine

```text
Idle
  -> Pulling            timer, foreground, socket hint, or explicit request
  -> Pushing            outbox non-empty and policy allows writes
  -> Offline            reachability says no
  -> ReadOnly           policy says writes are disabled for this platform
  -> BlockedUpgrade     policy says this version is below the write floor
  -> Unentitled         account has no active plan
Pulling
  -> Applying           a page arrived
  -> Idle               caught up
  -> Offline / Failed   transport
Applying
  -> Pulling            more pages
  -> Idle               done, cursor committed
  -> Refused            the page breaker tripped
Pushing
  -> Idle               wave drained or iteration cap reached
  -> ReadOnly           403 PLATFORM_WRITES_DISABLED mid-wave
  -> BlockedUpgrade     426 CLIENT_UPGRADE_REQUIRED mid-wave
  -> Unentitled         402 SYNC_PAYMENT_REQUIRED mid-wave
  -> Failed             transport or server error after the batch-halving ladder
ReadOnly / BlockedUpgrade / Unentitled
  -> Pulling            reads continue, always
  -> Idle               reads continue; or the block cleared (see below)
Offline
  -> Idle               reachability returned
Failed
  -> Idle               after backoff
Refused
  -> Idle               run marked unsuccessful; no success state written
```

Rules:

- **The three write-blocked states do not clear the same way**, and chapter 11
  §11.7.1 is the authority. `ReadOnly` and `BlockedUpgrade` are polled facts on
  `clientPolicy` and clear on the next status poll. `Unentitled` is not: it is
  reached reactively on a `402 SYNC_PAYMENT_REQUIRED`, `clientPolicy` carries no
  entitlement field, and a parked outbox attempts no write that could earn a 2xx
  — so the sync tier cannot recover on its own and must not invent a probe
  write. The `Unentitled -> Idle` edge above is the **account tier** telling the
  sync tier the plan is active again, after a purchase or a billing refresh.
- **Reads are never gated.** `ReadOnly`, `BlockedUpgrade` and `Unentitled` all keep
  pulling. The server does not gate `GET`, `HEAD` or `OPTIONS` either
  (`apps/sync-server/src/middleware/client-gate.ts:9-13`), so this is the client
  agreeing with the server rather than compensating for it.
- **The three blocked states are distinct and must not be collapsed.** They have
  different explanations and different exits: a kill switch clears server side, an
  upgrade needs an App Store update, and an entitlement needs a plan. FR-075 requires
  the same vocabulary as desktop for each.
- **A blocked state parks the outbox.** No attempt, no backoff, no row removed.
- **Policy is learned without attempting a write**, from `clientPolicy` on
  `GET /sync/status` (`packages/contracts/src/sync-api.ts:266-287`). The engine polls
  it on foreground and on interval, so a flipped switch takes effect without a
  restart, which is what FR-070's beta gate exercises. **The interval timer is
  suspended while the app is backgrounded** and resumes on foreground, so this is not
  a background polling loop; a background refresh task polls status once as part of
  its own run instead.
- **The push wave halves on a 5xx** rather than resending: `PUSH_BATCH_SIZE` 100 down
  to `MIN_PUSH_BATCH_SIZE` 1, at most `MAX_PUSH_ITERATIONS` 50 iterations, with the
  reduced size held as a ceiling for the rest of the run
  (`apps/desktop/src/main/sync/engine/sync-context.ts:126-132`,
  `engine/push-coordinator.ts:242-263`).
- **`Refused` is not `Failed`.** The page breaker advances the cursor past a page
  that yielded nothing but corruption, so a retry cannot loop forever, and marks the
  run unsuccessful so no success state is written
  (`packages/sync-client/src/pull/engine.ts:364-373`).
- **Every pass is serialised.** Two concurrent passes race the cursor; the mobile
  implementation had to add an exclusive queue after a wedge that left 83 items stuck
  (`apps/mobile/src/sync/engine.ts:69-83`).
- First sync is a distinct sub-sequence, not a state: refs to the end, then metadata
  newest first, then bodies for the recent window, with determinate progress
  (`apps/mobile/src/sync/first-sync.ts:20-31`). App open is never blocked on any of
  it (FR-028).

### C.4 Document lifecycle

```text
Closed
  -> Loading        a surface asked for the document
Loading
  -> Open           both namespaces replayed
  -> Unreadable     the log cannot be replayed
Open
  -> Replicated     an editor surface attached and received the state
  -> Closing        last holder released, grace period started
Replicated
  -> Open           the editor surface detached
  -> Closing        last holder released
Closing
  -> Open           a new holder arrived inside the grace period
  -> Closed         grace period elapsed, evicted
Unreadable          (terminal for this document until the app restarts)
  -> Closed         released; the note remains readable from note_bodies
```

Rules:

- **The core owns the document; the editor holds a replica and persists nothing.**
  That is a constitution rule, and it is what makes `Replicated` a distinct state
  worth naming: in it, two parties hold state and exactly one of them may write to
  disk.
- **Durable before acknowledged.** An update from the editor is appended to
  `yjs_updates` and enqueued in `outbox` in **one** transaction, and the in-memory
  document is advanced only after that transaction commits
  (`apps/mobile/src/editor/doc-manager.ts:358-366`, `:437-459`). This is FR-030 and
  it is what makes the "process dies between a batch of keystrokes and the local
  commit" edge case resolve to "present or never acknowledged", never half applied.
- **Local compaction folds at a sequence read inside the transaction**, not at a
  count passed in. Using a count as a sequence prunes nothing after the first fold
  (`apps/mobile/src/editor/session.ts:104-129`).
- **`Unreadable` is sticky, and the diagram's `-> Closed` edge does not clear it.**
  The two annotations are not in conflict once the scope of each is named: the
  edge is about the document's _residency_, so a document nobody holds is evicted
  from memory like any other, while "terminal until the app restarts" is about the
  _verdict_, which survives that eviction. A later `request` for the same id
  therefore still walks `Closed -> Loading -> Unreadable` — the drawn edges, in
  order — but reaches `Unreadable` from the remembered verdict without asking
  anyone to replay a log that already failed. The verdict is in-memory only: a
  relaunch re-attempts the replay, which is what "until the app restarts" means.
- **`Unreadable` is a first-class state, not an error return.** FR-043 requires the
  app to refuse to open a body for editing when the loaded bundle cannot build every
  node type in the document, to say so, to keep reading available, and to remove no
  node. Reading stays available because `note_bodies` is a separate table that does
  not need the document.
- Open documents are bounded. An LRU with a grace period for a document whose holder
  released it, so a fast navigate-away-and-back does not pay a reload
  (`apps/mobile/src/editor/doc-manager.ts:170-182`, `:237-280`). Memory is a budget
  (constitution, Principle V).

---

## D. Cross-shell invariants

Restated so they can be checked, not just believed.

**D.1 Byte identity of markdown.** A body read and written back without an edit is
byte identical, including frontmatter, key order, quoting, line endings and a byte
order mark. The mechanism is the `markdownSource` Y.Map root returning the author's
bytes untouched when the canonical form has not changed
(`packages/shared/src/markdown-source.ts:68`), plus the frontmatter split that
guarantees `block + body === raw` (`packages/app-core/src/markdown.ts:10-39`), plus
the verbatim re-emission of an unedited frontmatter block (`:86-88`). Checked by
FR-041, by the markdown round-trip corpus, and by SC-010's seven-day digest
comparison. On the phone this holds structurally: the core has no markdown
serialiser and the phone never writes a vault file, so desktop stays the only writer.

**D.2 Unknown fields survive.** `sync_items.payload` is stored verbatim and is what
gets pushed back. Projections are parses of a copy. An item type this core did not
subscribe to is still stored, still tombstoned correctly, and still round-trips.
Checked by SC-014.

**D.3 Unknown item types do not fail a page.** Schema validation is per item, not per
page, and a malformed item is recorded corrupt and skipped without poisoning its
page mates or advancing the cursor past unprocessed work
(`packages/sync-client/src/pull/engine.ts:173-177`, `:364-373`). FR-032.

**D.4 The shell holds no logic.** No merge, no clock, no crypto, no server call. Every
state in section C is a value the core computes and the shell renders. FR-037, and
enforceable by a lint that forbids the platform networking type outside the transport
seam ([plan.md](./plan.md), Constitution Check, principle I).

**D.5 Keys never touch the database, the logs, telemetry, or a backup.** Section B.
FR-023.

**D.6 Nothing is acknowledged before it is durable.** Section C.4. FR-030.

**D.7 The seam list is closed.** Eight foreign traits, per
[plan.md](./plan.md), Project Structure:

1. `SecureStore`
2. `FileProtection`
3. `Notifications`
4. `BackgroundExec`
5. `Reachability`
6. `Transport`, one trait with `send(request)` and `open_socket(...)`, covering both
   HTTP and the realtime socket
7. `EditorHost`, the bridge relay
8. `CodeCapture`, optical code capture

Transport was added during research and is recorded in the constitution at 2.1.0
([plan.md](./plan.md), Constitution Check, post-design re-check). Adding a ninth
requires a written justification in the spec.

**D.8 Cross-shell digest.** SC-010 compares two shells item by item, so the digest
is defined here rather than left to each harness. For a note it is SHA-256 over the
UTF-8 bytes of `title + "\n" + extract_text(doc)`. For a task or a journal record it
is SHA-256 over the canonical JSON of that record's syncable fields. The core side
lives in `crates/memry-core/src/crdt/digest.rs`; the desktop side is
`packages/contracts/scripts/digest.ts`, computing the same values through a
TypeScript `extract_text` port that the `text-extract.json` vector class covers, so
a digest mismatch means the content differs rather than the two extractors differing.

---

## E. Open questions this document cannot close

- **E.1 Closed, not open.** Both directions of markdown conversion belong to the
  WebView bundle, not to the core. Document to markdown is the existing
  `export-markdown` bridge message; markdown to document is a new
  `seed-from-markdown` message used on note creation and template application. The
  core neither serialises nor parses BlockNote markdown, and its only text operation
  on a body is `extract_text(doc)` for FTS and previews. Q12.2 in
  [contracts/protocol-spec-outline.md](./contracts/protocol-spec-outline.md) records
  this decision; it is listed here because the consequences land on A.3 and A.5. No
  piece of markdown handling stays in Rust, frontmatter included: the seed path hands
  the `content` payload to the WebView verbatim and the bundle splits the frontmatter
  block there, so a new note's tags and properties come from the note record payload
  rather than from a Rust parser.
- **E.2** Whether a phone may push a CRDT snapshot, and on what trigger. There is no
  server-side snapshot threshold, so the entire compaction policy is a client
  decision that is written nowhere. Q07.2 in the same document. It affects whether
  `yjs_snapshots` ever carries a server-bound row this core wrote.
- **E.3** Vector clock growth is unbounded: nothing prunes a clock, so a long-lived
  vault accumulates one key per device per item and per field. Q06.6. If a pruning
  rule is ever added, `sync_items.clock` and `field_clocks` change shape.
- **E.4** `task_activity` is append only and unbounded.
  `packages/sync-client/src/task-activity-retention.ts` exists; what retention a
  phone applies, and whether deleting local rows causes them to be re-pulled forever,
  is unresolved. Q13.4.
- **E.5** Whether the record blob's JSON key sort and the signature's CBOR key sort
  are both required of a Rust implementation. They are different sorts over the same
  four fields. Q05.3.
