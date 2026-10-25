//! Recovery of a corrupt `data.db`: quarantine the file, build a fresh one, and
//! salvage every row that can still be read.
//!
//! Nothing is deleted. The damaged file keeps its name plus `.corrupt-<unix ms>`
//! (and its `-wal` and `-shm` with the same suffixes), because it may be the only
//! copy of anything that has not synced yet.
//!
//! Unlike the Electron recovery, which carries four tables and lets the rest
//! refill from vault files, **every** core table is salvaged. Core rows (tasks,
//! projects, the outbox, Yjs updates) have no other copy until they sync. The
//! `meta` table travels with them, so `device.id` survives and the vault does not
//! turn into a stranger to the server.
//!
//! **Resumable, and finished exactly once.** Before the file moves, the
//! quarantine's path is written to a marker beside the database
//! (`data.db.recovering`). The salvage then runs in ONE transaction that also
//! inserts a `recovery_log` row for that quarantine, so the rows and the proof
//! that they were carried over commit together or not at all. The marker is a
//! hint, the log row is the truth:
//!
//! - marker, quarantine on disk, no log row: the salvage did not finish. The
//!   verified open refuses, the default open finishes it (the database it
//!   salvages into holds no user rows: nothing opens it before this).
//! - marker and a log row: the salvage finished. A marker that could not be
//!   removed is removed on the next open and never triggers a second salvage,
//!   which would bring back rows deleted since.
//! - marker, no log row, quarantine gone (a shell pruned it, or the app died
//!   before the move): the live `data.db` is opened as it is, never moved aside.
//!   Shells must not prune the quarantine a marker names while no log row
//!   records it.
//!
//! Failures sort by SQLite's error code. Damage in the quarantined file
//! (`CORRUPT`, `NOTADB`) is permanent: the log row records what was lost and the
//! marker goes, because retrying cannot help; so is an I/O error reading the
//! quarantine, which repeats on every launch. Anything else (disk full, a lock,
//! an I/O error writing the fresh database, an unreadable file) is transient: nothing commits, the marker
//! stays, and the open fails instead of handing out an empty database.
//!
//! Salvage never overwrites a row the fresh database holds (`ON CONFLICT DO
//! NOTHING`). A row the fresh schema refuses, and a table that cannot be read to
//! the end, are counted in the [`RecoveryReport`] and the log row.

use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags, params};

use crate::api::errors::StorageError;
use crate::storage::guard::is_damage;
use crate::storage::quarantine::{free_name, move_to, now_ms};
pub use crate::storage::salvage::TableSalvage;
use crate::storage::salvage::{copy_table, is_transient, plain_tables, transient};
use crate::storage::{guard, open_data_unchecked};

/// What recovery did, for the log.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecoveryReport {
    /// Where the damaged database now lives. Never pruned by core: it may be the
    /// only copy of unsynced work, so the shell should tell the user where it is.
    pub quarantined: PathBuf,
    pub tables: Vec<TableSalvage>,
    /// Set when the damaged file would not open or list its tables. The fresh
    /// database is empty in that case and the quarantined file still holds every
    /// row: nothing is lost, but nothing was carried over either.
    pub salvage_error: Option<String>,
}

impl RecoveryReport {
    /// What could not be carried over, or `None` for a clean salvage. The same
    /// text is stored in the database's `recovery_log`.
    pub fn problems(&self) -> Option<String> {
        let text = describe(&self.tables, self.salvage_error.as_deref());
        (!text.is_empty()).then_some(text)
    }
}

fn describe(tables: &[TableSalvage], salvage_error: Option<&str>) -> String {
    let mut parts: Vec<String> = salvage_error.map(str::to_owned).into_iter().collect();
    for table in tables {
        if let Some(err) = &table.read_error {
            parts.push(format!("{}: {err}", table.table));
        }
        if table.rejected > 0 {
            parts.push(format!("{}: {} rows refused", table.table, table.rejected));
        }
    }
    parts.join("; ")
}

fn marker_path(path: &Path) -> PathBuf {
    PathBuf::from(format!("{}.recovering", path.display()))
}

fn io_failure(what: &str, path: &Path, err: &dyn std::fmt::Display) -> StorageError {
    StorageError::Failed {
        what: format!("recovery could not check {what} {}: {err}", path.display()),
    }
}

/// Whether `path` holds the proof that the salvage of `quarantined` finished.
/// Only a missing database, a missing table or row, or a damaged file mean "no":
/// a busy, locked or unreadable one is an error, because answering "no" would
/// salvage a second time and bring back rows deleted since.
fn completed(path: &Path, quarantined: &Path) -> Result<bool, StorageError> {
    let Some(name) = quarantined.file_name() else {
        return Ok(false);
    };
    if !path
        .try_exists()
        .map_err(|err| io_failure("the database", path, &err))?
    {
        return Ok(false);
    }
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|err| io_failure("the database", path, &err))?;
    match conn.query_row(
        "SELECT 1 FROM recovery_log WHERE quarantine_name = ?1",
        [name.to_string_lossy()],
        |_| Ok(()),
    ) {
        Ok(()) => Ok(true),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(false),
        Err(err) if is_damage(&err) || err.to_string().contains("no such table") => Ok(false),
        Err(err) => Err(io_failure("the recovery log in", path, &err)),
    }
}

/// What the marker beside a database says.
enum Marker {
    /// No marker, or one that is not a file (nothing to act on).
    Absent,
    /// An unfinished recovery: the quarantine is on disk and unrecorded.
    Pending(PathBuf),
    /// The salvage is recorded (`recorded`), or the quarantine is gone.
    Stale {
        quarantined: PathBuf,
        recorded: bool,
    },
}

fn marker_state(path: &Path) -> Result<Marker, StorageError> {
    let marker = marker_path(path);
    // A directory is not a marker (and Windows reports reading one as "access
    // denied", which would read as an undecidable marker).
    if marker.is_dir() {
        return Ok(Marker::Absent);
    }
    let text = match std::fs::read_to_string(&marker) {
        Ok(text) => text,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Marker::Absent),
        Err(err) => return Err(io_failure("the marker", &marker, &err)),
    };
    let quarantined = PathBuf::from(text.trim());
    if quarantined.as_os_str().is_empty() {
        return Ok(Marker::Absent);
    }
    // A stat error is not "gone": treating it so would drop the marker and
    // abandon the salvage.
    let on_disk = quarantined
        .try_exists()
        .map_err(|err| io_failure("the quarantine", &quarantined, &err))?;
    let recorded = completed(path, &quarantined)?;
    Ok(if on_disk && !recorded {
        Marker::Pending(quarantined)
    } else {
        Marker::Stale {
            quarantined,
            recorded,
        }
    })
}

/// The quarantined file of a recovery that has not finished: a marker beside
/// `path`, a quarantine still on disk, and no `recovery_log` row for it. An
/// error means that could not be decided, and the caller must not open.
pub fn pending_recovery(path: &Path) -> Result<Option<PathBuf>, StorageError> {
    Ok(match marker_state(path)? {
        Marker::Pending(quarantined) => Some(quarantined),
        _ => None,
    })
}

fn write_marker(path: &Path, quarantined: &Path) -> Result<(), StorageError> {
    let marker = marker_path(path);
    let failed = |err: std::io::Error| StorageError::Failed {
        what: format!(
            "could not record the recovery in {}: {err}",
            marker.display()
        ),
    };
    let mut file = std::fs::File::create(&marker).map_err(failed)?;
    std::io::Write::write_all(&mut file, quarantined.display().to_string().as_bytes())
        .map_err(failed)?;
    file.sync_all().map_err(failed)
}

/// Removes the marker. A marker that stays is harmless (see the module docs), so
/// a failure is logged and never fails an open or a finished recovery.
fn remove_marker(path: &Path) {
    let marker = marker_path(path);
    if let Err(err) = std::fs::remove_file(&marker)
        && err.kind() != std::io::ErrorKind::NotFound
    {
        eprintln!(
            "memry recovery: could not remove {}: {err}",
            marker.display()
        );
    }
}

/// Drops a marker that no longer means anything: its salvage is recorded, or its
/// quarantine is gone. Never moves or salvages the live database.
pub(crate) fn clear_settled_marker(path: &Path) -> Result<(), StorageError> {
    if let Marker::Stale {
        quarantined,
        recorded,
    } = marker_state(path)?
    {
        if !recorded {
            eprintln!(
                "memry recovery: the quarantine {} named by the marker is gone and no \
                 recovery_log row records it; opening {} as it is",
                quarantined.display(),
                path.display()
            );
        }
        remove_marker(path);
    }
    Ok(())
}

/// Moves the database at `path` aside, creates a fresh migrated one in its
/// place, and copies the salvageable rows into it. The fresh database is closed
/// again on return; open it with [`open_data`](crate::storage::open_data).
///
/// Call it again after a failure and it resumes from the quarantined file (see
/// the module docs). The caller closes every handle on `path` first: an open
/// connection would keep writing to the file that was just renamed.
pub fn quarantine_and_rebuild(path: &Path) -> Result<RecoveryReport, StorageError> {
    rebuild(path, &open_data_unchecked)
}

fn rebuild(
    path: &Path,
    open_fresh: &dyn Fn(&Path) -> Result<crate::storage::Db, StorageError>,
) -> Result<RecoveryReport, StorageError> {
    guard::refuse_foreign_schema(path)?;
    // No unfinished recovery (a marker without its quarantine means the app died
    // before the move): this is a new one.
    let quarantined = match pending_recovery(path)? {
        Some(quarantined) => quarantined,
        None => {
            let planned = free_name(path, "corrupt", now_ms());
            write_marker(path, &planned)?;
            move_to(path, &planned)?;
            planned
        }
    };
    let fresh = open_fresh(path)?;
    let (tables, salvage_error) = fresh.call_blocking(|conn| salvage(&quarantined, conn))?;
    drop(fresh);
    remove_marker(path);
    Ok(RecoveryReport {
        quarantined,
        tables,
        salvage_error,
    })
}

type Salvaged = (Vec<TableSalvage>, Option<String>);

/// Copies every table present in both files, over the columns both have, and
/// records the recovery, all in one transaction. `Err` means nothing committed.
fn salvage(backup: &Path, fresh: &mut Connection) -> Result<Salvaged, StorageError> {
    // Insertion order is the damaged file's, not the foreign-key order of the
    // fresh schema, so salvage would reject rows for ordering reasons alone.
    fresh
        .execute_batch("PRAGMA foreign_keys = OFF")
        .map_err(|err| transient("suspend foreign keys", &err))?;
    let outcome = salvage_in_transaction(backup, fresh);
    if let Err(err) = fresh.execute_batch("PRAGMA foreign_keys = ON") {
        eprintln!("memry recovery: could not restore foreign keys: {err}");
    }
    outcome
}

fn salvage_in_transaction(backup: &Path, fresh: &mut Connection) -> Result<Salvaged, StorageError> {
    let tx = fresh
        .transaction()
        .map_err(|err| transient("begin the salvage", &err))?;
    let (tables, salvage_error) = copy_all(backup, &tx)?;
    let copied: u64 = tables.iter().map(|t| t.copied).sum();
    let rejected: u64 = tables.iter().map(|t| t.rejected).sum();
    let name = backup
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    tx.execute(
        "INSERT OR REPLACE INTO recovery_log \
         (quarantine_name, completed_at, rows_copied, rows_rejected, detail) \
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            name,
            i64::try_from(now_ms()).unwrap_or(i64::MAX),
            i64::try_from(copied).unwrap_or(i64::MAX),
            i64::try_from(rejected).unwrap_or(i64::MAX),
            describe(&tables, salvage_error.as_deref()),
        ],
    )
    .map_err(|err| transient("record the recovery", &err))?;
    tx.commit()
        .map_err(|err| transient("commit the salvage", &err))?;
    Ok((tables, salvage_error))
}

fn copy_all(backup: &Path, fresh: &Connection) -> Result<Salvaged, StorageError> {
    let old = match Connection::open_with_flags(
        backup,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) {
        Ok(old) => old,
        Err(err) if is_transient(&err) => {
            return Err(transient("open the quarantined file", &err));
        }
        Err(err) => {
            return Ok((
                Vec::new(),
                Some(format!("could not open the damaged file: {err}")),
            ));
        }
    };
    let tables = match plain_tables(&old) {
        Ok(tables) => tables,
        Err(err) if !is_damage(&err) && is_transient(&err) => {
            return Err(transient("list the quarantined file's tables", &err));
        }
        Err(err) => {
            return Ok((
                Vec::new(),
                Some(format!("could not list the damaged file's tables: {err}")),
            ));
        }
    };
    let mut report = Vec::new();
    for table in &tables {
        report.extend(copy_table(&old, fresh, table)?);
    }
    Ok((report, None))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::open_data;
    use crate::storage::test_support::temp_dir;

    fn meta_value(db: &crate::storage::Db, key: &'static str) -> Option<String> {
        db.read_blocking(|conn| {
            conn.query_row("SELECT value FROM meta WHERE key = ?1", [key], |row| {
                row.get(0)
            })
            .map(Some)
            .or_else(|err| match err {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                other => Err(StorageError::Failed {
                    what: other.to_string(),
                }),
            })
        })
        .expect("meta")
    }

    #[test]
    fn corrupt_recovery_resumes_from_the_quarantine_after_a_failed_rebuild() {
        let dir = temp_dir("recovery-resume");
        let path = dir.path().join("data.db");
        {
            let db = open_data(&path).expect("open");
            db.call_blocking(|conn| {
                conn.execute(
                    "INSERT INTO meta (key, value) VALUES ('device.id', 'dev-9')",
                    [],
                )
                .map_err(|err| StorageError::Failed {
                    what: err.to_string(),
                })
            })
            .expect("a row to keep");
        }

        // The disk fills up after the file moved.
        let full = |_: &Path| -> Result<crate::storage::Db, StorageError> {
            Err(StorageError::OutOfSpace {
                needed_bytes: 1,
                available_bytes: 0,
            })
        };
        assert!(rebuild(&path, &full).is_err());
        assert!(
            !path.exists(),
            "the database is parked, nothing stands in its place"
        );
        let parked = pending_recovery(&path)
            .expect("decidable")
            .expect("the recovery is remembered");
        assert!(parked.exists());
        // Until it finishes, a verified open does not hand out an empty database.
        let verified = crate::storage::OpenOptions {
            verify_integrity: true,
        };
        assert!(matches!(
            crate::storage::open_data_with(&path, verified),
            Err(StorageError::Corrupt { .. })
        ));
        assert!(!path.exists(), "and it did not create one");

        // A later launch finishes the job from the parked file.
        let report = quarantine_and_rebuild(&path).expect("resume");

        assert_eq!(
            report.quarantined, parked,
            "it did not quarantine a second time"
        );
        assert_eq!(
            meta_value(&open_data(&path).expect("open"), "device.id").as_deref(),
            Some("dev-9")
        );
        assert!(
            pending_recovery(&path).expect("decidable").is_none(),
            "done: the marker is gone"
        );
    }

    #[test]
    fn a_marker_that_cannot_be_removed_does_not_fail_a_finished_recovery() {
        let dir = temp_dir("recovery-marker-stuck");
        let path = dir.path().join("data.db");
        drop(open_data(&path).expect("open"));

        // A directory where the marker file was: `remove_file` refuses it.
        let stuck = |p: &Path| -> Result<crate::storage::Db, StorageError> {
            let marker = marker_path(p);
            std::fs::remove_file(&marker).expect("the marker exists");
            std::fs::create_dir(&marker).expect("block the marker");
            open_data_unchecked(p)
        };
        let report = rebuild(&path, &stuck).expect("the recovery itself finished");

        assert!(report.problems().is_none());
        assert!(
            open_data(&path).is_ok(),
            "a stuck marker never fails the open"
        );
    }

    /// A busy database cannot answer "was this salvage recorded?". Answering "no"
    /// would salvage again and bring back rows the user deleted since.
    #[test]
    fn a_locked_database_is_an_error_not_a_pending_recovery() {
        let dir = temp_dir("recovery-locked");
        let path = dir.path().join("data.db");
        let parked = dir.path().join("data.db.corrupt-1");
        std::fs::write(&parked, b"x").expect("quarantine");
        write_marker(&path, &parked).expect("marker");
        // Rollback-mode database with the proof in it, held under an exclusive lock.
        let holder = Connection::open(&path).expect("create");
        holder
            .execute_batch(
                "CREATE TABLE recovery_log (quarantine_name TEXT PRIMARY KEY);
                 INSERT INTO recovery_log VALUES ('data.db.corrupt-1');
                 BEGIN EXCLUSIVE;",
            )
            .expect("lock");

        let outcome = pending_recovery(&path);

        assert!(
            matches!(&outcome, Err(StorageError::Failed { .. })),
            "{outcome:?}"
        );
        assert!(marker_path(&path).exists(), "the marker is kept");
        drop(holder);
        assert_eq!(pending_recovery(&path).expect("decidable"), None);
    }

    #[cfg(unix)]
    #[test]
    fn a_quarantine_that_cannot_be_statted_is_an_error_not_gone() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp_dir("recovery-stat");
        let path = dir.path().join("data.db");
        let sealed = dir.path().join("sealed");
        std::fs::create_dir(&sealed).expect("dir");
        let parked = sealed.join("data.db.corrupt-1");
        std::fs::write(&parked, b"x").expect("quarantine");
        write_marker(&path, &parked).expect("marker");
        std::fs::set_permissions(&sealed, std::fs::Permissions::from_mode(0o000)).expect("chmod");
        let readable = std::fs::metadata(&parked).is_ok();

        let outcome = clear_settled_marker(&path);

        std::fs::set_permissions(&sealed, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        if readable {
            return; // root ignores permissions
        }
        assert!(matches!(outcome, Err(StorageError::Failed { .. })));
        assert!(marker_path(&path).exists(), "the salvage is not abandoned");
    }

    #[test]
    fn a_marker_from_a_crash_before_the_move_starts_over() {
        let dir = temp_dir("recovery-early-crash");
        let path = dir.path().join("data.db");
        drop(open_data(&path).expect("open"));
        write_marker(&path, &dir.path().join("data.db.corrupt-never-moved")).expect("marker");

        let report = quarantine_and_rebuild(&path).expect("recover");

        assert!(report.quarantined.exists());
        assert!(path.exists());
        assert!(pending_recovery(&path).expect("decidable").is_none());
    }
}
