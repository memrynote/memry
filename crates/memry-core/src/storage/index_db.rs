//! Opening `index.db`: migrate in place, set aside and rebuild only what cannot
//! be trusted, and never mistake "could not look" for "cannot be used"
//! (data-model §A.0, §A.5).
//!
//! `index.db` is derived from `data.db`, so recreating it can never cost a row of
//! user data. Three things send a file to a rebuild:
//!
//! - `quick_check` reports damage, or SQLite says it is not a database;
//! - the stored `user_version` is **newer** than this build writes, i.e. a newer
//!   build created it and an older one opened it;
//! - an in-place migration fails with a defect of its own (a SQL error or a
//!   constraint), which would otherwise fail every launch.
//!
//! A **lower** `user_version` is none of them. It migrates in place through the
//! hand-written, additive [`INDEX_MIGRATIONS`], each with its `user_version`
//! written in the migration's own transaction ([`migrations::run_atomic`]), keeping
//! every row, because later steps put content in this file (embeddings) that a
//! rebuild does not recover cheaply. A missing file is created.
//!
//! Every other failure is an error, not a rebuild: a lock (a second instance, a
//! backup tool), a permission or I/O error, a full disk. Deleting a healthy index
//! because it was busy for a moment would be the bug.
//!
//! A file that is rebuilt is **moved aside** (`index.db.corrupt-<ms>`,
//! `.newer-<ms>` or `.old-<ms>`, with its `-wal` and `-shm`), never deleted. The
//! newer one matters: after a downgrade the newer build wants its index back, and
//! two builds alternating would otherwise wipe it each time. Only the two newest
//! of each kind are kept.

use std::path::Path;

use crate::api::errors::StorageError;
use crate::storage::connection::{Db, Profile};
use crate::storage::guard::{self, is_damage};
use crate::storage::migrations::{self, INDEX_MIGRATIONS};
use crate::storage::quarantine;

/// Quarantined copies kept per kind.
const KEEP_SET_ASIDE: usize = 2;

/// The result of opening the index.
pub struct OpenedIndex {
    pub db: Db,
    /// `None` when the file on disk was reused, or migrated in place and kept its
    /// rows.
    ///
    /// `Some(reason)` when it was set aside and rebuilt (damaged, from a newer
    /// build, a failed migration) or did not exist, in which case the tables are
    /// empty and the caller owes a reindex from `data.db`. The reason is for
    /// logs; the decision has already been made.
    pub rebuild_reason: Option<String>,
}

/// Why a file cannot be reused, and what to call it when it is set aside.
struct Rebuild {
    label: &'static str,
    reason: String,
}

/// Opens `index.db`. See the module docs for what rebuilds and what errors.
pub fn open_or_rebuild(path: &Path) -> Result<OpenedIndex, StorageError> {
    guard::refuse_foreign_schema(path)?;
    let rebuild_reason = if path.exists() {
        match inspect(path)? {
            Ok(db) => {
                return Ok(OpenedIndex {
                    db,
                    rebuild_reason: None,
                });
            }
            Err(rebuild) => {
                quarantine::move_aside(path, rebuild.label, quarantine::now_ms())?;
                quarantine::prune(path, rebuild.label, KEEP_SET_ASIDE);
                rebuild.reason
            }
        }
    } else {
        "index.db does not exist".to_owned()
    };

    let db = build(path)?;
    Ok(OpenedIndex {
        db,
        rebuild_reason: Some(rebuild_reason),
    })
}

/// Reuses the file, migrating it in place when it is behind. The inner `Err` is
/// the verdict that it cannot be used (every handle on it is closed by then, so
/// it can be renamed); the outer `Err` is a failure to look, which is not a
/// verdict.
fn inspect(path: &Path) -> Result<Result<Db, Rebuild>, StorageError> {
    let db = match Db::open_with(path, Profile::Index) {
        Ok(db) => db,
        Err(err) if err.is_corrupt() => {
            return Ok(Err(Rebuild {
                label: "corrupt",
                reason: format!("could not open: {err}"),
            }));
        }
        Err(err) => return Err(err),
    };

    let verdict = db.call_blocking(|conn| {
        match conn.query_row("PRAGMA quick_check(1)", [], |row| row.get::<_, String>(0)) {
            Ok(check) if check == "ok" => {}
            Ok(check) => {
                return Ok(Some(Rebuild {
                    label: "corrupt",
                    reason: format!("integrity check reported {check}"),
                }));
            }
            Err(err) if is_damage(&err) => {
                return Ok(Some(Rebuild {
                    label: "corrupt",
                    reason: format!("integrity check failed: {err}"),
                }));
            }
            Err(err) => {
                return Err(StorageError::Failed {
                    what: format!("integrity check did not finish: {err}"),
                });
            }
        }

        let found = migrations::user_version(conn)?;
        let expected = migrations::latest_version(INDEX_MIGRATIONS);
        if found > expected {
            return Ok(Some(Rebuild {
                label: "newer",
                reason: format!(
                    "user_version is {found}, newer than the {expected} this build writes"
                ),
            }));
        }
        if found < expected
            && let Err(failure) = migrations::run_atomic(conn, INDEX_MIGRATIONS)
        {
            // A defect in the migration itself will fail again next launch. A
            // lock, an I/O error or a full disk will not, and is no reason to
            // throw the index away.
            return if is_migration_defect(&failure.error) {
                Ok(Some(Rebuild {
                    label: "old",
                    reason: format!(
                        "in-place migration from {found} to {expected} failed: {}",
                        StorageError::from(failure)
                    ),
                }))
            } else {
                Err(failure.into())
            };
        }
        Ok(None)
    })?;

    Ok(match verdict {
        None => Ok(db),
        Some(rebuild) => Err(rebuild),
    })
}

/// A SQL error or a constraint: the migration's own fault, as opposed to the
/// environment's (`BUSY`, `LOCKED`, `IOERR`, `FULL`, `CANTOPEN`, `READONLY`).
fn is_migration_defect(err: &rusqlite::Error) -> bool {
    matches!(
        err,
        rusqlite::Error::SqliteFailure(failure, _)
            if matches!(
                failure.code,
                rusqlite::ErrorCode::Unknown | rusqlite::ErrorCode::ConstraintViolation
            )
    )
}

fn build(path: &Path) -> Result<Db, StorageError> {
    let db = Db::open_with(path, Profile::Index)?;
    db.call_blocking(|conn| Ok(migrations::run_atomic(conn, INDEX_MIGRATIONS).map(drop)?))?;
    Ok(db)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::migrations::user_version;
    use crate::storage::test_support::temp_dir;
    use std::fs;

    /// The files in `dir` whose name starts with `prefix`, sorted.
    fn named(dir: &Path, prefix: &str) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .expect("dir")
            .map(|e| e.expect("entry").file_name().to_string_lossy().into_owned())
            .filter(|name| name.starts_with(prefix))
            .collect();
        names.sort();
        names
    }

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
    fn a_stale_wal_does_not_follow_into_the_rebuilt_index() {
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
        fs::write(dir.path().join("index.db-wal"), b"stale log").expect("a stale sidecar");

        let second = open_or_rebuild(&path).expect("second open");

        assert!(second.rebuild_reason.is_some());
        // The stale log went with the file it belonged to.
        let wal = fs::read(dir.path().join("index.db-wal")).unwrap_or_default();
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

    fn set_aside_copy(dir: &Path, label: &str) -> Db {
        let names = named(dir, &format!("index.db.{label}-"));
        let file = names
            .iter()
            .find(|n| !n.ends_with("-wal") && !n.ends_with("-shm"))
            .unwrap_or_else(|| panic!("no index.db.{label}-* in {names:?}"));
        Db::open_with(&dir.join(file), Profile::Index).expect("open the copy")
    }

    #[test]
    fn a_newer_index_is_set_aside_with_its_rows_not_wiped() {
        // Two builds taking turns on one vault must not wipe each other's index.
        let dir = temp_dir("index-newer-kept");
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
        assert!(opened.rebuild_reason.is_some());
        drop(opened);

        let kept = set_aside_copy(dir.path(), "newer");
        assert_eq!(
            row_count(&kept),
            1,
            "the newer build's rows are still there"
        );
    }

    #[test]
    fn a_corrupt_index_is_set_aside_not_deleted() {
        let dir = temp_dir("index-corrupt-kept");
        let path = dir.path().join("index.db");
        fs::write(&path, b"this is not a SQLite database").expect("garbage");

        open_or_rebuild(&path).expect("open");

        let copy = named(dir.path(), "index.db.corrupt-");
        assert_eq!(copy.len(), 1, "{copy:?}");
        assert_eq!(
            fs::read(dir.path().join(&copy[0])).expect("kept"),
            b"this is not a SQLite database"
        );
    }

    #[test]
    fn a_migration_that_fails_on_its_own_sets_the_file_aside() {
        let dir = temp_dir("index-migration-defect");
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
            .expect("a legacy file in the old crash window");

        let opened = open_or_rebuild(&path).expect("open");

        assert!(opened.rebuild_reason.is_some());
        drop(opened);
        assert_eq!(row_count(&set_aside_copy(dir.path(), "old")), 1);
    }

    /// Cannot be opened at all (mode 000): the environment's fault, not the
    /// file's. A rebuild here would delete a healthy index.
    #[cfg(unix)]
    #[test]
    fn an_index_that_cannot_be_read_is_an_error_and_is_left_alone() {
        use std::os::unix::fs::PermissionsExt as _;
        let dir = temp_dir("index-unreadable");
        let path = dir.path().join("index.db");
        index_at_version_one(&path);
        let before = fs::read(&path).expect("read");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o000)).expect("chmod");
        // root ignores file modes; nothing to prove then.
        if fs::read(&path).is_ok() {
            return;
        }

        let outcome = open_or_rebuild(&path);

        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).expect("restore");
        assert!(
            matches!(outcome, Err(StorageError::Failed { .. })),
            "{:?}",
            outcome.err()
        );
        assert_eq!(
            fs::read(&path).expect("read"),
            before,
            "the file is untouched"
        );
        assert!(
            named(dir.path(), "index.db.").is_empty(),
            "nothing was set aside"
        );
    }
}
