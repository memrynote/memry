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
