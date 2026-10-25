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
//! Salvage never fails recovery. A table that cannot be read to the end, and a
//! row the fresh schema refuses, are counted in the [`RecoveryReport`] for the
//! shell to log.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::types::Value;
use rusqlite::{Connection, OpenFlags, params_from_iter};

use crate::api::errors::StorageError;
use crate::storage::guard;
use crate::storage::open_data;

/// The `-wal` and `-shm` SQLite keeps beside a database; they move with it.
const SIDECARS: [&str; 2] = ["-wal", "-shm"];

/// What recovery did, for the log.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecoveryReport {
    /// Where the damaged database now lives.
    pub quarantined: PathBuf,
    pub tables: Vec<TableSalvage>,
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

/// Moves the database at `path` aside, creates a fresh migrated one in its
/// place, and copies the salvageable rows into it. The fresh database is closed
/// again on return; open it with [`open_data`].
///
/// The caller closes every handle on `path` first: an open connection would
/// keep writing to the file that was just renamed.
pub fn quarantine_and_rebuild(path: &Path) -> Result<RecoveryReport, StorageError> {
    guard::refuse_foreign_schema(path)?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis());
    let quarantined = move_aside(path, stamp)?;
    let fresh = open_data(path)?;
    let tables = fresh.call_blocking(|conn| Ok(salvage(&quarantined, conn)))?;
    Ok(RecoveryReport {
        quarantined,
        tables,
    })
}

/// Renames the file and its sidecars to `<path>.corrupt-<ms>[-n]`.
fn move_aside(path: &Path, stamp: u128) -> Result<PathBuf, StorageError> {
    let named = |suffix: &str| PathBuf::from(format!("{}{suffix}", path.display()));
    let mut backup = named(&format!(".corrupt-{stamp}"));
    let mut n = 1;
    while backup.exists() {
        backup = named(&format!(".corrupt-{stamp}-{n}"));
        n += 1;
    }

    let rename = |from: &Path, to: &Path| {
        std::fs::rename(from, to).map_err(|err| StorageError::Failed {
            what: format!("could not move {} aside: {err}", from.display()),
        })
    };
    rename(path, &backup)?;
    for suffix in SIDECARS {
        let sidecar = named(suffix);
        if sidecar.exists() {
            rename(
                &sidecar,
                &PathBuf::from(format!("{}{suffix}", backup.display())),
            )?;
        }
    }
    Ok(backup)
}

/// Copies every table present in both files, over the columns both have.
fn salvage(backup: &Path, fresh: &mut Connection) -> Vec<TableSalvage> {
    let Ok(old) = Connection::open_with_flags(
        backup,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) else {
        return Vec::new();
    };
    let Ok(tables) = plain_tables(&old) else {
        return Vec::new();
    };

    // Insertion order is the damaged file's, not the foreign-key order of the
    // fresh schema.
    let _ = fresh.execute_batch("PRAGMA foreign_keys = OFF");
    let report = tables
        .iter()
        .filter_map(|table| copy_table(&old, fresh, table))
        .collect();
    let _ = fresh.execute_batch("PRAGMA foreign_keys = ON");
    report
}

/// Ordinary tables only: virtual tables and their shadow tables are derived.
fn plain_tables(conn: &Connection) -> rusqlite::Result<Vec<String>> {
    let mut virtual_names = HashSet::new();
    let mut stmt = conn.prepare(
        "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
    })?;
    let mut plain = Vec::new();
    for row in rows {
        let (name, sql) = row?;
        let is_virtual = sql
            .as_deref()
            .is_some_and(|sql| sql.to_ascii_uppercase().starts_with("CREATE VIRTUAL"));
        if is_virtual {
            virtual_names.insert(name);
        } else {
            plain.push(name);
        }
    }
    // FTS5 shadow tables are named `<virtual>_data`, `_idx`, `_content` ...
    plain.retain(|name| {
        !virtual_names
            .iter()
            .any(|virtual_name| name.starts_with(&format!("{virtual_name}_")))
    });
    Ok(plain)
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
    let fresh_columns: HashSet<String> = columns(fresh, table).ok()?.into_iter().collect();
    if fresh_columns.is_empty() {
        return None;
    }
    let mut report = TableSalvage {
        table: table.to_owned(),
        copied: 0,
        rejected: 0,
        read_error: None,
    };
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
        "INSERT OR REPLACE INTO \"{}\" ({list}) VALUES ({marks})",
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
    use crate::storage::test_support::temp_dir;

    #[test]
    fn corrupt_recovery_never_overwrites_an_earlier_quarantine() {
        let dir = temp_dir("recovery-collision");
        let path = dir.path().join("data.db");

        let mut moved = Vec::new();
        for round in 0..3 {
            std::fs::write(&path, format!("round {round}")).expect("a damaged file");
            std::fs::write(dir.path().join("data.db-wal"), "log").expect("its wal");
            moved.push(move_aside(&path, 1_700_000_000_000).expect("move aside"));
        }

        let names: Vec<String> = moved
            .iter()
            .map(|p| p.file_name().expect("name").to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            names,
            [
                "data.db.corrupt-1700000000000",
                "data.db.corrupt-1700000000000-1",
                "data.db.corrupt-1700000000000-2",
            ]
        );
        for (round, backup) in moved.iter().enumerate() {
            assert_eq!(
                std::fs::read_to_string(backup).expect("kept"),
                format!("round {round}")
            );
            let wal = PathBuf::from(format!("{}-wal", backup.display()));
            assert_eq!(
                std::fs::read_to_string(wal).expect("its wal moved too"),
                "log"
            );
        }
        assert!(!path.exists());
    }
}
