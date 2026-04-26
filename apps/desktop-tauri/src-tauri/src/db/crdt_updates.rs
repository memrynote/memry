//! crdt_updates persistence helpers.

use crate::error::{AppError, AppResult};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

pub const MAX_BLOB_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CrdtUpdateRow {
    pub note_id: String,
    pub seq: i64,
    pub update_bytes: Vec<u8>,
    pub origin: i64,
    pub created_at: String,
}

pub fn append(conn: &Connection, note_id: &str, bytes: &[u8], origin: i64) -> AppResult<i64> {
    if bytes.len() > MAX_BLOB_BYTES {
        return Err(AppError::Validation(format!(
            "crdt update {} bytes exceeds cap {}",
            bytes.len(),
            MAX_BLOB_BYTES
        )));
    }

    let seq = max_seq(conn, note_id)? + 1;
    conn.execute(
        "INSERT INTO crdt_updates (note_id, seq, update_bytes, origin)
         VALUES (?1, ?2, ?3, ?4)",
        params![note_id, seq, bytes, origin],
    )?;
    Ok(seq)
}

pub fn max_seq(conn: &Connection, note_id: &str) -> AppResult<i64> {
    let seq = conn.query_row(
        "SELECT coalesce(max(seq), 0) FROM crdt_updates WHERE note_id = ?1",
        [note_id],
        |row| row.get(0),
    )?;
    Ok(seq)
}

pub fn list_for_note(conn: &Connection, note_id: &str) -> AppResult<Vec<CrdtUpdateRow>> {
    let mut stmt = conn.prepare(
        "SELECT note_id, seq, update_bytes, origin, created_at
           FROM crdt_updates
          WHERE note_id = ?1
          ORDER BY seq",
    )?;
    let rows = stmt.query_map([note_id], map_row)?;
    collect_rows(rows)
}

pub fn drop_through(conn: &Connection, note_id: &str, seq: i64) -> AppResult<()> {
    conn.execute(
        "DELETE FROM crdt_updates WHERE note_id = ?1 AND seq <= ?2",
        params![note_id, seq],
    )?;
    Ok(())
}

fn map_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<CrdtUpdateRow> {
    Ok(CrdtUpdateRow {
        note_id: row.get(0)?,
        seq: row.get(1)?,
        update_bytes: row.get(2)?,
        origin: row.get(3)?,
        created_at: row.get(4)?,
    })
}

fn collect_rows<T>(rows: impl Iterator<Item = rusqlite::Result<T>>) -> AppResult<Vec<T>> {
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}
