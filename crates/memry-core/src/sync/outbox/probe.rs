//! Queue depth per item, for a shell's diagnostics and tests.

use rusqlite::{Connection, params};

use super::failed;
use crate::api::errors::StorageError;

/// Every row queued for item `item_id` (Electron's `hasQueuedItem('synced_settings')`,
/// `readwise/pull-gate.ts:149`), claimable or not.
pub fn queued_for(conn: &Connection, item_id: &str) -> Result<usize, StorageError> {
    conn.query_row(
        "SELECT count(*) FROM outbox WHERE item_id = ?1",
        params![item_id],
        |row| row.get::<_, i64>(0),
    )
    .map_err(failed)
    .map(|count| count as usize)
}

/// `getQueueStats` (`sync-client/queue.ts:529-557`) over record rows: note body rows
/// ([`super::OP_CRDT_UPDATE`]) are left out, as Electron's `isRecordRow` leaves them out.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RecordStats {
    /// Never tried.
    pub pending: usize,
    /// Tried and failed at least once, waiting for a retry.
    pub failed: usize,
}

pub fn record_stats(conn: &Connection) -> Result<RecordStats, StorageError> {
    conn.query_row(
        "SELECT count(*) FILTER (WHERE attempt_count = 0),
                count(*) FILTER (WHERE attempt_count > 0)
         FROM outbox WHERE op != ?1",
        params![super::OP_CRDT_UPDATE],
        |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
    )
    .map_err(failed)
    .map(|(pending, failed)| RecordStats {
        pending: pending as usize,
        failed: failed as usize,
    })
}
