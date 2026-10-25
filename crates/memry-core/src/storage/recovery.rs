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
//! **Resumable.** Before the file moves, the quarantine's path is written to a
//! marker beside the database (`data.db.recovering`). It is removed only after
//! salvage finished. If the fresh database cannot be built (disk full, a lock) or
//! the app dies mid-salvage, the marker stays; [`pending_recovery`] reports it,
//! the verified open refuses to hand out a database while it exists, and the next
//! [`quarantine_and_rebuild`] picks up from the quarantined file instead of
//! starting an empty database and losing the salvage.
//!
//! Salvage never overwrites a row the fresh database already holds (`INSERT OR
//! IGNORE`): a resumed salvage must not put old rows over newer writes.
//!
//! Salvage never fails recovery. A table that cannot be read to the end, and a
//! row the fresh schema refuses, are counted in the [`RecoveryReport`] for the
//! shell to log.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use rusqlite::types::Value;
use rusqlite::{Connection, OpenFlags, params_from_iter};

use crate::api::errors::StorageError;
use crate::storage::quarantine::{free_name, move_to, now_ms};
use crate::storage::{guard, open_data_unchecked};

/// What recovery did, for the log.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecoveryReport {
    /// Where the damaged database now lives. Never pruned: it may be the only
    /// copy of unsynced work, so the shell should tell the user where it is.
    pub quarantined: PathBuf,
    pub tables: Vec<TableSalvage>,
    /// Set when salvage could not even start or finish (the damaged file would
    /// not open, its table list was unreadable, a pragma was refused). The fresh
    /// database is empty in that case and the quarantined file still holds every
    /// row: nothing is lost, but nothing was carried over either.
    pub salvage_error: Option<String>,
}

/// The salvage of one table.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TableSalvage {
    pub table: String,
    pub copied: u64,
    /// Rows the fresh schema refused (a constraint the damaged file had slipped).
    pub rejected: u64,
    /// Set when reading stopped early: every row before it was copied, the rest
    /// of the table lay behind damage.
    pub read_error: Option<String>,
}

fn marker_path(path: &Path) -> PathBuf {
    PathBuf::from(format!("{}.recovering", path.display()))
}

/// The quarantined file of a recovery that has not finished, if one is pending
/// for the database at `path`.
pub fn pending_recovery(path: &Path) -> Option<PathBuf> {
    let text = std::fs::read_to_string(marker_path(path)).ok()?;
    let quarantined = PathBuf::from(text.trim());
    (!quarantined.as_os_str().is_empty()).then_some(quarantined)
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

/// Moves the database at `path` aside, creates a fresh migrated one in its
/// place, and copies the salvageable rows into it. The fresh database is closed
/// again on return; open it with [`open_data`].
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
    // A marker whose file is gone and whose database is still here is a crash
    // before the move: start over. Otherwise the move already happened.
    let quarantined = match pending_recovery(path) {
        Some(quarantined) if quarantined.exists() || !path.exists() => quarantined,
        _ => {
            let planned = free_name(path, "corrupt", now_ms());
            write_marker(path, &planned)?;
            move_to(path, &planned)?;
            planned
        }
    };
    let fresh = open_fresh(path)?;
    let (tables, salvage_error) = fresh.call_blocking(|conn| Ok(salvage(&quarantined, conn)))?;
    drop(fresh);
    // Salvage never overwrites live rows, so a marker that stays only makes the
    // next open re-run it harmlessly. It is still an error: the verified open
    // keeps refusing until the marker is gone, and the shell must say why.
    let marker = marker_path(path);
    if let Err(err) = std::fs::remove_file(&marker)
        && err.kind() != std::io::ErrorKind::NotFound
    {
        eprintln!(
            "memry recovery: could not remove {}: {err}",
            marker.display()
        );
        return Err(StorageError::Failed {
            what: format!(
                "recovery finished but the marker {} could not be removed: {err}",
                marker.display()
            ),
        });
    }
    Ok(RecoveryReport {
        quarantined,
        tables,
        salvage_error,
    })
}

/// Copies every table present in both files, over the columns both have.
/// Returns what was copied and, when salvage could not run to the end, why.
fn salvage(backup: &Path, fresh: &mut Connection) -> (Vec<TableSalvage>, Option<String>) {
    let old = match Connection::open_with_flags(
        backup,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) {
        Ok(old) => old,
        Err(err) => {
            return (
                Vec::new(),
                Some(format!("could not open the damaged file: {err}")),
            );
        }
    };
    let tables = match plain_tables(&old) {
        Ok(tables) => tables,
        Err(err) => {
            return (
                Vec::new(),
                Some(format!("could not list the damaged file's tables: {err}")),
            );
        }
    };

    // Insertion order is the damaged file's, not the foreign-key order of the
    // fresh schema. If the pragma is refused, salvage would reject rows for
    // ordering reasons alone, so it does not run.
    if let Err(err) = fresh.execute_batch("PRAGMA foreign_keys = OFF") {
        return (
            Vec::new(),
            Some(format!("could not suspend foreign keys: {err}")),
        );
    }
    let report = tables
        .iter()
        .filter_map(|table| copy_table(&old, fresh, table))
        .collect();
    let restored = fresh
        .execute_batch("PRAGMA foreign_keys = ON")
        .err()
        .map(|err| format!("could not restore foreign keys: {err}"));
    (report, restored)
}

/// Ordinary tables only: virtual tables and their shadow tables are derived.
fn plain_tables(conn: &Connection) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    )?;
    let rows: Vec<(String, Option<String>)> = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;

    let virtual_names: Vec<&String> = rows
        .iter()
        .filter(|(_, sql)| {
            sql.as_deref()
                .is_some_and(|sql| sql.to_ascii_uppercase().starts_with("CREATE VIRTUAL"))
        })
        .map(|(name, _)| name)
        .collect();
    // The shadow tables an FTS5 table keeps: exactly these suffixes, not any
    // table that merely starts with the virtual table's name.
    const FTS5_SHADOWS: [&str; 5] = ["data", "idx", "content", "docsize", "config"];
    let derived = |name: &str| {
        virtual_names.iter().any(|virtual_name| {
            name == virtual_name.as_str()
                || FTS5_SHADOWS
                    .iter()
                    .any(|suffix| name == format!("{virtual_name}_{suffix}"))
        })
    };
    Ok(rows
        .iter()
        .map(|(name, _)| name)
        .filter(|name| !derived(name))
        .cloned()
        .collect())
}

fn columns(conn: &Connection, table: &str) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT name FROM pragma_table_info('{}')",
        quote(table)
    ))?;
    stmt.query_map([], |row| row.get(0))?.collect()
}

/// `None` when the table does not exist in the fresh schema (a concept a later
/// build removed, or a table this build never had).
fn copy_table(old: &Connection, fresh: &mut Connection, table: &str) -> Option<TableSalvage> {
    let mut report = TableSalvage {
        table: table.to_owned(),
        copied: 0,
        rejected: 0,
        read_error: None,
    };
    let fresh_columns: HashSet<String> = match columns(fresh, table) {
        Ok(found) => found.into_iter().collect(),
        Err(err) => {
            // Skipped, and said so: a silent skip would read as "nothing there".
            report.read_error = Some(format!("could not read the fresh schema: {err}"));
            return Some(report);
        }
    };
    if fresh_columns.is_empty() {
        return None;
    }
    let shared: Vec<String> = match columns(old, table) {
        Ok(old_columns) => old_columns
            .into_iter()
            .filter(|column| fresh_columns.contains(column))
            .collect(),
        Err(err) => {
            report.read_error = Some(err.to_string());
            return Some(report);
        }
    };
    if shared.is_empty() {
        return Some(report);
    }

    let list = shared
        .iter()
        .map(|column| format!("\"{}\"", quote(column)))
        .collect::<Vec<_>>()
        .join(", ");
    let marks = vec!["?"; shared.len()].join(", ");
    let insert = format!(
        "INSERT OR IGNORE INTO \"{}\" ({list}) VALUES ({marks})",
        quote(table)
    );

    let outcome = (|| -> rusqlite::Result<()> {
        let tx = fresh.transaction()?;
        {
            let mut put = tx.prepare(&insert)?;
            let mut stmt = old.prepare(&format!("SELECT {list} FROM \"{}\"", quote(table)))?;
            let mut rows = stmt.query([])?;
            loop {
                // A step error is the damaged page: stop, keep what came before.
                let row = match rows.next() {
                    Ok(Some(row)) => row,
                    Ok(None) => break,
                    Err(err) => {
                        report.read_error = Some(err.to_string());
                        break;
                    }
                };
                let values: rusqlite::Result<Vec<Value>> =
                    (0..shared.len()).map(|i| row.get::<_, Value>(i)).collect();
                match values.and_then(|values| put.execute(params_from_iter(values))) {
                    Ok(_) => report.copied += 1,
                    Err(_) => report.rejected += 1,
                }
            }
        }
        tx.commit()
    })();
    if let Err(err) = outcome {
        report.read_error.get_or_insert(err.to_string());
    }
    Some(report)
}

fn quote(identifier: &str) -> String {
    identifier.replace('"', "\"\"").replace('\'', "''")
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
        let parked = pending_recovery(&path).expect("the recovery is remembered");
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
            pending_recovery(&path).is_none(),
            "done: the marker is gone"
        );
    }

    #[test]
    fn a_marker_that_cannot_be_removed_is_an_error_not_a_silent_success() {
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
        let err = rebuild(&path, &stuck).expect_err("must surface");

        assert!(
            matches!(&err, StorageError::Failed { what } if what.contains("marker") && what.contains("could not be removed")),
            "{err:?}"
        );
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
        assert!(pending_recovery(&path).is_none());
    }
}
