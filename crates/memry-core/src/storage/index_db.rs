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
//! two builds alternating would otherwise wipe it each time. Only the newest of
//! each kind is kept.

use std::path::Path;

use crate::api::errors::StorageError;
use crate::storage::connection::{Db, Profile};
use crate::storage::guard::{self, is_damage};
use crate::storage::migrations::{self, INDEX_MIGRATIONS};
use crate::storage::quarantine;

/// Quarantined copies kept per kind. One: the index is derived, and a pile of
/// multi-hundred-megabyte copies is a disk hazard.
const KEEP_SET_ASIDE: usize = 1;

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
/// The `rebuild_reason` of a first open: no `index.db` existed, nothing was repaired.
pub const MISSING_REASON: &str = "index.db does not exist";

struct Rebuild {
    label: &'static str,
    reason: String,
}

/// Opens `index.db`. See the module docs for what rebuilds and what errors. With
/// feature `vec`, the vector tables are created after the migrations
/// ([`super::vec`]).
pub fn open_or_rebuild(path: &Path) -> Result<OpenedIndex, StorageError> {
    #[cfg(feature = "vec")]
    super::vec::register()?;
    open_tables(path)
}

/// The vector tables, after the migrations. A defect of the file (a vec0 table
/// that cannot be dropped) is a verdict that sends the index to the rebuild path,
/// like a migration defect; a lock or an I/O error stays an error.
#[cfg(feature = "vec")]
fn ensure_vectors(conn: &mut rusqlite::Connection) -> Result<Option<Rebuild>, StorageError> {
    match super::vec::ensure_vec_tables(conn) {
        Ok(dropped) => {
            for table in dropped {
                eprintln!("memry index: dropped {table}, built for another embedding width");
            }
            Ok(None)
        }
        Err(err) if is_migration_defect(&err) => Ok(Some(Rebuild {
            label: "old",
            reason: format!("vector table: {err}"),
        })),
        Err(err) => Err(StorageError::Failed {
            what: format!("vector table: {err}"),
        }),
    }
}

fn open_tables(path: &Path) -> Result<OpenedIndex, StorageError> {
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
        MISSING_REASON.to_owned()
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
        #[cfg(feature = "vec")]
        return ensure_vectors(conn);
        #[cfg(not(feature = "vec"))]
        Ok(None)
    })?;

    Ok(match verdict {
        None => Ok(db),
        Some(rebuild) => Err(rebuild),
    })
}

/// A SQL error or a constraint: the migration's own fault, as opposed to the
/// environment's (`BUSY`, `LOCKED`, `IOERR`, `FULL`, `CANTOPEN`, `READONLY`).
pub(crate) fn is_migration_defect(err: &rusqlite::Error) -> bool {
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
    db.call_blocking(|conn| {
        migrations::run_atomic(conn, INDEX_MIGRATIONS)?;
        #[cfg(feature = "vec")]
        if let Some(rebuild) = ensure_vectors(conn)? {
            return Err(StorageError::Failed {
                what: rebuild.reason,
            });
        }
        Ok(())
    })?;
    Ok(db)
}

#[cfg(test)]
#[path = "index_db_tests.rs"]
mod tests;
