//! Queue depth per item type, for a shell's diagnostics and tests.

use rusqlite::{Connection, params};

use super::failed;
use crate::api::errors::StorageError;

/// Every row of `item_type`, claimable or not.
pub fn depth_of(conn: &Connection, item_type: &str) -> Result<usize, StorageError> {
    conn.query_row(
        "SELECT count(*) FROM outbox WHERE item_type = ?1",
        params![item_type],
        |row| row.get::<_, i64>(0),
    )
    .map_err(failed)
    .map(|count| count as usize)
}
