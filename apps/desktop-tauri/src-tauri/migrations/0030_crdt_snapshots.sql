-- M5: Per-note compaction snapshot. `replaced_through_seq` lets us assert
-- that updates rows with seq <= replaced_through_seq were deleted in the
-- same transaction that wrote this snapshot; mismatched values are caught by
-- db::crdt_snapshots::write_with_compaction integration tests.

CREATE TABLE crdt_snapshots (
    note_id text PRIMARY KEY NOT NULL,
    snapshot_bytes blob NOT NULL,
    state_vector blob NOT NULL,
    replaced_through_seq integer NOT NULL,
    created_at text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
