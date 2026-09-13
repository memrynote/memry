//! Core-owned SQLite: two databases per vault (data-model §A.0).
//!
//! ```text
//! Application Support/<bundle>/vault/<vaultId>/
//!   data.db        # source of record plus typed projections
//!   index.db       # rebuildable search and link index
//!   images/        # downloaded inline image bytes
//! ```
//!
//! The split is not tidiness. `index.db` is deletable: a full-text rebuild is a
//! large write that must never contend with, or risk, the outbox, which is the
//! one table whose loss loses a user's work. So `data.db` migrates forward and
//! `index.db` gets deleted and rebuilt whenever it is not exactly what this
//! build expects.
//!
//! File protection (`completeUntilFirstUserAuthentication`) and backup exclusion
//! are attributes of the files, not of the connections, and belong to the shell
//! through the `FileProtection` seam.

pub mod connection;
pub mod index_db;
pub mod migrations;
pub mod repositories;

use std::path::Path;

pub use connection::Db;
pub use index_db::OpenedIndex;

use crate::api::errors::StorageError;

/// Opens `data.db` and brings it to the latest schema version.
///
/// Forward only: an existing file steps through the migrations it has not seen
/// and keeps every row it already had.
pub fn open_data(path: &Path) -> Result<Db, StorageError> {
    let db = Db::open(path)?;
    db.call_blocking(|conn| migrations::run(conn, migrations::DATA_MIGRATIONS))?;
    Ok(db)
}

/// Opens `index.db`, rebuilding it from scratch if it is missing, corrupt, or at
/// an unexpected version. See [`index_db::open_or_rebuild`].
pub fn open_index(path: &Path) -> Result<OpenedIndex, StorageError> {
    index_db::open_or_rebuild(path)
}

#[cfg(test)]
pub(crate) mod test_support {
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    /// A scratch directory removed when it goes out of scope.
    pub(crate) struct TempDir {
        path: PathBuf,
    }

    impl TempDir {
        pub(crate) fn path(&self) -> &Path {
            &self.path
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    pub(crate) fn temp_dir(label: &str) -> TempDir {
        let unique = COUNTER.fetch_add(1, Ordering::Relaxed);
        let path =
            std::env::temp_dir().join(format!("memry-{label}-{}-{unique}", std::process::id()));
        std::fs::create_dir_all(&path).expect("create the scratch directory");
        TempDir { path }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_data_migrates_and_keeps_rows_across_reopens() {
        let dir = test_support::temp_dir("open-data");
        let path = dir.path().join("data.db");

        let db = open_data(&path).expect("first open");
        db.call_blocking(|conn| {
            conn.execute(
                "INSERT INTO meta (key, value) VALUES ('device.id', 'dev-1')",
                [],
            )
            .map_err(|err| StorageError::Failed {
                what: err.to_string(),
            })
        })
        .expect("insert");
        drop(db);

        let db = open_data(&path).expect("second open");
        let value: String = db
            .call_blocking(|conn| {
                conn.query_row(
                    "SELECT value FROM meta WHERE key = 'device.id'",
                    [],
                    |row| row.get(0),
                )
                .map_err(|err| StorageError::Failed {
                    what: err.to_string(),
                })
            })
            .expect("read back");

        assert_eq!(value, "dev-1");
    }
}
