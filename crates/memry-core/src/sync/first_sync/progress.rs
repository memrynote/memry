//! The first sync's progress, counted in documents (#5233).
//!
//! A shell shows `Downloading notes · 3,200 of 9,677` while records arrive,
//! then `Downloading note content · 5,100 of 9,677` while bodies arrive. Both
//! numbers are live notes and journals, read from this device's own tables,
//! so the two phases share one unit and the strip never jumps between packs,
//! pages and documents.

use rusqlite::Connection;

use crate::api::errors::StorageError;
use crate::storage::Db;
use crate::sync::body_debt;

use super::{FirstSync, FirstSyncPhase, FirstSyncProgress, sqlite_failed};

/// Live note and journal records: how many this device knows of, and how many
/// of those it holds in full. A corrupt row counts in neither.
fn record_counts(conn: &Connection) -> Result<(u64, u64), StorageError> {
    conn.query_row(
        "SELECT COUNT(*), COALESCE(SUM(payload_state = 'full'), 0) FROM sync_items
         WHERE item_type IN ('note', 'journal') AND deleted_at IS NULL
           AND corrupt_reason IS NULL",
        [],
        |row| Ok((row.get::<_, i64>(0)? as u64, row.get::<_, i64>(1)? as u64)),
    )
    .map_err(sqlite_failed)
}

/// Live documents, and how many of them still owe a body pull.
fn body_counts(conn: &Connection) -> Result<(u64, u64), StorageError> {
    let live: i64 = conn
        .query_row(
            "SELECT (SELECT COUNT(*) FROM notes WHERE deleted_at IS NULL)
                  + (SELECT COUNT(*) FROM journal_entries WHERE deleted_at IS NULL)",
            [],
            |row| row.get(0),
        )
        .map_err(sqlite_failed)?;
    let owed = body_debt::owed(conn)?.len() as u64;
    Ok((live as u64, owed))
}

pub(crate) async fn read_body_counts(db: &Db) -> Result<(u64, u64), StorageError> {
    db.call(|conn| body_counts(conn)).await
}

/// [`read_body_counts`] on the read pool, for the bodies pass's progress: the
/// write-back a pack phase starts keeps the writer busy (#5350). Progress
/// only; the pool does not see an open sync transaction.
pub(super) async fn read_body_counts_pooled(db: &Db) -> Result<(u64, u64), StorageError> {
    db.read(body_counts).await
}

impl FirstSync {
    /// One records tick from the tables. `inventory_complete` is whether the
    /// feed has been read to its end: before that the vault's total is not
    /// known, and the tick says so rather than inventing one.
    pub(super) async fn records_progress(
        &self,
        inventory_complete: bool,
    ) -> Result<(), StorageError> {
        let (known, full) = self.db.call(|conn| record_counts(conn)).await?;
        self.progress.progress(FirstSyncProgress {
            phase: FirstSyncPhase::Records,
            completed: full,
            total: inventory_complete.then_some(known.max(full)),
        });
        Ok(())
    }
}
