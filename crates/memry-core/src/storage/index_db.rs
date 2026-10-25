//! Opening `index.db`: migrate in place, rebuild only what cannot be trusted
//! (data-model §A.0, §A.5).
//!
//! `index.db` is derived from `data.db`, so deleting it can never cost a row of
//! user data. That is why it lives in its own file, and it is why a rebuild is
//! the answer to the two cases nothing else can fix:
//!
//! - `quick_check` reports damage, or the file is not a database at all;
//! - the stored `user_version` is **newer** than this build writes, i.e. an older
//!   build opened a file a newer one created.
//!
//! A **lower** `user_version` is not one of them. It migrates in place through
//! the hand-written, additive [`INDEX_MIGRATIONS`], keeping every row, because
//! later steps put content in this file (embeddings) that a rebuild does not
//! recover cheaply. A missing file is created.
//!
//! The one exception is an in-place migration that itself fails. The runner
//! writes `user_version` after the migration's transaction commits, so a crash
//! in that window re-runs a migration that already applied, and an `ALTER TABLE
//! ADD COLUMN` cannot be written `IF NOT EXISTS`. Index migrations written from
//! now on must be idempotent; for one that is not, rebuilding is the only way
//! out of a file that would otherwise fail to open forever, and it is safe for
//! the same reason as above.
//!
//! Deleting means the WAL and shared-memory sidecars too (research R4). Leaving
//! `index.db-wal` behind next to a freshly created `index.db` hands SQLite a log
//! belonging to a file that no longer exists.

use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};

use crate::api::errors::StorageError;
use crate::storage::connection::{Db, Profile};
use crate::storage::guard;
use crate::storage::migrations::{self, INDEX_MIGRATIONS};

/// The result of opening the index.
pub struct OpenedIndex {
    pub db: Db,
    /// `None` when the file on disk was reused as-is.
    ///
    /// `Some(reason)` when it was deleted and rebuilt (damaged, from a newer
    /// build, or missing), in which case the tables are empty and the caller owes
    /// a reindex from `data.db`. A file that migrated in place is `None`: it kept
    /// its rows. The reason is for logs; the decision has already been made.
    pub rebuild_reason: Option<String>,
}

/// Opens `index.db`, rebuilding from scratch when the file cannot be trusted.
pub fn open_or_rebuild(path: &Path) -> Result<OpenedIndex, StorageError> {
    guard::refuse_foreign_schema(path)?;
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

/// Reuses the file if it opens and passes an integrity check, bringing it up to
/// this build's version in place when it is behind. `Err` carries why it cannot
/// be reused; it is not a failure, it is the rebuild trigger.
fn reuse(path: &Path) -> Result<Db, String> {
    let db = Db::open_with(path, Profile::Index).map_err(|err| err.to_string())?;

    let behind = db
        .call_blocking(|conn| {
            let check: String = conn
                .query_row("PRAGMA quick_check(1)", [], |row| row.get(0))
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
            if found > expected {
                return Err(StorageError::IndexRebuildRequired {
                    what: format!(
                        "user_version is {found}, newer than the {expected} this build writes"
                    ),
                });
            }
            if found < expected {
                migrations::run(conn, INDEX_MIGRATIONS).map_err(|err| {
                    StorageError::IndexRebuildRequired {
                        what: format!(
                            "in-place migration from {found} to {expected} failed: {err}"
                        ),
                    }
                })?;
            }
            Ok(())
        })
        .map_err(|err| err.to_string());
    behind?;

    Ok(db)
}

fn build(path: &Path) -> Result<Db, StorageError> {
    let db = Db::open_with(path, Profile::Index)?;
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

    /// An `index.db` at `INDEX_MIGRATIONS[..1]`, as a build before the second
    /// migration left it, holding one row in each table.
    fn index_at_version_one(path: &Path) {
        let db = Db::open_with(path, Profile::Index).expect("open");
        db.call_blocking(|conn| {
            migrations::run(conn, &INDEX_MIGRATIONS[..1])?;
            conn.execute_batch(
                "INSERT INTO index_meta (key, value) VALUES ('data.user_version', '12');
                 INSERT INTO note_links (source_id, target_id, target_title)
                   VALUES ('n1', NULL, 'Ödeme Toplantısı');",
            )
            .map_err(|err| StorageError::Failed {
                what: err.to_string(),
            })
        })
        .expect("seed version 1");
    }

    #[test]
    fn index_migrates_in_place_keeps_rows() {
        let dir = temp_dir("index-in-place");
        let path = dir.path().join("index.db");
        index_at_version_one(&path);

        let opened = open_or_rebuild(&path).expect("open");

        assert!(
            opened.rebuild_reason.is_none(),
            "a lower version is migrated, not rebuilt"
        );
        let (version, links, meta, keyed) = opened
            .db
            .call_blocking(|conn| {
                let count = |sql: &str| {
                    conn.query_row(sql, [], |row| row.get::<_, i64>(0))
                        .map_err(|err| StorageError::Failed {
                            what: err.to_string(),
                        })
                };
                Ok((
                    user_version(conn)?,
                    count(
                        "SELECT COUNT(*) FROM note_links WHERE target_title = 'Ödeme Toplantısı'",
                    )?,
                    count("SELECT COUNT(*) FROM index_meta")?,
                    // The column migration 2 adds exists and is queryable.
                    count("SELECT COUNT(*) FROM note_links WHERE target_key IS NULL")?,
                ))
            })
            .expect("read back");
        assert_eq!(version, migrations::latest_version(INDEX_MIGRATIONS));
        assert_eq!((links, meta, keyed), (1, 1, 1));
    }

    #[test]
    fn index_newer_version_is_rebuilt() {
        let dir = temp_dir("index-newer");
        let path = dir.path().join("index.db");
        index_at_version_one(&path);
        let newer = migrations::latest_version(INDEX_MIGRATIONS) + 1;
        Db::open_with(&path, Profile::Index)
            .expect("open")
            .call_blocking(|conn| {
                conn.execute_batch(&format!("PRAGMA user_version = {newer}"))
                    .map_err(|err| StorageError::Failed {
                        what: err.to_string(),
                    })
            })
            .expect("a newer build wrote this");

        let opened = open_or_rebuild(&path).expect("open");

        assert!(
            opened
                .rebuild_reason
                .as_deref()
                .is_some_and(|reason| reason.contains("newer"))
        );
        assert_eq!(row_count(&opened.db), 0);
    }

    #[test]
    fn index_migration_that_cannot_rerun_falls_back_to_a_rebuild() {
        // The crash window of migrations.rs: migration 2 committed, the counter
        // stayed at 1, and `ADD COLUMN` cannot be written `IF NOT EXISTS`.
        let dir = temp_dir("index-crash-window");
        let path = dir.path().join("index.db");
        index_at_version_one(&path);
        Db::open_with(&path, Profile::Index)
            .expect("open")
            .call_blocking(|conn| {
                conn.execute_batch("ALTER TABLE note_links ADD COLUMN target_key TEXT")
                    .map_err(|err| StorageError::Failed {
                        what: err.to_string(),
                    })
            })
            .expect("migration 2 applied without its counter");

        let opened = open_or_rebuild(&path).expect("open");

        assert!(
            opened
                .rebuild_reason
                .as_deref()
                .is_some_and(|reason| reason.contains("in-place migration"))
        );
        assert_eq!(row_count(&opened.db), 0);
    }
}
