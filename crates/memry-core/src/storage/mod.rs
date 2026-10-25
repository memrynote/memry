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
//! `index.db` migrates in place and is deleted and rebuilt only when it is
//! damaged or newer than this build.
//!
//! File protection (`completeUntilFirstUserAuthentication`) and backup exclusion
//! are attributes of the files, not of the connections, and belong to the shell
//! through the `FileProtection` seam.

pub mod connection;
pub mod guard;
pub mod index_db;
pub mod migrations;
pub(crate) mod pool;
pub mod pragmas;
pub(crate) mod quarantine;
pub mod recovery;
pub mod repositories;

use std::path::Path;

pub use connection::Db;
pub use index_db::OpenedIndex;

use crate::api::errors::StorageError;

/// How [`open_data_with`] treats a database it may not be able to trust.
#[derive(Debug, Clone, Copy, Default)]
pub struct OpenOptions {
    /// Run `quick_check(1)` on a read-only probe before the file is opened for
    /// writing, and report damage (and a recovery that never finished) as
    /// [`StorageError::Corrupt`] with the file left byte-for-byte as found.
    ///
    /// **Off by default**, which is how every shell opened `data.db` before this
    /// existed: the vault opens, and only a read that reaches the damaged page
    /// fails. A shell turns it on only when it also offers the user a way out
    /// ([`recovery::quarantine_and_rebuild`]); without one, `Corrupt` on every
    /// launch is a dead end. Desktop's session sets it; iOS does not.
    pub verify_integrity: bool,
}

/// Opens `data.db` and brings it to the latest schema version, with the default
/// [`OpenOptions`]. This is what `Vault::open` calls.
///
/// Forward only: an existing file steps through the migrations it has not seen
/// and keeps every row it already had. Refuses, without writing the file, a
/// database written by the Electron app ([`StorageError::ForeignSchema`]).
pub fn open_data(path: &Path) -> Result<Db, StorageError> {
    open_data_with(path, OpenOptions::default())
}

/// [`open_data`] with explicit [`OpenOptions`].
pub fn open_data_with(path: &Path, options: OpenOptions) -> Result<Db, StorageError> {
    guard::refuse_foreign_schema(path)?;
    if !options.verify_integrity {
        // A recovery that never finished leaves `data.db` missing or empty.
        // Finish it before handing the database out: the user must not write
        // beside a salvage that is still to come. A transient failure is an
        // error, not an empty vault; the marker stays for the next launch.
        if recovery::pending_recovery(path).is_some() {
            let report = recovery::quarantine_and_rebuild(path)?;
            if let Some(problems) = report.problems() {
                eprintln!(
                    "memry recovery: {} was salvaged only in part ({problems}); the \
                     damaged file is kept and the outcome is in recovery_log",
                    report.quarantined.display()
                );
            }
        } else {
            recovery::clear_settled_marker(path);
        }
        return open_data_unchecked(path);
    }

    let corrupt = || StorageError::Corrupt {
        path: path.display().to_string(),
    };
    if recovery::pending_recovery(path).is_some() {
        // An unfinished recovery: the file here is not the user's data.
        return Err(corrupt());
    }
    recovery::clear_settled_marker(path);
    // Before the file is opened for writing: a corrupt file stays as found.
    guard::check_integrity(path)?;
    let map = |err: StorageError| if err.is_corrupt() { corrupt() } else { err };
    let db = Db::open(path).map_err(map)?;
    db.call_blocking(|conn| migrations::run(conn, migrations::DATA_MIGRATIONS).map(drop))
        .map_err(map)?;
    Ok(db)
}

/// Opens and migrates `data.db` without looking at a pending recovery: what the
/// recovery itself uses to build the fresh database.
pub(crate) fn open_data_unchecked(path: &Path) -> Result<Db, StorageError> {
    let db = Db::open(path)?;
    db.call_blocking(|conn| migrations::run(conn, migrations::DATA_MIGRATIONS).map(drop))?;
    Ok(db)
}

/// Opens `index.db`: migrated in place when behind, set aside and rebuilt when
/// damaged or newer than this build, created when missing. Any other failure to
/// open it is an error, never a rebuild. See [`index_db::open_or_rebuild`].
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
