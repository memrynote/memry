//! The user's sync pause, persisted so it survives a reopen.
//!
//! [`super::driver::SyncDriver::pause`] holds the pause in memory only; the
//! shell that owns the pause writes it here first, then pauses the driver, and
//! reads it back when it starts the next one. New and additive: an older build
//! ignores the row.

use rusqlite::Connection;

use super::first_sync_store::{read_meta, write_meta};
use crate::api::errors::StorageError;

/// The `meta` key: `"1"` while paused. Anything else, or no row, is running.
pub const META_SYNC_PAUSED: &str = "sync.paused";

pub fn read(conn: &Connection) -> Result<bool, StorageError> {
    Ok(read_meta(conn, META_SYNC_PAUSED)?.as_deref() == Some("1"))
}

pub fn write(conn: &Connection, paused: bool) -> Result<(), StorageError> {
    write_meta(conn, META_SYNC_PAUSED, if paused { "1" } else { "0" })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::{open_data, test_support::temp_dir};

    #[test]
    fn a_pause_survives_a_reopen_of_the_database() {
        let dir = temp_dir("sync-pause");
        let path = dir.path().join("data.db");
        let db = open_data(&path).expect("open data.db");
        assert!(!db.call_blocking(|conn| read(conn)).unwrap(), "no row runs");
        db.call_blocking(|conn| write(conn, true)).unwrap();
        drop(db);

        let db = open_data(&path).expect("reopen data.db");
        assert!(db.call_blocking(|conn| read(conn)).unwrap());
        db.call_blocking(|conn| write(conn, false)).unwrap();
        assert!(!db.call_blocking(|conn| read(conn)).unwrap());
    }
}
