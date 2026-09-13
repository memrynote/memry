//! Opening `index.db`, and the delete-and-rebuild path (data-model §A.0, §A.5).
//!
//! `index.db` is never migrated. If it is missing, corrupt, or at an unexpected
//! `user_version`, the core deletes the file and builds a fresh one. That is the
//! whole reason the index lives in its own file: throwing it away costs a
//! reindex and cannot cost a row of user data, because every row here is derived
//! from `data.db`.
//!
//! Deleting means the WAL and shared-memory sidecars too (research R4). Leaving
//! `index.db-wal` behind next to a freshly created `index.db` hands SQLite a log
//! belonging to a file that no longer exists.

use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};

use crate::api::errors::StorageError;
use crate::storage::connection::Db;
use crate::storage::migrations::{self, INDEX_MIGRATIONS};

/// The result of opening the index.
pub struct OpenedIndex {
    pub db: Db,
    /// `None` when the file on disk was reused as-is.
    ///
    /// `Some(reason)` when it was deleted and rebuilt, in which case the tables
    /// are empty and the caller owes a reindex from `data.db`. The reason is for
    /// logs; the decision has already been made.
    pub rebuild_reason: Option<String>,
}

/// Opens `index.db`, rebuilding from scratch when the file cannot be trusted.
pub fn open_or_rebuild(path: &Path) -> Result<OpenedIndex, StorageError> {
    let rebuild_reason = if path.exists() {
        match reuse(path) {
            Ok(db) => {
                return Ok(OpenedIndex {
                    db,
                    rebuild_reason: None,
                });
            }
            Err(reason) => reason,
        }
    } else {
        "index.db does not exist".to_owned()
    };

    delete(path)?;
    let db = build(path)?;

    Ok(OpenedIndex {
        db,
        rebuild_reason: Some(rebuild_reason),
    })
}

/// Reuses the file if it opens, passes an integrity check, and is at exactly the
/// version this build writes. `Err` carries why it cannot be reused; it is not a
/// failure, it is the rebuild trigger.
fn reuse(path: &Path) -> Result<Db, String> {
    let db = Db::open(path).map_err(|err| err.to_string())?;

    db.call_blocking(|conn| {
        let check: String = conn
            .query_row("PRAGMA quick_check", [], |row| row.get(0))
            .map_err(|err| StorageError::IndexRebuildRequired {
                what: format!("integrity check failed to run: {err}"),
            })?;
        if check != "ok" {
            return Err(StorageError::IndexRebuildRequired {
                what: format!("integrity check reported {check}"),
            });
        }

        let found = migrations::user_version(conn)?;
        let expected = migrations::latest_version(INDEX_MIGRATIONS);
        if found != expected {
            return Err(StorageError::IndexRebuildRequired {
                what: format!("user_version is {found}, this build writes {expected}"),
            });
        }

        Ok(())
    })
    .map_err(|err| err.to_string())?;

    Ok(db)
}

fn build(path: &Path) -> Result<Db, StorageError> {
    let db = Db::open(path)?;
    db.call_blocking(|conn| migrations::run(conn, INDEX_MIGRATIONS))?;
    Ok(db)
}

/// Removes the database and its `-wal` and `-shm` sidecars. A path that is
/// already absent is not an error.
fn delete(path: &Path) -> Result<(), StorageError> {
    for target in [
        path.to_path_buf(),
        sidecar(path, "-wal"),
        sidecar(path, "-shm"),
    ] {
        match fs::remove_file(&target) {
            Ok(()) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => {
                return Err(StorageError::Failed {
                    what: format!("could not delete {}: {err}", target.display()),
                });
            }
        }
    }
    Ok(())
}

fn sidecar(path: &Path, suffix: &str) -> PathBuf {
    let mut name = OsString::from(path.as_os_str());
    name.push(suffix);
    PathBuf::from(name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::migrations::user_version;
    use crate::storage::test_support::temp_dir;

    fn row_count(db: &Db) -> i64 {
        db.call_blocking(|conn| {
            conn.query_row("SELECT COUNT(*) FROM index_meta", [], |row| row.get(0))
                .map_err(|err| StorageError::Failed {
                    what: err.to_string(),
                })
        })
        .expect("count")
    }

    fn mark(db: &Db) {
        db.call_blocking(|conn| {
            conn.execute(
                "INSERT INTO index_meta (key, value) VALUES ('data.user_version', '2')",
                [],
            )
            .map_err(|err| StorageError::Failed {
                what: err.to_string(),
            })
        })
        .expect("mark");
    }

    #[test]
    fn a_missing_file_is_built_and_reported_as_a_rebuild() {
        let dir = temp_dir("index-missing");
        let opened = open_or_rebuild(&dir.path().join("index.db")).expect("open");

        assert!(opened.rebuild_reason.is_some());
        let version = opened
            .db
            .call_blocking(|conn| user_version(conn))
            .expect("version");
        assert_eq!(version, migrations::latest_version(INDEX_MIGRATIONS));
    }

    #[test]
    fn a_good_file_is_reused() {
        let dir = temp_dir("index-reuse");
        let path = dir.path().join("index.db");

        let first = open_or_rebuild(&path).expect("first open");
        mark(&first.db);
        drop(first);

        let second = open_or_rebuild(&path).expect("second open");
        assert!(second.rebuild_reason.is_none());
        assert_eq!(row_count(&second.db), 1);
    }

    #[test]
    fn an_unexpected_version_is_deleted_and_rebuilt() {
        let dir = temp_dir("index-version");
        let path = dir.path().join("index.db");

        let first = open_or_rebuild(&path).expect("first open");
        mark(&first.db);
        // A file written by a future build.
        first
            .db
            .call_blocking(|conn| {
                conn.execute_batch("PRAGMA user_version = 99")
                    .map_err(|err| StorageError::Failed {
                        what: err.to_string(),
                    })
            })
            .expect("bump");
        drop(first);

        let second = open_or_rebuild(&path).expect("second open");
        assert!(
            second
                .rebuild_reason
                .as_deref()
                .is_some_and(|reason| reason.contains("99"))
        );
        assert_eq!(row_count(&second.db), 0);
    }

    #[test]
    fn a_corrupt_file_is_deleted_and_rebuilt() {
        let dir = temp_dir("index-corrupt");
        let path = dir.path().join("index.db");
        fs::write(&path, b"this is not a SQLite database").expect("write garbage");

        let opened = open_or_rebuild(&path).expect("open");

        assert!(opened.rebuild_reason.is_some());
        assert_eq!(row_count(&opened.db), 0);
        let version = opened
            .db
            .call_blocking(|conn| user_version(conn))
            .expect("version");
        assert_eq!(version, migrations::latest_version(INDEX_MIGRATIONS));
    }

    #[test]
    fn a_rebuild_takes_the_wal_sidecar_with_it() {
        let dir = temp_dir("index-sidecar");
        let path = dir.path().join("index.db");

        let first = open_or_rebuild(&path).expect("first open");
        first
            .db
            .call_blocking(|conn| {
                conn.execute_batch("PRAGMA user_version = 99")
                    .map_err(|err| StorageError::Failed {
                        what: err.to_string(),
                    })
            })
            .expect("bump");
        drop(first);
        fs::write(sidecar(&path, "-wal"), b"stale log").expect("write a stale sidecar");

        let second = open_or_rebuild(&path).expect("second open");

        assert!(second.rebuild_reason.is_some());
        // The fresh connection may have created its own WAL; what must not
        // survive is the stale one.
        let wal = fs::read(sidecar(&path, "-wal")).unwrap_or_default();
        assert_ne!(wal, b"stale log");
    }
}
