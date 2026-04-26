//! crdt_snapshots persistence helpers.

use crate::db::crdt_updates;
use crate::error::AppResult;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CrdtSnapshotRow {
    pub note_id: String,
    pub snapshot_bytes: Vec<u8>,
    pub state_vector: Vec<u8>,
    pub replaced_through_seq: i64,
    pub created_at: String,
}

pub fn upsert_with_compaction(
    conn: &Connection,
    note_id: &str,
    snapshot_bytes: &[u8],
    state_vector: &[u8],
    replaced_through_seq: i64,
) -> AppResult<()> {
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "INSERT INTO crdt_snapshots (note_id, snapshot_bytes, state_vector, replaced_through_seq)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(note_id) DO UPDATE SET
            snapshot_bytes = excluded.snapshot_bytes,
            state_vector = excluded.state_vector,
            replaced_through_seq = excluded.replaced_through_seq,
            created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
        params![note_id, snapshot_bytes, state_vector, replaced_through_seq],
    )?;
    crdt_updates::drop_through(&tx, note_id, replaced_through_seq)?;
    tx.commit()?;
    Ok(())
}

pub fn get_latest(conn: &Connection, note_id: &str) -> AppResult<Option<CrdtSnapshotRow>> {
    optional_row(conn.query_row(
        "SELECT note_id, snapshot_bytes, state_vector, replaced_through_seq, created_at
           FROM crdt_snapshots
          WHERE note_id = ?1",
        [note_id],
        map_row,
    ))
}

fn map_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<CrdtSnapshotRow> {
    Ok(CrdtSnapshotRow {
        note_id: row.get(0)?,
        snapshot_bytes: row.get(1)?,
        state_vector: row.get(2)?,
        replaced_through_seq: row.get(3)?,
        created_at: row.get(4)?,
    })
}

fn optional_row<T>(result: rusqlite::Result<T>) -> AppResult<Option<T>> {
    match result {
        Ok(row) => Ok(Some(row)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(err) => Err(err.into()),
    }
}
