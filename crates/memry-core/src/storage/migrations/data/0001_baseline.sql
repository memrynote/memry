-- data.db, migration 0001: the source-of-record tables.
--
-- data-model §A.2. Every table here is in the "source of record" class of §A.1:
-- none of it is derived, and losing a row loses user data or duplicates a write.
-- The typed projections, which are rebuildable from `sync_items.payload`, arrive
-- in 0002.
--
-- Timestamp representation follows §A.6: instants the core orders by are INTEGER
-- epoch milliseconds; wire-shaped date and wall-clock values stay TEXT exactly as
-- the payload carries them.
--
-- Migrations are forward only and never drop a column (§A.0), so nothing below
-- may be edited once it has shipped. A change is a new file with a higher number.

-- Key-value scalars.
--
-- Reserved keys: schema.vault_id, schema.account_id, device.id,
-- first_sync.completed, first_sync.window_start, policy.writes_enabled,
-- policy.min_write_version, policy.checked_at, entitlement.active,
-- entitlement.checked_at, vault.crypto.verifier.v1.
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- One row per synced item of every type, including types this client does not
-- model.
--
-- `payload` holds the decrypted payload exactly as received and is never
-- re-serialised: that single rule is the whole of FR-033 (§A.1). A projector
-- parses a copy; the stored string is what gets pushed back.
--
-- `item_type` deliberately carries no CHECK constraint: 25 types exist today and
-- a newer desktop may add more, and a CHECK would turn a forward-compatible item
-- into a write failure.
--
-- The primary key is (item_type, item_id), not item_id alone. Tag definition ids
-- are tag names and folder config ids are folder paths, so an id-only key makes a
-- project and a tag both named `inbox` share one row and corrupt each other's
-- state.
CREATE TABLE IF NOT EXISTS sync_items (
  item_type        TEXT NOT NULL,
  item_id          TEXT NOT NULL,
  payload          TEXT,
  payload_state    TEXT NOT NULL,
  clock            TEXT,
  field_clocks     TEXT,
  server_cursor    INTEGER,
  signer_device_id TEXT,
  updated_at       INTEGER NOT NULL,
  deleted_at       INTEGER,
  corrupt_reason   TEXT,
  corrupt_at       INTEGER,
  PRIMARY KEY (item_type, item_id)
);

CREATE INDEX IF NOT EXISTS sync_items_type_updated_at ON sync_items (item_type, updated_at);

CREATE INDEX IF NOT EXISTS sync_items_deleted_at
  ON sync_items (deleted_at)
  WHERE deleted_at IS NOT NULL;

-- The query the windowed first sync drives: every item still carrying metadata
-- only. Partial, so the index holds exactly the rows that pass remains to fill.
CREATE INDEX IF NOT EXISTS sync_items_payload_state
  ON sync_items (payload_state)
  WHERE payload_state = 'metadata-only';

-- The two-namespace CRDT update log.
--
-- `doc_id` is the bare document id for the server namespace and `local.` followed
-- by the same id for the local namespace. The two sequence spaces must not be
-- shared: a local append taking a sequence a later server row also claims would
-- silently drop one of the two under an upsert.
--
-- `update_blob` is named for the blob because `update` is a reserved word.
--
-- That journal bodies belong here at all is pending G1 ratification of Q07.1.
CREATE TABLE IF NOT EXISTS yjs_updates (
  doc_id      TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  update_blob BLOB NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (doc_id, seq)
);

-- Compacted state per document.
--
-- A read of "updates since N" must also consult this row: a fold deletes the
-- update rows it absorbed, so an updates-only read returns empty for a document
-- that did change.
CREATE TABLE IF NOT EXISTS yjs_snapshots (
  doc_id          TEXT PRIMARY KEY,
  snapshot        BLOB NOT NULL,
  last_seq        INTEGER NOT NULL,
  server_revision TEXT,
  compacted_at    INTEGER NOT NULL
);

-- The durable write queue, and the one table whose loss loses a user's work.
--
-- The autoincrementing id is the ack key and the order a push pass reads in, so
-- this stays a rowid table.
CREATE TABLE IF NOT EXISTS outbox (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  item_type       TEXT NOT NULL,
  item_id         TEXT NOT NULL,
  op              TEXT NOT NULL,
  payload         BLOB,
  enqueued_at     INTEGER NOT NULL,
  attempt_count   INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  next_attempt_at INTEGER
);

CREATE INDEX IF NOT EXISTS outbox_next_attempt_at ON outbox (next_attempt_at);

-- Pull position per scope: `record` for the global record cursor, `crdt:<docId>`
-- for a per-document watermark.
CREATE TABLE IF NOT EXISTS sync_cursors (
  scope      TEXT PRIMARY KEY,
  cursor     TEXT,
  revision   TEXT,
  updated_at INTEGER NOT NULL
);

-- Lazy download state for inline images: source of record for the policy, not for
-- the bytes. Bytes live in `images/` as sandbox files under the same file
-- protection class, never as blobs. Eviction removes files and clears
-- `local_path`; it never removes rows and never touches a pinned row.
CREATE TABLE IF NOT EXISTS attachments (
  attachment_id  TEXT PRIMARY KEY,
  manifest       TEXT,
  note_refs      TEXT,
  remote_size    INTEGER,
  local_path     TEXT,
  downloaded_at  INTEGER,
  unmetered_only INTEGER NOT NULL DEFAULT 1,
  pinned         INTEGER NOT NULL DEFAULT 0,
  filename       TEXT,
  mime_type      TEXT
);

-- Reminder scheduling bookkeeping: device-local, never synced.
--
-- The platform caps how many notifications may be pending at once (FR-062), so
-- the core schedules a nearest window and refills it. `triggered_at` is
-- deliberately absent: each device shows its own notification, so a synced value
-- would suppress it on a device that never displayed it. Dismiss and snooze state
-- does sync and lives in the `reminders` projection.
CREATE TABLE IF NOT EXISTS local_notifications (
  reminder_id   TEXT PRIMARY KEY,
  target_type   TEXT NOT NULL,
  target_id     TEXT NOT NULL,
  fire_at       INTEGER NOT NULL,
  os_request_id TEXT,
  scheduled_at  INTEGER
);

-- Extracted plain text plus the create-time seed (§A.3).
--
-- `text` is the output of extract_text(doc): a plain-text walk of the
-- `prosemirror` XmlFragment that keeps headings and list markers and makes no
-- markdown-fidelity claim. It is fully rebuildable from the Yjs log.
--
-- `seed_markdown` is not derived. It is the create-time `content` payload, held
-- verbatim and never interpreted by the core, handed to the WebView by
-- `seed-from-markdown` and cleared after the first document update lands. A phone
-- that creates a note from a template and is killed before the WebView ever opens
-- must still have the template's content on next launch, and this column is why.
CREATE TABLE IF NOT EXISTS note_bodies (
  note_id         TEXT PRIMARY KEY,
  text            TEXT NOT NULL,
  seed_markdown   TEXT,
  text_sha256     TEXT NOT NULL,
  source_seq      INTEGER,
  materialised_at INTEGER NOT NULL
);
