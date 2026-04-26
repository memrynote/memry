-- M5: Persistent log of Y.js v1 updates per note.
--
-- seq is monotonic per note_id; on compaction, rows with seq <= replaced_seq
-- are deleted in the same transaction that writes the new snapshot. update_bytes
-- is BLOB so we can store binary v1 frames without UTF-8 round-trip damage.

CREATE TABLE crdt_updates (
    note_id text NOT NULL,
    seq integer NOT NULL,
    update_bytes blob NOT NULL,
    origin integer NOT NULL,
    created_at text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
    PRIMARY KEY (note_id, seq)
);

CREATE INDEX idx_crdt_updates_note ON crdt_updates (note_id, seq);
